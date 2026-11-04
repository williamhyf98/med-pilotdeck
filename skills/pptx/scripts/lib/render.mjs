import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDependencies } from './runtime.mjs';
import { officeRendererUrl, requestOfficeRenderer } from '../../../office-renderer-client.mjs';

function numericSort(a, b) {
  const aNum = Number(path.basename(a).match(/(\d+)/)?.[1] ?? 0);
  const bNum = Number(path.basename(b).match(/(\d+)/)?.[1] ?? 0);
  return aNum - bNum || a.localeCompare(b);
}

export function renderingAvailability() {
  const url = officeRendererUrl();
  return { available: Boolean(url), backend: 'office-renderer', url };
}

async function clearPriorSlides(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^slide-\d+\.png$/i.test(entry.name))
    .map((entry) => fs.unlink(path.join(outputDir, entry.name))));
}

export async function createMontage(imageFiles, outputPath, options = {}) {
  if (!imageFiles.length) throw new Error('Cannot create a montage without images');
  const { sharp } = loadDependencies();
  const columns = Math.max(1, Number(options.columns ?? Math.min(4, imageFiles.length)));
  const tileWidth = Number(options.tileWidth ?? 480);
  const gap = Number(options.gap ?? 18);
  const background = options.background ?? '#E9EDF2';
  const rendered = [];
  let tileHeight = 0;
  for (const file of imageFiles) {
    const item = await sharp(file).resize({ width: tileWidth }).png().toBuffer({ resolveWithObject: true });
    tileHeight = Math.max(tileHeight, item.info.height);
    rendered.push(item);
  }
  const rows = Math.ceil(rendered.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * tileHeight + (rows + 1) * gap;
  const composites = rendered.map((item, index) => ({
    input: item.data,
    left: gap + (index % columns) * (tileWidth + gap),
    top: gap + Math.floor(index / columns) * (tileHeight + gap),
  }));
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background } })
    .composite(composites)
    .png()
    .toFile(path.resolve(outputPath));
  return path.resolve(outputPath);
}

export async function renderPptx(inputPath, outputDir, options = {}) {
  const availability = renderingAvailability();
  if (!availability.available) throw new Error('Office Renderer is not configured');
  const input = path.resolve(inputPath);
  const output = path.resolve(outputDir);
  const dpi = Number(options.dpi ?? 144);
  await fs.mkdir(output, { recursive: true });
  await clearPriorSlides(output);
  const { JSZip } = loadDependencies();
  const format = path.extname(input).toLowerCase() === '.ppt' ? 'ppt' : 'pptx';
  const archive = await JSZip.loadAsync(await requestOfficeRenderer(
    input, `/v1/render/${format}?dpi=${dpi}&emit_pdf=${options.pdf ? 1 : 0}`,
    { magic: Buffer.from('PK') },
  ));
  const manifestEntry = archive.file('manifest.json');
  if (!manifestEntry) throw new Error('Office Renderer did not include a manifest');
  const manifest = JSON.parse(await manifestEntry.async('string'));
  const imageNames = manifest.images;
  if (!Array.isArray(imageNames)) throw new Error('Office Renderer returned an invalid image list');
  if (manifest.pages !== imageNames.length || !imageNames.length || imageNames.length > 200) {
    throw new Error('Office Renderer returned an invalid page count');
  }
  const staged = [];
  try {
    for (let index = 0; index < imageNames.length; index += 1) {
      if (imageNames[index] !== `page-${index + 1}.png`) throw new Error('Office Renderer returned an invalid page name');
      const entry = archive.file(imageNames[index]);
      if (!entry) throw new Error('Office Renderer omitted a page image');
      const destination = path.join(output, `slide-${index + 1}.png`);
      await fs.writeFile(destination, await entry.async('nodebuffer'));
      staged.push(destination);
    }
    const slides = (await fs.readdir(output))
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .map((name) => path.join(output, name))
      .sort(numericSort);
    if (!slides.length) throw new Error('Office Renderer did not produce any slide images');
    let montage = null;
    if (options.montage !== false) {
      montage = path.resolve(options.montage || path.join(output, 'montage.png'));
      await createMontage(slides, montage, { columns: options.columns });
    }
    let exportedPdf = null;
    if (options.pdf) {
      const pdfEntry = archive.file('result.pdf');
      if (!pdfEntry) throw new Error('Office Renderer omitted the requested PDF');
      exportedPdf = path.resolve(options.pdf);
      await fs.mkdir(path.dirname(exportedPdf), { recursive: true });
      await fs.writeFile(exportedPdf, await pdfEntry.async('nodebuffer'));
    }
    return {
      status: 'passed',
      baseline: 'office-renderer',
      engine: 'remote-office-renderer',
      rasterizer: 'server',
      input,
      output,
      dpi,
      slides,
      montage,
      pdf: exportedPdf,
      slideCount: slides.length,
      compatibilityNote: 'The Office Renderer runs LibreOffice on node12 as an automated baseline and may substitute fonts differently from Microsoft PowerPoint.',
    };
  } finally {
    if (staged.length !== imageNames.length) {
      await Promise.all(staged.map((file) => fs.rm(file, { force: true })));
    }
  }
}

export async function compareRenderedDirectories(referenceDir, candidateDir, options = {}) {
  const { sharp } = loadDependencies();
  const list = async (dir) => (await fs.readdir(path.resolve(dir)))
    .filter((name) => /^slide-\d+\.png$/i.test(name))
    .map((name) => path.join(path.resolve(dir), name))
    .sort(numericSort);
  const reference = await list(referenceDir);
  const candidate = await list(candidateDir);
  if (reference.length !== candidate.length) {
    return { status: 'failed', reason: 'slide_count_mismatch', referenceCount: reference.length, candidateCount: candidate.length, slides: [] };
  }
  const slides = [];
  for (let i = 0; i < reference.length; i += 1) {
    const ref = await sharp(reference[i]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cand = await sharp(candidate[i])
      .resize(ref.info.width, ref.info.height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let total = 0;
    for (let j = 0; j < ref.data.length; j += 1) total += Math.abs(ref.data[j] - cand.data[j]);
    const meanAbsoluteError = total / (ref.data.length * 255);
    slides.push({ slide: i + 1, meanAbsoluteError: Math.round(meanAbsoluteError * 1000000) / 1000000 });
  }
  const threshold = Number(options.threshold ?? 0.01);
  const maxDifference = Math.max(0, ...slides.map((item) => item.meanAbsoluteError));
  return {
    status: maxDifference <= threshold ? 'passed' : 'failed',
    threshold,
    maxDifference,
    slides,
  };
}
