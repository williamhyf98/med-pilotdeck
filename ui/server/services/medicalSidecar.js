const LOCAL_SIDECAR_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const MAX_CONCURRENT_REQUESTS = 16;

const SIDECAR_PATHS = Object.freeze({
  health: 'v1/health',
  corpora: 'v1/rag/corpora',
  attachments: 'v1/attachments/prepare',
  tables: 'v1/tables/prepare',
  tableOcrPrompt: 'v1/tables/ocr/prompt',
  tableOcrParse: 'v1/tables/ocr/parse',
  imaging: 'v1/imaging/prepare',
  volumeValidate: 'v1/imaging/volume/validate',
  volumePrepare: 'v1/imaging/volume/prepare',
  volumes: 'v1/imaging/volumes',
  galleryValidate: 'v1/imaging/gallery/validate',
  galleryDatasets: 'v1/imaging/gallery/datasets',
  m3dHealth: 'v1/m3d/health',
  m3dInfer: 'v1/m3d/infer',
  clinicalPrompt: 'v1/clinical/prompt',
  clinicalParse: 'v1/clinical/parse',
  translate: 'v1/clinical/translate',
});

export class MedicalCapabilityUnavailableError extends Error {
  constructor(capability, reason = 'not_configured') {
    super(`Medical capability "${capability}" is unavailable.`);
    this.name = 'MedicalCapabilityUnavailableError';
    this.code = 'MEDICAL_CAPABILITY_UNAVAILABLE';
    this.status = 503;
    this.capability = capability;
    this.reason = reason;
  }
}

export class MedicalSidecarError extends Error {
  constructor(code, status = 502) {
    super('The medical sidecar request failed.');
    this.name = 'MedicalSidecarError';
    this.code = code;
    this.status = status;
  }
}

export class MedicalSidecarAdapter {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.rawBaseUrl = options.baseUrl ?? process.env.PILOTDECK_MEDICAL_SIDECAR_URL ?? '';
    this.allowedPorts = options.allowedPorts
      ?? process.env.PILOTDECK_MEDICAL_SIDECAR_ALLOWED_PORTS
      ?? '';
    this.timeoutMs = normalizeTimeout(
      options.timeoutMs ?? process.env.PILOTDECK_MEDICAL_SIDECAR_TIMEOUT_MS,
    );
    this.maxConcurrentRequests = normalizeConcurrency(
      options.maxConcurrentRequests
      ?? process.env.PILOTDECK_MEDICAL_SIDECAR_MAX_CONCURRENT,
    );
    this.activeRequests = 0;
    this.baseUrl = null;
    this.configurationError = null;

    if (typeof this.rawBaseUrl === 'string' && this.rawBaseUrl.trim()) {
      try {
        this.baseUrl = normalizeMedicalSidecarBaseUrl(this.rawBaseUrl, this.allowedPorts);
      } catch {
        this.configurationError = 'invalid_local_url';
      }
    }
  }

  describe() {
    if (!this.rawBaseUrl || !String(this.rawBaseUrl).trim()) {
      return {
        configured: false,
        available: false,
        status: 'unavailable',
        reason: 'not_configured',
      };
    }
    if (!this.baseUrl) {
      return {
        configured: true,
        available: false,
        status: 'misconfigured',
        reason: this.configurationError || 'invalid_local_url',
      };
    }
    return {
      configured: true,
      available: null,
      status: 'not_probed',
      reason: null,
    };
  }

  async health(options = {}) {
    const description = this.describe();
    if (!this.baseUrl) return description;

    try {
      const body = await this.requestJson('sidecar.health', SIDECAR_PATHS.health, {
        method: 'GET',
        signal: options.signal,
      });
      return {
        configured: true,
        available: true,
        status: 'ok',
        reason: null,
        capabilities: normalizeAdvertisedCapabilities(body?.capabilities),
      };
    } catch (error) {
      return {
        configured: true,
        available: false,
        status: 'unreachable',
        reason: error?.code === 'MEDICAL_CAPABILITY_UNAVAILABLE'
          ? error.reason || 'not_supported'
          : 'request_failed',
      };
    }
  }

  listCorpora(options = {}) {
    return this.requestJson('rag.corpora', SIDECAR_PATHS.corpora, {
      method: 'GET',
      signal: options.signal,
    });
  }

  prepareAttachments(payload, options = {}) {
    return this.requestJson('attachments', SIDECAR_PATHS.attachments, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  prepareTable(payload, options = {}) {
    return this.requestJson('tables', SIDECAR_PATHS.tables, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  buildTableOcrPrompt(payload, options = {}) {
    return this.requestJson('tables.ocr', SIDECAR_PATHS.tableOcrPrompt, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  parseTableOcr(payload, options = {}) {
    return this.requestJson('tables.ocr', SIDECAR_PATHS.tableOcrParse, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  prepareImages(payload, options = {}) {
    return this.requestJson('imaging', SIDECAR_PATHS.imaging, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  validateVolume(payload, options = {}) {
    return this.requestJson('imaging.volume', SIDECAR_PATHS.volumeValidate, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  prepareVolume(payload, options = {}) {
    return this.requestJson('imaging.volume', SIDECAR_PATHS.volumePrepare, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  uploadVolume(payload, options = {}) {
    return this.requestJson('imaging.volume', SIDECAR_PATHS.volumes, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  listVolumes(options = {}) {
    return this.requestJson('imaging.volume', SIDECAR_PATHS.volumes, {
      method: 'GET',
      signal: options.signal,
    });
  }

  getVolume(volumeId, options = {}) {
    return this.requestJson(
      'imaging.volume',
      fixedSidecarPath(SIDECAR_PATHS.volumes, volumeId),
      { method: 'GET', signal: options.signal },
    );
  }

  deleteVolume(volumeId, options = {}) {
    return this.requestJson(
      'imaging.volume',
      fixedSidecarPath(SIDECAR_PATHS.volumes, volumeId),
      { method: 'DELETE', signal: options.signal },
    );
  }

  getVolumeSlice(volumeId, sliceIndex, axis = 'axial', options = {}) {
    return this.requestJson(
      'imaging.volume',
      fixedSidecarPath(
        SIDECAR_PATHS.volumes,
        volumeId,
        'slices',
        normalizeSidecarIndex(sliceIndex),
      ),
      { method: 'GET', signal: options.signal },
    );
  }

  validateGallery(payload, options = {}) {
    return this.requestJson('imaging.gallery', SIDECAR_PATHS.galleryValidate, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  listGalleryDatasets(options = {}) {
    return this.requestJson('imaging.gallery', SIDECAR_PATHS.galleryDatasets, {
      method: 'GET',
      signal: options.signal,
    });
  }

  listGalleryCases(datasetId, options = {}) {
    return this.requestJson(
      'imaging.gallery',
      fixedSidecarPath(SIDECAR_PATHS.galleryDatasets, datasetId, 'cases'),
      { method: 'GET', signal: options.signal },
    );
  }

  getGalleryCase(datasetId, caseId, options = {}) {
    return this.requestJson(
      'imaging.gallery',
      fixedSidecarPath(SIDECAR_PATHS.galleryDatasets, datasetId, 'cases', caseId),
      { method: 'GET', signal: options.signal },
    );
  }

  getGallerySlice(datasetId, caseId, sliceIndex, options = {}) {
    return this.requestJson(
      'imaging.gallery',
      fixedSidecarPath(
        SIDECAR_PATHS.galleryDatasets,
        datasetId,
        'cases',
        caseId,
        'slices',
        normalizeSidecarIndex(sliceIndex),
      ),
      { method: 'GET', signal: options.signal },
    );
  }

  getM3dHealth(options = {}) {
    return this.requestJson('m3d', SIDECAR_PATHS.m3dHealth, {
      method: 'GET',
      signal: options.signal,
    });
  }

  inferM3d(payload, options = {}) {
    return this.requestJson('m3d', SIDECAR_PATHS.m3dInfer, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  // -- Clinical workflow methods --

  buildClinicalPrompt(workflow, payload, options = {}) {
    return this.requestJson('clinical', SIDECAR_PATHS.clinicalPrompt, {
      method: 'POST',
      body: { workflow, ...payload },
      signal: options.signal,
    });
  }

  parseClinicalOutput(workflow, payload, options = {}) {
    return this.requestJson('clinical', SIDECAR_PATHS.clinicalParse, {
      method: 'POST',
      body: { workflow, ...payload },
      signal: options.signal,
    });
  }

  translateMedical(payload, options = {}) {
    return this.requestJson('clinical', SIDECAR_PATHS.translate, {
      method: 'POST',
      body: payload,
      signal: options.signal,
    });
  }

  async requestJson(capability, relativePath, options = {}) {
    this.assertConfigured(capability);
    if (typeof this.fetchImpl !== 'function') {
      throw new MedicalCapabilityUnavailableError(capability, 'fetch_unavailable');
    }
    if (this.activeRequests >= this.maxConcurrentRequests) {
      throw new MedicalSidecarError('MEDICAL_SIDECAR_BUSY', 429);
    }

    const requestUrl = new URL(relativePath, this.baseUrl);
    assertLocalSidecarUrl(requestUrl, this.allowedPorts);

    let serializedBody;
    if (options.body !== undefined) {
      serializedBody = JSON.stringify(options.body);
      if (Buffer.byteLength(serializedBody, 'utf8') > MAX_REQUEST_BYTES) {
        throw new MedicalSidecarError('MEDICAL_SIDECAR_REQUEST_TOO_LARGE', 413);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    const forwardAbort = () => controller.abort('client_aborted');
    if (options.signal) {
      if (options.signal.aborted) forwardAbort();
      else options.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    this.activeRequests += 1;
    try {
      const response = await this.fetchImpl(requestUrl, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(serializedBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(serializedBody ? { body: serializedBody } : {}),
        redirect: 'error',
        signal: controller.signal,
      });

      if (response.status === 404 || response.status === 405 || response.status === 501) {
        throw new MedicalCapabilityUnavailableError(capability, 'not_supported');
      }
      if (!response.ok) {
        throw new MedicalSidecarError('MEDICAL_SIDECAR_UPSTREAM_ERROR');
      }

      const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new MedicalSidecarError('MEDICAL_SIDECAR_INVALID_RESPONSE');
      }
    } catch (error) {
      if (
        error instanceof MedicalCapabilityUnavailableError
        || error instanceof MedicalSidecarError
      ) {
        throw error;
      }
      if (controller.signal.aborted) {
        const code = options.signal?.aborted
          ? 'MEDICAL_SIDECAR_REQUEST_ABORTED'
          : 'MEDICAL_SIDECAR_TIMEOUT';
        throw new MedicalSidecarError(code, options.signal?.aborted ? 499 : 504);
      }
      throw new MedicalSidecarError('MEDICAL_SIDECAR_UNREACHABLE', 503);
    } finally {
      this.activeRequests -= 1;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  assertConfigured(capability) {
    if (!this.rawBaseUrl || !String(this.rawBaseUrl).trim()) {
      throw new MedicalCapabilityUnavailableError(capability, 'not_configured');
    }
    if (!this.baseUrl) {
      throw new MedicalCapabilityUnavailableError(
        capability,
        this.configurationError || 'invalid_local_url',
      );
    }
  }
}

export function normalizeMedicalSidecarBaseUrl(value, allowedPorts = '') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('A medical sidecar URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('The medical sidecar URL is invalid.');
  }
  assertLocalSidecarUrl(parsed, allowedPorts);

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('The medical sidecar URL cannot contain credentials, query parameters, or a fragment.');
  }

  parsed.pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return parsed;
}

function assertLocalSidecarUrl(url, allowedPorts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('The medical sidecar must use HTTP or HTTPS.');
  }

  const hostname = String(url.hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!LOCAL_SIDECAR_HOSTS.has(hostname)) {
    throw new TypeError('The medical sidecar host is not allowlisted.');
  }

  const ports = normalizeAllowedPorts(allowedPorts);
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (ports.size > 0 && !ports.has(effectivePort)) {
    throw new TypeError('The medical sidecar port is not allowlisted.');
  }
}

function normalizeAllowedPorts(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(
    source
      .map((port) => String(port).trim())
      .filter((port) => /^(?:[1-9]\d{0,4})$/.test(port) && Number(port) <= 65535),
  );
}

function normalizeTimeout(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CONCURRENT_REQUESTS;
  return Math.min(parsed, MAX_CONCURRENT_REQUESTS);
}

function normalizeAdvertisedCapabilities(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    rag: source.rag === true || source.corpora === true,
    attachments: source.attachments === true,
    tables: source.tables === true,
    imaging: source.imaging === true || source.images === true,
    volume: source.volume === true || source.imaging === true,
    gallery: source.gallery === true || source.imaging === true,
    m3d: source.m3d === true,
  };
}

function fixedSidecarPath(base, ...segments) {
  const encoded = segments.map((segment) => encodeURIComponent(normalizeSidecarSegment(segment)));
  return `${base}/${encoded.join('/')}`;
}

function normalizeSidecarSegment(value) {
  const segment = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(segment)) {
    throw new MedicalSidecarError('MEDICAL_SIDECAR_IDENTIFIER_INVALID', 400);
  }
  return segment;
}

function normalizeSidecarIndex(value) {
  const index = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) {
    throw new MedicalSidecarError('MEDICAL_SIDECAR_INDEX_INVALID', 400);
  }
  return String(index);
}

async function readBoundedResponseText(response, maxBytes) {
  const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MedicalSidecarError('MEDICAL_SIDECAR_RESPONSE_TOO_LARGE');
  }

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        try {
          if (typeof response.body.cancel === 'function') await response.body.cancel();
          else if (typeof response.body.destroy === 'function') response.body.destroy();
        } catch {
          // The body can already be locked by the async iterator. The size
          // rejection below remains authoritative even if cancellation races.
        }
        throw new MedicalSidecarError('MEDICAL_SIDECAR_RESPONSE_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const text = typeof response.text === 'function' ? await response.text() : '';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new MedicalSidecarError('MEDICAL_SIDECAR_RESPONSE_TOO_LARGE');
  }
  return text;
}
