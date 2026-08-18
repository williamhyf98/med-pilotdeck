import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGalleryCase,
  getGallerySlice,
  getM3dHealth,
  listGalleryDatasets,
  listVolumes,
  loadImagingBackendStatus,
  uploadVolumeData,
} from './imagingApi';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: fetchMock,
}));

describe('imagingApi', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('keeps unreported health capabilities unknown instead of faking readiness', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      sidecar: { available: true },
      capabilities: {
        volume: { available: true },
        gallery: { available: false, reason: 'feature_disabled' },
      },
    }));

    await expect(loadImagingBackendStatus()).resolves.toEqual({
      sidecar: true,
      volume: true,
      gallery: false,
      m3d: null,
      reasons: {
        sidecar: undefined,
        volume: undefined,
        gallery: 'feature_disabled',
        m3d: undefined,
      },
    });
  });

  it('normalizes the real Volume list and TTL metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: {
        status: 'ready',
        storage: 'temporary',
        volumes: [{
          volume_id: 'vol-12345678',
          filename: 'synthetic.npy',
          extension: '.npy',
          original_shape: [2, 3, 4],
          preview_slices: 2,
          thumbnail_index: 1,
          source_slice_indices: [0, 1],
          byte_size: 128,
          expires_at: '2026-08-06T12:15:00Z',
          temporary: true,
          phi_persisted: false,
        }],
      },
    }));

    const collection = await listVolumes();

    expect(collection).toMatchObject({
      available: true,
      storage: 'temporary',
      volumes: [{
        volumeId: 'vol-12345678',
        originalShape: [2, 3, 4],
        expiresAt: '2026-08-06T12:15:00Z',
        temporary: true,
        phiPersisted: false,
      }],
    });
  });

  it('retries without a custom TTL only when the current proxy rejects that field', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: {
          code: 'MEDICAL_FIELD_UNSUPPORTED',
          message: 'Unsupported medical API field: ttlSeconds.',
        },
      }, 400))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'ready',
          volume: {
            volume_id: 'vol-12345678',
            filename: 'synthetic.npy',
            extension: '.npy',
            original_shape: [2, 2, 2],
            preview_slices: 2,
            thumbnail_index: 1,
            byte_size: 128,
          },
          retention: {
            temporary: true,
            phi_persisted: false,
            expires_at: '2026-08-06T12:15:00Z',
            ttl_seconds: 900,
          },
        },
      }, 201));

    const uploaded = await uploadVolumeData('synthetic.npy', 'AAAA', {
      maxSlices: 2,
      ttlSeconds: 300,
    });

    expect(uploaded.ttlOverrideAccepted).toBe(false);
    expect(uploaded.retention.ttlSeconds).toBe(900);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ ttlSeconds: 300 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('ttlSeconds');
  });

  it('browses Gallery datasets, cases, and re-encoded slices', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'ready',
          datasets: [{
            dataset_id: 'dataset-one',
            label: '合成数据集',
            available: true,
            n_cases: 1,
            version: 'v1',
            license_id: 'synthetic-only',
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'ready',
          case: {
            dataset: 'dataset-one',
            case_id: 'case-one',
            n_slices: 2,
            thumb_index: 1,
            modality: 'CT',
          },
          slices: [
            { index: 0, slice_id: 'case-one:0', diagnostic_grade: false },
            { index: 1, slice_id: 'case-one:1', diagnostic_grade: false },
          ],
          warnings: ['不用于诊断'],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'ready',
          dataset_id: 'dataset-one',
          case_id: 'case-one',
          index: 1,
          media_type: 'image/png',
          data: 'iVBORw0KGgo=',
          width: 1,
          height: 1,
          diagnostic_grade: false,
          warnings: ['不用于诊断'],
        },
      }));

    const datasets = await listGalleryDatasets();
    const detail = await getGalleryCase('dataset-one', 'case-one');
    const slice = await getGallerySlice('dataset-one', 'case-one', 1);

    expect(datasets.datasets[0]).toMatchObject({
      datasetId: 'dataset-one',
      caseCount: 1,
    });
    expect(detail.slices).toHaveLength(2);
    expect(slice).toMatchObject({
      index: 1,
      mediaType: 'image/png',
      diagnosticGrade: false,
    });
  });

  it('returns an honest M3D unavailable health document', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: {
        status: 'unavailable',
        available: false,
        reason: 'feature_disabled',
        feature_enabled: false,
      },
    }));

    await expect(getM3dHealth()).resolves.toEqual({
      available: false,
      status: 'unavailable',
      reason: 'feature_disabled',
      featureEnabled: false,
      timeoutSeconds: undefined,
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
