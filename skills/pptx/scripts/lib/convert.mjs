import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectPptx } from './ooxml.mjs';
import { compareRenderedDirectories, renderPptx, renderingAvailability } from './render.mjs';
import { requestOfficeRenderer } from '../../../office-renderer-client.mjs';

const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

async function writeJson(file, value) {
  const output = path.resolve(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

async function sha256File(file) {
  const buffer = await fs.readFile(file);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function detectPresentationFormat(inputPath) {
  const input = path.resolve(inputPath);
  const handle = await fs.open(input, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= OLE_MAGIC.length && header.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) return 'ppt';
    if (bytesRead >= 2 && header[0] === 0x50 && header[1] === 0x4B) {
      await inspectPptx(input);
      return 'pptx';
    }
    return 'unknown';
  } finally {
    await handle.close();
  }
}

export async function convertWithOfficeRenderer(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  const outputDir = path.resolve(options.outputDir);
  const format = String(options.format || '').toLocaleLowerCase();
  if (!((format === 'pptx' && path.extname(input).toLowerCase() === '.ppt')
    || (format === 'ppt' && path.extname(input).toLowerCase() === '.pptx'))) {
    throw new Error('Remote presentation conversion supports .ppt to .pptx and .pptx to .ppt');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `${path.parse(input).name}.${format}`);
  const converted = await requestOfficeRenderer(input, `/v1/convert/${format}`, {
    magic: format === 'pptx' ? Buffer.from('PK') : OLE_MAGIC,
  });
  await fs.writeFile(output, converted);
  return output;
}

async function atomicCopy(source, output, force) {
  const destination = path.resolve(output);
  const exists = await fs.stat(destination).then(() => true).catch(() => false);
  if (exists && !force) throw new Error(`Refusing to overwrite existing output without --force: ${destination}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const staging = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.pilotdeck-${process.pid}-${Date.now()}`,
  );
  try {
    await fs.copyFile(source, staging);
    if (exists) await fs.rm(destination, { force: true });
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { force: true }).catch(() => {});
  }
  return destination;
}

export async function convertLegacyPpt(inputPath, outputPath, options = {}) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const qaDir = path.resolve(options.qaDir || `${output}.conversion-qa`);
  const reportFile = path.join(qaDir, 'conversion.json');
  const report = {
    schemaVersion: 1,
    status: 'failed',
    source: { file: input, format: null, sha256: null, preserved: false },
    output: { file: null, format: 'pptx', sha256: null, slideCount: null },
    conversion: {
      engine: null,
      legacyInput: null,
      conversionRequired: null,
      targetFormat: 'pptx',
    },
    validation: null,
    warnings: [],
    errors: [],
    report: reportFile,
  };
  await fs.mkdir(qaDir, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-ppt-convert-'));
  try {
    if (path.extname(output).toLocaleLowerCase() !== '.pptx') {
      throw new Error('Legacy PowerPoint conversion output must use the .pptx extension');
    }
    if (input === output) throw new Error('Conversion must preserve the source and write to a distinct .pptx output');
    const availability = renderingAvailability();
    if (!availability.available) {
      throw new Error('Verified .ppt conversion requires Office Renderer');
    }
    report.conversion.engine = availability.backend;
    const sourceHashBefore = await sha256File(input);
    const format = await detectPresentationFormat(input);
    report.source.format = format;
    report.source.sha256 = sourceHashBefore;
    report.conversion.legacyInput = format === 'ppt';
    report.conversion.conversionRequired = format === 'ppt';
    if (format === 'unknown') throw new Error('Unsupported presentation format: expected a binary .ppt or OOXML .pptx file');

    let candidate;
    if (format === 'ppt') {
      candidate = await convertWithOfficeRenderer(input, {
        outputDir: path.join(workspace, 'converted'),
        format: 'pptx',
        filter: 'Impress MS PowerPoint 2007 XML',
      });
      report.warnings.push({
        code: 'legacy_features_require_target_viewer_review',
        message: 'Legacy animations, macros, OLE objects, WordArt, charts, media, and uncommon fonts are not guaranteed to convert losslessly.',
      });
    } else {
      candidate = path.join(workspace, 'converted', `${path.parse(input).name}.pptx`);
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.copyFile(input, candidate);
    }

    const candidateManifest = await inspectPptx(candidate);
    const sourceRender = await renderPptx(input, path.join(qaDir, 'source-slides'), {
      dpi: options.dpi ?? 120,
      montage: path.join(qaDir, 'source-montage.png'),
      pdf: path.join(qaDir, 'source.pdf'),
    });
    const convertedRender = await renderPptx(candidate, path.join(qaDir, 'converted-slides'), {
      dpi: options.dpi ?? 120,
      montage: path.join(qaDir, 'converted-montage.png'),
      pdf: path.join(qaDir, 'converted.pdf'),
    });
    const fidelity = await compareRenderedDirectories(sourceRender.output, convertedRender.output, {
      threshold: options.fidelityThreshold ?? 0.01,
    });
    report.validation = {
      status: 'passed',
      sourceSlideCount: sourceRender.slideCount,
      convertedSlideCount: candidateManifest.slideCount,
      renderedConvertedSlideCount: convertedRender.slideCount,
      fidelity,
      sourceRender,
      convertedRender,
    };
    if (sourceRender.slideCount !== candidateManifest.slideCount
      || convertedRender.slideCount !== candidateManifest.slideCount) {
      report.errors.push({
        code: 'slide_count_mismatch',
        message: `Conversion changed the slide count (${sourceRender.slideCount} source, ${candidateManifest.slideCount} converted)`,
      });
    }
    if (fidelity.status !== 'passed') {
      report.warnings.push({
        code: 'conversion_visual_difference',
        maxDifference: fidelity.maxDifference,
        threshold: fidelity.threshold,
        message: 'Converted pages differ from the Office Renderer baseline rendering of the source .ppt; inspect the paired PNGs.',
      });
    }
    const sourceHashAfter = await sha256File(input);
    report.source.preserved = sourceHashBefore === sourceHashAfter;
    if (!report.source.preserved) {
      report.errors.push({ code: 'source_changed', message: 'The source presentation changed during conversion' });
    }
    if (report.errors.length) {
      report.validation.status = 'failed';
      report.status = 'failed';
      await writeJson(reportFile, report);
      return report;
    }

    const sealed = await atomicCopy(candidate, output, Boolean(options.force));
    const sealedManifest = await inspectPptx(sealed);
    if (sealedManifest.sha256 !== candidateManifest.sha256) {
      report.errors.push({ code: 'sealed_hash_mismatch', message: 'The sealed .pptx does not match the verified conversion candidate' });
      report.status = 'failed';
      await fs.rm(sealed, { force: true });
      await writeJson(reportFile, report);
      return report;
    }
    report.output = {
      file: sealed,
      format: 'pptx',
      sha256: sealedManifest.sha256,
      bytes: sealedManifest.bytes,
      slideCount: sealedManifest.slideCount,
    };
    report.status = report.warnings.length ? 'passed_with_warnings' : 'passed';
    await writeJson(reportFile, report);
    return report;
  } catch (error) {
    report.errors.push({
      code: 'conversion_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    await writeJson(reportFile, report);
    return report;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
