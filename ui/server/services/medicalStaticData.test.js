import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MedicalStaticDataError,
  MedicalStaticDataReader,
} from './medicalStaticData.js';

const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('MedicalStaticDataReader allowlisted local assets', () => {
  it('reads and sanitizes a bounded demo index and case', async () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.demoRoot, 'index.json'), JSON.stringify({
      cases: [{
        id: 'case-01',
        file: 'case-01.json',
        preview_url: '/war_trauma/synthetic.png',
        internal_path: '/local_data/private/case-01.json',
        apiKey: 'must-not-leak',
      }],
    }));
    writeFileSync(path.join(fixture.demoRoot, 'case-01.json'), JSON.stringify({
      id: 'case-01',
      stage: 'field-triage',
      result: 'historical synthetic output',
      sourcePath: String.raw`C:\private\case.json`,
    }));

    const reader = new MedicalStaticDataReader({
      demoRoot: fixture.demoRoot,
      imageRoot: fixture.imageRoot,
    });
    expect(reader.describe()).toMatchObject({
      demoAvailable: true,
      imagesAvailable: true,
      historicalEvaluation: true,
    });
    const index = await reader.readDemoIndex();
    const medicalCase = await reader.readDemoCase('case-01');

    expect(index.cases[0]).toMatchObject({ id: 'case-01', file: 'case-01.json' });
    expect(index.cases[0].preview_url).toBe(
      '/api/medical/demo/images/synthetic.png',
    );
    expect(JSON.stringify(index)).not.toContain('local_data');
    expect(JSON.stringify(index)).not.toContain('must-not-leak');
    expect(medicalCase).toMatchObject({
      id: 'case-01',
      result: 'historical synthetic output',
    });
    expect(JSON.stringify(medicalCase)).not.toContain('private');
  });

  it('serves only signed image types and rejects traversal', async () => {
    const fixture = createFixture();
    writeFileSync(path.join(fixture.demoRoot, 'index.json'), '{"cases":[]}');
    writeFileSync(
      path.join(fixture.imageRoot, 'synthetic.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    );
    writeFileSync(path.join(fixture.imageRoot, 'fake.png'), Buffer.from('not-an-image'));
    const reader = new MedicalStaticDataReader({
      demoRoot: fixture.demoRoot,
      imageRoot: fixture.imageRoot,
    });

    const image = await reader.readTraumaImage('synthetic.png');
    expect(image.kind).toBe('binary');
    expect(image.contentType).toBe('image/png');
    await expect(reader.readTraumaImage('../outside.png')).rejects.toMatchObject({
      code: 'MEDICAL_STATIC_PATH_INVALID',
      status: 400,
    });
    await expect(reader.readTraumaImage('fake.png')).rejects.toMatchObject({
      code: 'MEDICAL_STATIC_DATA_INVALID',
      status: 422,
    });
    await expect(reader.readTraumaImage('script.svg')).rejects.toMatchObject({
      code: 'MEDICAL_STATIC_ASSET_UNSUPPORTED',
      status: 415,
    });
  });

  it('resolves the delivered compare-eval bundle path format', async () => {
    const fixture = createFixture();
    mkdirSync(path.join(fixture.demoRoot, 'cases'), { recursive: true });
    writeFileSync(path.join(fixture.demoRoot, 'index.json'), JSON.stringify({
      cases: [{
        id: 'case-02',
        bundle: '/data/compare_eval_demo10/cases/case-02.json',
      }],
    }));
    writeFileSync(
      path.join(fixture.demoRoot, 'cases', 'case-02.json'),
      JSON.stringify({ id: 'case-02', description: 'synthetic authorized case' }),
    );
    const reader = new MedicalStaticDataReader({
      demoRoot: fixture.demoRoot,
      imageRoot: fixture.imageRoot,
    });

    await expect(reader.readDemoCase('case-02')).resolves.toMatchObject({
      id: 'case-02',
      description: 'synthetic authorized case',
    });
  });

  it('fails honestly when the local delivery assets are absent', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pilotdeck-medical-empty-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const reader = new MedicalStaticDataReader({ dataRoot: directory });

    expect(reader.describe()).toMatchObject({
      configured: false,
      demoAvailable: false,
      imagesAvailable: false,
    });
    await expect(reader.readDemoIndex()).rejects.toBeInstanceOf(MedicalStaticDataError);
    await expect(reader.readDemoIndex()).rejects.toMatchObject({
      code: 'MEDICAL_DEMO_DATA_UNAVAILABLE',
      reason: 'assets_not_installed',
    });
  });
});

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pilotdeck-medical-static-'));
  const demoRoot = path.join(directory, 'compare_eval_demo10');
  const imageRoot = path.join(directory, 'war_trauma');
  mkdirSync(demoRoot, { recursive: true });
  mkdirSync(imageRoot, { recursive: true });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, demoRoot, imageRoot };
}
