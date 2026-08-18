import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDicomFile,
  loadTraumaDemoCase,
  reorderImages,
  streamTraumaAnalysis,
} from './traumaApi';
import type { OrderedTraumaImage } from './traumaApi';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

function image(id: string, index: number): OrderedTraumaImage {
  return {
    id,
    image_id: id,
    name: `${id}.jpg`,
    label: `图片 ${id}`,
    category: 'wound',
    index,
  };
}

describe('traumaApi', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('reorders images while preserving identity metadata and rebuilding indexes', () => {
    const result = reorderImages([image('a', 0), image('b', 1), image('c', 2)], 2, 0);

    expect(result.map(({ image_id, category, label, index }) => ({
      image_id,
      category,
      label,
      index,
    }))).toEqual([
      { image_id: 'c', category: 'wound', label: '图片 c', index: 0 },
      { image_id: 'a', category: 'wound', label: '图片 a', index: 1 },
      { image_id: 'b', category: 'wound', label: '图片 b', index: 2 },
    ]);
  });

  it('sends eval/plain mode and safely degrades DICOM without raw pixel data', async () => {
    authenticatedFetch.mockResolvedValue(new Response(''));
    const dicom = new File(['private-pixels'], 'scan.dcm', { type: 'application/dicom' });

    await streamTraumaAnalysis({
      stage: 'point-of-injury',
      description: '测试',
      mode: 'eval',
      images: [{
        ...image('dicom-1', 0),
        name: 'scan.dcm',
        file: dicom,
        dicom: true,
      }],
      onEvent: vi.fn(),
    });

    const options = authenticatedFetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(options.body));
    expect(payload.mode).toBe('eval');
    expect(payload.images[0]).toEqual(expect.objectContaining({
      image_id: 'dicom-1',
      category: 'wound',
      label: '图片 dicom-1',
      index: 0,
      dicom: true,
      preprocessing_required: true,
    }));
    expect(payload.images[0]).not.toHaveProperty('data');
    expect(isDicomFile(dicom)).toBe(true);
  });

  it('normalizes the delivered compare-eval stage bundle shape', async () => {
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({
      id: 'wse_0820',
      title: '合成授权案例',
      stageOrder: ['field_triage'],
      stages: {
        field_triage: {
          stageKey: 'field_triage',
          description: '阶段描述',
          images: {
            items: {
              injury: '/api/medical/demo/images/eval/wse_0820_00_injury.jpg',
              ecg: '/api/medical/demo/images/eval/wse_0820_01_ecg.png',
            },
          },
          referenceGt: '一、图像判读\n结果',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await loadTraumaDemoCase('wse_0820');
    expect(result.stage).toBe('field-triage');
    expect(result.description).toBe('阶段描述');
    expect(result.images.map(({ category }) => category)).toEqual(['wound', 'ecg']);
    expect(result.results?.imaging).toContain('结果');
    expect(result.historicalEvaluation).toBe(true);
  });

  it('loads allowlisted demo pixels before starting vision analysis', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(new Response(
        new TextEncoder().encode('synthetic-image'),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ))
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n'));

    await streamTraumaAnalysis({
      stage: 'point-of-injury',
      description: '测试',
      mode: 'eval',
      images: [{
        ...image('demo-1', 0),
        name: 'demo.png',
        demo: true,
        previewUrl: '/api/medical/demo/images/eval/demo.png',
      }],
      onEvent: vi.fn(),
    });

    expect(authenticatedFetch.mock.calls[0][0]).toBe(
      '/api/medical/demo/images/eval/demo.png',
    );
    const request = authenticatedFetch.mock.calls[1][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.images[0]).toEqual(expect.objectContaining({
      image_id: 'demo-1',
      demo: true,
      mimeType: 'image/png',
    }));
    expect(payload.images[0].data).toMatch(/^data:image\/png;base64,/u);
  });
});
