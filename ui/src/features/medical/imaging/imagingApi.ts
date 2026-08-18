import { authenticatedFetch } from '../../../utils/api';

type UnknownRecord = Record<string, unknown>;

export type CapabilityAvailability = boolean | null;

export type ImagingBackendStatus = {
  sidecar: CapabilityAvailability;
  volume: CapabilityAvailability;
  gallery: CapabilityAvailability;
  m3d: CapabilityAvailability;
  reasons: Partial<Record<'sidecar' | 'volume' | 'gallery' | 'm3d', string>>;
};

export type VolumeRecord = {
  volumeId: string;
  filename: string;
  extension: string;
  originalShape: number[];
  spacing: number[] | null;
  modality: string;
  previewSlices: number;
  thumbnailIndex: number;
  sourceSliceIndices: number[];
  valueRange: number[] | null;
  byteSize: number;
  createdAt?: string;
  expiresAt?: string;
  storage?: string;
  temporary: boolean;
  phiPersisted: boolean;
  diagnosticGrade: boolean;
};

export type VolumeCollection = {
  available: boolean;
  reason?: string;
  storage?: string;
  volumes: VolumeRecord[];
};

export type VolumeUploadResult = {
  volume: VolumeRecord;
  retention: {
    temporary: boolean;
    phiPersisted: boolean;
    expiresAt?: string;
    ttlSeconds?: number;
  };
  warnings: string[];
  ttlOverrideAccepted: boolean | null;
};

export type MedicalImageSlice = {
  index: number;
  sourceIndex: number;
  mediaType: string;
  data: string;
  width: number;
  height: number;
  diagnosticGrade: boolean;
  warnings: string[];
};

export type GalleryDataset = {
  datasetId: string;
  label: string;
  description: string;
  modality: string;
  available: boolean;
  caseCount: number | null;
  hasReportText: boolean;
  version: string;
  licenseId: string;
};

export type GalleryDatasetCollection = {
  available: boolean;
  reason?: string;
  datasets: GalleryDataset[];
};

export type GalleryCase = {
  datasetId: string;
  caseId: string;
  sliceCount: number;
  thumbnailIndex: number;
  modality: string;
  reportAvailable: boolean;
};

export type GalleryCaseCollection = {
  datasetId: string;
  cases: GalleryCase[];
  warnings: string[];
};

export type GalleryCaseDetail = GalleryCase & {
  slices: Array<{
    index: number;
    sliceId: string;
    diagnosticGrade: boolean;
  }>;
  warnings: string[];
};

export type M3dHealth = {
  available: boolean;
  status: string;
  reason?: string;
  featureEnabled: boolean;
  timeoutSeconds?: number;
};

export type M3dInference = {
  status: string;
  contractVersion?: string;
  task: string;
  result: unknown;
  generationOwner?: string;
  phiPersisted: boolean;
};

export type MetadataValidationResult = {
  status?: string;
  volume?: UnknownRecord;
  gallery?: UnknownRecord;
};

export class ImagingApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;
  readonly capability?: string;

  constructor(
    code: string,
    message: string,
    status = 500,
    options: { reason?: string; capability?: string } = {},
  ) {
    super(message);
    this.name = 'ImagingApiError';
    this.code = code;
    this.status = status;
    this.reason = options.reason;
    this.capability = options.capability;
  }
}

export async function loadImagingBackendStatus(
  signal?: AbortSignal,
): Promise<ImagingBackendStatus> {
  const body = await requestJson('/api/medical/health', {
    suppressServerErrorToast: true,
    signal,
  }, '影像能力状态加载失败');
  const capabilities = record(body.capabilities);
  const sidecar = record(body.sidecar);
  const volume = record(capabilities.volume);
  const gallery = record(capabilities.gallery);
  const m3d = record(capabilities.m3d);
  return {
    sidecar: availability(sidecar.available),
    volume: availability(volume.available),
    gallery: availability(gallery.available),
    m3d: availability(m3d.available),
    reasons: {
      sidecar: stringValue(sidecar.reason) || undefined,
      volume: stringValue(volume.reason) || undefined,
      gallery: stringValue(gallery.reason) || undefined,
      m3d: stringValue(m3d.reason) || undefined,
    },
  };
}

export async function listVolumes(signal?: AbortSignal): Promise<VolumeCollection> {
  const body = await requestJson('/api/medical/volumes', {
    suppressServerErrorToast: true,
    signal,
  }, 'Volume 列表加载失败');
  const result = resultRecord(body);
  const status = stringValue(result.status);
  if (status === 'unavailable' || result.available === false) {
    return {
      available: false,
      reason: stringValue(result.reason) || 'volume_unavailable',
      storage: optionalString(result.storage),
      volumes: [],
    };
  }
  return {
    available: true,
    storage: optionalString(result.storage),
    volumes: Array.isArray(result.volumes)
      ? result.volumes.flatMap((value) => {
        try {
          return [normalizeVolume(value)];
        } catch {
          return [];
        }
      })
      : [],
  };
}

export async function uploadVolume(
  file: File,
  options: { maxSlices: number; ttlSeconds?: number },
): Promise<VolumeUploadResult> {
  if (!isSupportedVolumeFile(file)) {
    throw new ImagingApiError(
      'MEDICAL_VOLUME_TYPE_UNSUPPORTED',
      'Volume 必须是 .npy、.nii 或 .nii.gz 文件。',
      415,
    );
  }
  if (file.size < 1 || file.size > 12 * 1024 * 1024) {
    throw new ImagingApiError(
      'MEDICAL_BODY_TOO_LARGE',
      'Volume 文件必须大于 0 B 且不超过 12 MB。',
      413,
    );
  }
  return uploadVolumeData(file.name, await fileToBase64(file), options);
}

export async function uploadVolumeData(
  name: string,
  data: string,
  options: { maxSlices: number; ttlSeconds?: number },
): Promise<VolumeUploadResult> {
  const basePayload = {
    name,
    data,
    maxSlices: options.maxSlices,
  };
  let ttlOverrideAccepted: boolean | null = options.ttlSeconds === undefined ? null : true;
  let body: UnknownRecord;
  try {
    body = await requestJson('/api/medical/volume/upload', {
      method: 'POST',
      suppressServerErrorToast: true,
      body: JSON.stringify({
        ...basePayload,
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      }),
    }, 'Volume 上传失败');
  } catch (error) {
    if (
      options.ttlSeconds === undefined
      || !(error instanceof ImagingApiError)
      || error.code !== 'MEDICAL_FIELD_UNSUPPORTED'
    ) {
      throw error;
    }
    ttlOverrideAccepted = false;
    body = await requestJson('/api/medical/volume/upload', {
      method: 'POST',
      suppressServerErrorToast: true,
      body: JSON.stringify(basePayload),
    }, 'Volume 上传失败');
  }

  const result = resultRecord(body);
  if (stringValue(result.status) === 'unavailable') {
    throw new ImagingApiError(
      'MEDICAL_CAPABILITY_UNAVAILABLE',
      'Volume 存储当前不可用。',
      503,
      { reason: stringValue(result.reason) || 'volume_unavailable', capability: 'imaging.volume' },
    );
  }
  const retention = record(result.retention);
  const volume = normalizeVolume(result.volume);
  return {
    volume: {
      ...volume,
      expiresAt: optionalString(retention.expires_at ?? retention.expiresAt)
        || volume.expiresAt,
      temporary: booleanValue(retention.temporary, volume.temporary),
      phiPersisted: booleanValue(
        retention.phi_persisted ?? retention.phiPersisted,
        volume.phiPersisted,
      ),
    },
    retention: {
      temporary: booleanValue(retention.temporary, volume.temporary),
      phiPersisted: booleanValue(
        retention.phi_persisted ?? retention.phiPersisted,
        volume.phiPersisted,
      ),
      expiresAt: optionalString(retention.expires_at ?? retention.expiresAt),
      ttlSeconds: optionalPositiveInteger(retention.ttl_seconds ?? retention.ttlSeconds),
    },
    warnings: stringList(result.warnings),
    ttlOverrideAccepted,
  };
}

export async function getVolume(
  volumeId: string,
  signal?: AbortSignal,
): Promise<VolumeRecord> {
  const body = await requestJson(`/api/medical/volumes/${encodeURIComponent(volumeId)}`, {
    suppressServerErrorToast: true,
    signal,
  }, 'Volume 详情加载失败');
  const result = resultRecord(body);
  return normalizeVolume(result.volume ?? result);
}

export async function getVolumeSlice(
  volumeId: string,
  index: number,
  signal?: AbortSignal,
): Promise<MedicalImageSlice> {
  const body = await requestJson(
    `/api/medical/volumes/${encodeURIComponent(volumeId)}/slices/${index}?axis=axial`,
    { suppressServerErrorToast: true, signal },
    'Volume 切片加载失败',
  );
  const result = resultRecord(body);
  return normalizeSlice(result, record(result.slice));
}

export async function deleteVolume(volumeId: string): Promise<void> {
  await requestJson(`/api/medical/volumes/${encodeURIComponent(volumeId)}`, {
    method: 'DELETE',
    suppressServerErrorToast: true,
  }, 'Volume 删除失败');
}

export async function listGalleryDatasets(
  signal?: AbortSignal,
): Promise<GalleryDatasetCollection> {
  const body = await requestJson('/api/medical/gallery/datasets', {
    suppressServerErrorToast: true,
    signal,
  }, 'Gallery 数据集加载失败');
  const result = resultRecord(body);
  if (stringValue(result.status) === 'unavailable' || result.available === false) {
    return {
      available: false,
      reason: stringValue(result.reason) || 'gallery_unavailable',
      datasets: [],
    };
  }
  return {
    available: true,
    datasets: Array.isArray(result.datasets)
      ? result.datasets.flatMap((value) => {
        const dataset = normalizeDataset(value);
        return dataset ? [dataset] : [];
      })
      : [],
  };
}

export async function listGalleryCases(
  datasetId: string,
  signal?: AbortSignal,
): Promise<GalleryCaseCollection> {
  const body = await requestJson(
    `/api/medical/gallery/datasets/${encodeURIComponent(datasetId)}/cases`,
    { suppressServerErrorToast: true, signal },
    'Gallery 病例列表加载失败',
  );
  const result = resultRecord(body);
  return {
    datasetId: stringValue(result.dataset_id ?? result.datasetId) || datasetId,
    cases: Array.isArray(result.cases)
      ? result.cases.flatMap((value) => {
        const medicalCase = normalizeGalleryCase(value, datasetId);
        return medicalCase ? [medicalCase] : [];
      })
      : [],
    warnings: stringList(result.warnings),
  };
}

export async function getGalleryCase(
  datasetId: string,
  caseId: string,
  signal?: AbortSignal,
): Promise<GalleryCaseDetail> {
  const body = await requestJson(
    `/api/medical/gallery/datasets/${encodeURIComponent(datasetId)}/cases/${encodeURIComponent(caseId)}`,
    { suppressServerErrorToast: true, signal },
    'Gallery 病例详情加载失败',
  );
  const result = resultRecord(body);
  const medicalCase = normalizeGalleryCase(result.case ?? result, datasetId);
  if (!medicalCase) {
    throw new ImagingApiError(
      'MEDICAL_GALLERY_RESPONSE_INVALID',
      'Gallery 病例详情格式无效。',
      502,
    );
  }
  const slices = Array.isArray(result.slices)
    ? result.slices.flatMap((value) => {
      const item = record(value);
      const index = nonNegativeInteger(item.index, -1);
      if (index < 0) return [];
      return [{
        index,
        sliceId: stringValue(item.slice_id ?? item.sliceId) || `${medicalCase.caseId}:${index}`,
        diagnosticGrade: item.diagnostic_grade === true || item.diagnosticGrade === true,
      }];
    })
    : Array.from({ length: medicalCase.sliceCount }, (_, index) => ({
      index,
      sliceId: `${medicalCase.caseId}:${index}`,
      diagnosticGrade: false,
    }));
  return {
    ...medicalCase,
    slices,
    warnings: stringList(result.warnings),
  };
}

export async function getGallerySlice(
  datasetId: string,
  caseId: string,
  index: number,
  signal?: AbortSignal,
): Promise<MedicalImageSlice> {
  const body = await requestJson(
    `/api/medical/gallery/datasets/${encodeURIComponent(datasetId)}/cases/${encodeURIComponent(caseId)}/slices/${index}`,
    { suppressServerErrorToast: true, signal },
    'Gallery 切片加载失败',
  );
  const result = resultRecord(body);
  return normalizeSlice(result, result);
}

export async function getM3dHealth(signal?: AbortSignal): Promise<M3dHealth> {
  const body = await requestJson('/api/medical/m3d/health', {
    suppressServerErrorToast: true,
    signal,
  }, 'M3D 状态加载失败');
  const result = resultRecord(body);
  return {
    available: result.available === true,
    status: stringValue(result.status) || (result.available === true ? 'ready' : 'unavailable'),
    reason: stringValue(result.reason) || undefined,
    featureEnabled: result.feature_enabled === true || result.featureEnabled === true,
    timeoutSeconds: optionalPositiveNumber(result.timeout_seconds ?? result.timeoutSeconds),
  };
}

export async function inferM3d(
  task: string,
  input: UnknownRecord,
): Promise<M3dInference> {
  const body = await requestJson('/api/medical/m3d/infer', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ task, input }),
  }, 'M3D 推理失败');
  const result = resultRecord(body);
  return {
    status: stringValue(result.status) || 'unknown',
    contractVersion: optionalString(result.contract_version ?? result.contractVersion),
    task: stringValue(result.task) || task,
    result: result.result ?? null,
    generationOwner: optionalString(result.generation_owner ?? result.generationOwner),
    phiPersisted: result.phi_persisted === true || result.phiPersisted === true,
  };
}

export async function validateVolumeMetadata(
  metadata: UnknownRecord,
): Promise<MetadataValidationResult> {
  const body = await requestJson('/api/medical/sidecar/imaging/volume/validate', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ metadata }),
  }, 'Volume metadata 校验失败');
  return record(body.result);
}

export async function validateGalleryMetadata(
  kind: 'dataset' | 'case',
  metadata: UnknownRecord,
): Promise<MetadataValidationResult> {
  const body = await requestJson('/api/medical/sidecar/imaging/gallery/validate', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ kind, metadata }),
  }, 'Gallery metadata 校验失败');
  return record(body.result);
}

export function isSupportedVolumeFile(file: Pick<File, 'name'>): boolean {
  return /\.(?:npy|nii(?:\.gz)?)$/iu.test(file.name);
}

export function isUnavailableError(error: unknown): error is ImagingApiError {
  return error instanceof ImagingApiError
    && (
      error.code === 'MEDICAL_CAPABILITY_UNAVAILABLE'
      || error.code === 'MEDICAL_ROUTE_NOT_FOUND'
      || error.status === 503
    );
}

function normalizeVolume(value: unknown): VolumeRecord {
  const volume = record(value);
  const volumeId = stringValue(volume.volume_id ?? volume.volumeId ?? volume.vid ?? volume.id);
  if (!volumeId) {
    throw new ImagingApiError(
      'MEDICAL_VOLUME_RESPONSE_INVALID',
      'Volume 响应缺少 volume_id。',
      502,
    );
  }
  const originalShape = numberList(volume.original_shape ?? volume.originalShape ?? volume.orig_shape);
  const sourceSliceIndices = integerList(
    volume.source_slice_indices ?? volume.sourceSliceIndices,
  );
  return {
    volumeId,
    filename: stringValue(volume.filename ?? volume.name) || volumeId,
    extension: stringValue(volume.extension ?? volume.ext),
    originalShape,
    spacing: nullableNumberList(volume.spacing),
    modality: stringValue(volume.modality) || 'unknown',
    previewSlices: nonNegativeInteger(
      volume.preview_slices ?? volume.previewSlices ?? volume.n_slices,
    ),
    thumbnailIndex: nonNegativeInteger(
      volume.thumbnail_index ?? volume.thumbnailIndex ?? volume.thumb_index,
    ),
    sourceSliceIndices,
    valueRange: nullableNumberList(volume.value_range ?? volume.valueRange),
    byteSize: nonNegativeInteger(volume.byte_size ?? volume.byteSize),
    createdAt: optionalString(volume.created_at ?? volume.createdAt),
    expiresAt: optionalString(volume.expires_at ?? volume.expiresAt),
    storage: optionalString(volume.storage),
    temporary: volume.temporary === true,
    phiPersisted: volume.phi_persisted === true || volume.phiPersisted === true,
    diagnosticGrade: volume.diagnostic_grade === true || volume.diagnosticGrade === true,
  };
}

function normalizeDataset(value: unknown): GalleryDataset | null {
  const dataset = record(value);
  const datasetId = stringValue(dataset.dataset_id ?? dataset.datasetId ?? dataset.id);
  if (!datasetId) return null;
  const rawCaseCount = dataset.case_count ?? dataset.caseCount ?? dataset.n_cases;
  return {
    datasetId,
    label: stringValue(dataset.label) || datasetId,
    description: stringValue(dataset.description ?? dataset.desc),
    modality: stringValue(dataset.modality) || 'unknown',
    available: dataset.available === true,
    caseCount: rawCaseCount === null || rawCaseCount === undefined
      ? null
      : nonNegativeInteger(rawCaseCount),
    hasReportText: dataset.has_report_text === true
      || dataset.hasReportText === true
      || dataset.has_text === true,
    version: stringValue(dataset.version),
    licenseId: stringValue(dataset.license_id ?? dataset.licenseId),
  };
}

function normalizeGalleryCase(value: unknown, fallbackDatasetId: string): GalleryCase | null {
  const medicalCase = record(value);
  const caseId = stringValue(medicalCase.case_id ?? medicalCase.caseId ?? medicalCase.id);
  if (!caseId) return null;
  return {
    datasetId: stringValue(
      medicalCase.dataset_id ?? medicalCase.datasetId ?? medicalCase.dataset,
    ) || fallbackDatasetId,
    caseId,
    sliceCount: nonNegativeInteger(
      medicalCase.slice_count ?? medicalCase.sliceCount ?? medicalCase.n_slices,
    ),
    thumbnailIndex: nonNegativeInteger(
      medicalCase.thumbnail_index ?? medicalCase.thumbnailIndex ?? medicalCase.thumb_index,
    ),
    modality: stringValue(medicalCase.modality) || 'unknown',
    reportAvailable: medicalCase.report_available === true
      || medicalCase.reportAvailable === true
      || medicalCase.has_text === true,
  };
}

function normalizeSlice(root: UnknownRecord, value: UnknownRecord): MedicalImageSlice {
  const mediaType = stringValue(value.media_type ?? value.mediaType);
  const data = stringValue(value.data);
  if (!mediaType.startsWith('image/') || !data) {
    throw new ImagingApiError(
      'MEDICAL_SLICE_RESPONSE_INVALID',
      '切片响应不包含可显示的图片。',
      502,
    );
  }
  return {
    index: nonNegativeInteger(value.index),
    sourceIndex: nonNegativeInteger(value.source_index ?? value.sourceIndex ?? value.index),
    mediaType,
    data,
    width: nonNegativeInteger(value.width),
    height: nonNegativeInteger(value.height),
    diagnosticGrade: value.diagnostic_grade === true || value.diagnosticGrade === true,
    warnings: uniqueStrings([
      ...stringList(root.warnings),
      ...stringList(value.warnings),
    ]),
  };
}

async function requestJson(
  url: string,
  options: RequestInit & { suppressServerErrorToast?: boolean },
  fallback: string,
): Promise<UnknownRecord> {
  const response = await authenticatedFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, body, fallback);
  if (!isRecord(body)) {
    throw new ImagingApiError(
      'MEDICAL_RESPONSE_INVALID',
      `${fallback}：后端返回了无效 JSON。`,
      502,
    );
  }
  return body;
}

function responseError(
  response: Response,
  bodyValue: unknown,
  fallback: string,
): ImagingApiError {
  const body = record(bodyValue);
  const error = record(body.error);
  return new ImagingApiError(
    stringValue(error.code) || 'MEDICAL_REQUEST_FAILED',
    stringValue(error.message) || `${fallback}（HTTP ${response.status}）。`,
    response.status,
    {
      reason: stringValue(error.reason) || undefined,
      capability: stringValue(error.capability) || undefined,
    },
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.onerror = () => reject(new ImagingApiError(
      'MEDICAL_VOLUME_READ_FAILED',
      `无法读取 ${file.name}。`,
      422,
    ));
    reader.readAsDataURL(file);
  });
}

function resultRecord(body: UnknownRecord): UnknownRecord {
  return isRecord(body.result) ? body.result : body;
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function availability(value: unknown): CapabilityAvailability {
  return value === true ? true : value === false ? false : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter(Number.isFinite)
    : [];
}

function integerList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isSafeInteger(item) && item >= 0)
    : [];
}

function nullableNumberList(value: unknown): number[] | null {
  return value === null || value === undefined ? null : numberList(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
