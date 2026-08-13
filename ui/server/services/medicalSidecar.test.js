import { describe, expect, it, vi } from 'vitest';

import {
  MedicalCapabilityUnavailableError,
  MedicalSidecarAdapter,
  normalizeMedicalSidecarBaseUrl,
} from './medicalSidecar.js';

describe('MedicalSidecarAdapter localhost policy', () => {
  it('accepts only explicit loopback hosts and allowlisted ports', () => {
    expect(normalizeMedicalSidecarBaseUrl(
      'http://127.0.0.1:8765/medical',
      '8765,9000',
    ).toString()).toBe('http://127.0.0.1:8765/medical/');
    expect(normalizeMedicalSidecarBaseUrl(
      'http://[::1]:8765',
      ['8765'],
    ).toString()).toBe('http://[::1]:8765/');

    expect(() => normalizeMedicalSidecarBaseUrl('https://sidecar.example/v1')).toThrow();
    expect(() => normalizeMedicalSidecarBaseUrl('http://127.0.0.2:8765')).toThrow();
    expect(() => normalizeMedicalSidecarBaseUrl('file:///tmp/sidecar')).toThrow();
    expect(() => normalizeMedicalSidecarBaseUrl(
      'http://localhost:9999',
      '8765',
    )).toThrow();
    expect(() => normalizeMedicalSidecarBaseUrl(
      'http://user:password@localhost:8765',
      '8765',
    )).toThrow();
  });

  it('returns capability unavailable without making a request when unconfigured', async () => {
    const fetchImpl = vi.fn();
    const adapter = new MedicalSidecarAdapter({ baseUrl: '', fetchImpl });

    await expect(adapter.listCorpora()).rejects.toMatchObject({
      name: 'MedicalCapabilityUnavailableError',
      code: 'MEDICAL_CAPABILITY_UNAVAILABLE',
      capability: 'rag.corpora',
      reason: 'not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a remote configured URL as unavailable rather than proxying it', async () => {
    const fetchImpl = vi.fn();
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'https://remote.example/v1',
      fetchImpl,
    });

    expect(adapter.describe()).toMatchObject({
      configured: true,
      available: false,
      status: 'misconfigured',
      reason: 'invalid_local_url',
    });
    await expect(adapter.prepareImages({ images: [] })).rejects.toBeInstanceOf(
      MedicalCapabilityUnavailableError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses fixed sidecar paths and does not forward caller headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      corpora: [{ id: 'local', name: 'Local corpus' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://localhost:8765/medical/',
      allowedPorts: '8765',
      fetchImpl,
    });

    const result = await adapter.listCorpora();

    expect(result.corpora).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://localhost:8765/medical/v1/rag/corpora');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('maps an unsupported sidecar endpoint to capability unavailable', async () => {
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: vi.fn(async () => new Response('{}', { status: 404 })),
    });

    await expect(adapter.prepareTable({ table: {} })).rejects.toMatchObject({
      code: 'MEDICAL_CAPABILITY_UNAVAILABLE',
      capability: 'tables',
      reason: 'not_supported',
    });
  });

  it('builds only fixed encoded volume and gallery paths', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765/medical/',
      fetchImpl,
    });

    await adapter.getVolume('volume-one');
    await adapter.getGalleryCase('dataset-one', 'case-one');

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/imaging/volumes/volume-one',
    );
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/imaging/gallery/datasets/dataset-one/cases/case-one',
    );
    expect(() => adapter.getVolume('../private')).toThrowError(expect.objectContaining({
      code: 'MEDICAL_SIDECAR_IDENTIFIER_INVALID',
      status: 400,
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses fixed M3D health and inference paths', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765/medical/',
      fetchImpl,
    });

    await adapter.getM3dHealth();
    await adapter.inferM3d({ task: 'describe', input: { volume_id: 'volume-one' } });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/m3d/health',
    );
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/m3d/infer',
    );
  });

  it('uses fixed table OCR prompt and parse paths', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765/medical/',
      fetchImpl,
    });

    await adapter.buildTableOcrPrompt({
      images: [{ image_id: 'table-ocr-image-1', page: 0 }],
      language: 'zh-CN',
      instructions: '',
    });
    await adapter.parseTableOcr({
      modelOutput: '{"columns":["A"],"rows":[]}',
      includeRaw: false,
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/tables/ocr/prompt',
    );
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'http://127.0.0.1:8765/medical/v1/tables/ocr/parse',
    );
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(init.headers).not.toHaveProperty('Authorization');
    }
  });

  it('rejects excess concurrent requests before another fetch starts', async () => {
    let release;
    const firstResponse = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(() => firstResponse);
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765',
      maxConcurrentRequests: 1,
      fetchImpl,
    });

    const first = adapter.listCorpora();
    await expect(adapter.prepareTable({ table: {} })).rejects.toMatchObject({
      code: 'MEDICAL_SIDECAR_BUSY',
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(new Response('{"corpora":[]}', { status: 200 }));
    await expect(first).resolves.toEqual({ corpora: [] });
  });

  it('aborts a stalled request at the configured timeout', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    const adapter = new MedicalSidecarAdapter({
      baseUrl: 'http://127.0.0.1:8765',
      timeoutMs: 10,
      fetchImpl,
    });

    await expect(adapter.listCorpora()).rejects.toMatchObject({
      code: 'MEDICAL_SIDECAR_TIMEOUT',
      status: 504,
    });
  });
});
