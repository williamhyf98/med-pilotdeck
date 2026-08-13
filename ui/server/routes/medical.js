import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

import {
  abortViaGateway,
  createTrustedGatewayTurnOptions,
  runChatViaGateway,
} from '../pilotdeck-bridge.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';
import {
  buildDialoguePrompt,
  buildTraumaPrompt,
  listMedicalProfiles,
  listMedicalTaskModes,
  medicalModelsFromConfig,
  resolveMedicalProfile,
  resolveMedicalTaskMode,
  resolveTraumaStage,
} from '../services/medicalCatalog.js';
import { getMedicalPresetInfo, isFeatureEnabled } from '../services/medicalPreset.js';
import {
  MedicalCapabilityUnavailableError,
  MedicalSidecarAdapter,
  MedicalSidecarError,
} from '../services/medicalSidecar.js';
import { createStreamGuard } from '../services/medicalSafetyRails.js';
import { runTraumaPipeline } from '../services/medicalTraumaPipeline.js';
import { MedicalStaticDataError, MedicalStaticDataReader } from '../services/medicalStaticData.js';
import { MedicalStore, MedicalStoreError } from '../services/medicalStore.js';
import { createMedicalResourceRouter } from './medicalResources.js';

export const MEDICAL_API_VERSION = 1;

const MAX_MEDICAL_BODY_BYTES = 16 * 1024 * 1024;
const MAX_DIALOGUE_BODY_BYTES = 256 * 1024;
const MAX_STOP_BODY_BYTES = 16 * 1024;
const MAX_TABLE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;
const MAX_CONVERSATION_MESSAGES = 50;
const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CONCURRENT_MEDICAL_RUNS = 8;
const MAX_CONCURRENT_MEDICAL_RUNS_PER_OWNER = 2;
const MEDICAL_GENERATION_TIMEOUT_MS = 120_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_MEDICAL_UPLOAD_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_MIME_TYPES,
  'application/dicom',
]);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const GATEWAY_MEDICAL_PROFILES = Object.freeze({
  'general-clinical': 'medical-general',
  'emergency-medicine': 'medical-general',
  'trauma-team': 'war-trauma-assessment',
});

const SAFE_GATEWAY_ERRORS = Object.freeze({
  gateway_unavailable: {
    code: 'MEDICAL_GATEWAY_UNAVAILABLE',
    message: 'PilotDeck generation is temporarily unavailable.',
    recoverable: true,
  },
  session_busy: {
    code: 'MEDICAL_SESSION_BUSY',
    message: 'This medical session already has an active generation.',
    recoverable: true,
  },
  model_request_failed: {
    code: 'MEDICAL_MODEL_REQUEST_FAILED',
    message: 'The configured model could not complete the request.',
    recoverable: true,
  },
  content_filter_stop: {
    code: 'MEDICAL_CONTENT_FILTERED',
    message: 'The configured model stopped this response because of its safety policy.',
    recoverable: false,
  },
  turn_timeout: {
    code: 'MEDICAL_GENERATION_TIMEOUT',
    message: 'Medical generation timed out.',
    recoverable: true,
  },
  turn_aborted: {
    code: 'MEDICAL_GENERATION_STOPPED',
    message: 'Medical generation was stopped.',
    recoverable: true,
  },
});

export class MedicalRequestError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'MedicalRequestError';
    this.code = code;
    this.status = status;
    this.safeMessage = message;
    this.details = details;
  }
}

export function createMedicalRouter(dependencies = {}) {
  const router = express.Router();
  const runChat = dependencies.runChat || runChatViaGateway;
  const abortChat = dependencies.abortChat || abortViaGateway;
  const readConfig = dependencies.readConfig || readPilotDeckConfigFile;
  const sidecar = dependencies.sidecar || new MedicalSidecarAdapter();
  const staticData = dependencies.staticData || new MedicalStaticDataReader(
    dependencies.staticDataOptions,
  );
  const legacyEvalEnabled = dependencies.legacyEvalEnabled
    ?? envFlag(process.env.PILOTDECK_MEDICAL_ENABLE_LEGACY_EVAL);
  const activeSessions = new Map();
  let ownedStore = null;
  const getStore = () => {
    if (dependencies.store) return dependencies.store;
    if (!ownedStore) ownedStore = new MedicalStore(dependencies.storeOptions);
    return ownedStore;
  };

  router.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    req.medicalRequestId = requestId;
    res.setHeader('X-Medical-Request-Id', requestId);
    res.once('finish', () => {
      try {
        getStore().appendAudit({
          owner: ownerKey(req),
          requestId,
          action: `${req.method} ${req.baseUrl}${req.route?.path || '/unknown'}`,
          outcome: res.statusCode < 400
            ? 'success'
            : res.statusCode < 500
              ? 'rejected'
              : 'error',
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          metadata: req.medicalAudit,
        });
      } catch {
        // Audit persistence must not change the already completed response.
      }
    });
    next();
  });

  router.use((req, _res, next) => {
    if (BODY_METHODS.has(req.method) && !isJsonRequest(req)) {
      return next(new MedicalRequestError(
        'MEDICAL_JSON_REQUIRED',
        'Medical API request bodies must use application/json.',
        415,
      ));
    }

    const declaredLength = Number.parseInt(req.get('content-length') || '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDICAL_BODY_BYTES) {
      return next(bodyTooLargeError());
    }
    return next();
  });

  router.use(express.json({
    limit: MAX_MEDICAL_BODY_BYTES,
    strict: true,
    type: (req) => isJsonRequest(req),
  }));

  router.get('/health', asyncHandler(async (req, res) => {
    const sidecarHealth = typeof sidecar.health === 'function'
      ? await withRequestAbort(req, (signal) => sidecar.health({ signal }))
      : normalizeSidecarDescription(sidecar);
    let storage;
    try {
      storage = getStore().status();
    } catch {
      storage = { available: false, persistent: false };
    }
    const demo = staticData.describe();
    const advertised = sidecarHealth?.capabilities || {};
    const sidecarConfigured = sidecarHealth?.configured === true;
    const sidecarReachable = sidecarHealth?.available === true;
    const visionModel = configuredVisionModelStatus(readConfig);
    const tableOcrAvailable = sidecarReachable
      && advertised.tables === true
      && visionModel.available;
    const tableOcrReason = !sidecarReachable
      ? sidecarHealth?.reason || 'sidecar_unavailable'
      : advertised.tables !== true
        ? 'not_supported'
        : visionModel.reason;

    const preset = getMedicalPresetInfo();

    res.json({
      status: (sidecarConfigured && !sidecarReachable) || !storage.available
        ? 'degraded'
        : 'ok',
      service: 'pilotdeck-medical-api',
      apiVersion: MEDICAL_API_VERSION,
      timestamp: new Date().toISOString(),
      generation: {
        adapter: 'pilotdeck-bridge',
        gateway: 'PilotDeck',
        status: 'not_probed',
      },
      branding: preset.branding,
      features: preset.features,
      security: preset.security,
      deployment: preset.deployment,
      presetId: preset.presetId,
      customer: preset.customer,
      knowledge: preset.knowledge,
      capabilities: {
        dialogue: capability(true, 'pilotdeck-gateway'),
        traumaAnalysis: capability(true, 'pilotdeck-gateway'),
        ragCorpora: capability(sidecarReachable && advertised.rag === true, 'medical-sidecar', sidecarHealth),
        attachments: capability(sidecarReachable && advertised.attachments === true, 'medical-sidecar', sidecarHealth),
        tables: capability(sidecarReachable && advertised.tables === true, 'medical-sidecar', sidecarHealth),
        tableOcrGeneration: {
          available: tableOcrAvailable,
          adapter: 'pilotdeck-gateway+medical-sidecar',
          ...(!tableOcrAvailable && tableOcrReason ? { reason: tableOcrReason } : {}),
        },
        imagingPreprocess: capability(sidecarReachable && advertised.imaging === true, 'medical-sidecar', sidecarHealth),
        volume: capability(
          sidecarReachable && (advertised.volume === true || advertised.imaging === true),
          'medical-sidecar',
          sidecarHealth,
        ),
        gallery: capability(
          sidecarReachable && (advertised.gallery === true || advertised.imaging === true),
          'medical-sidecar',
          sidecarHealth,
        ),
        m3d: capability(
          sidecarReachable && advertised.m3d === true,
          'medical-sidecar',
          sidecarHealth,
        ),
        artifacts: capability(storage.available, 'medical-sqlite'),
        cases: capability(storage.available, 'medical-sqlite'),
        tableDocuments: capability(storage.available, 'medical-sqlite'),
        audit: capability(storage.available, 'medical-sqlite'),
        demoData: capability(demo.demoAvailable, 'local-static-assets'),
        legacyEvalRerun: capability(
          legacyEvalEnabled,
          'pilotdeck-gateway',
        ),
      },
      sidecar: {
        configured: sidecarConfigured,
        available: sidecarReachable,
        status: sidecarHealth?.status || 'unavailable',
        ...(sidecarHealth?.reason ? { reason: sidecarHealth.reason } : {}),
      },
      storage,
      demo,
    });
  }));

  router.get('/profiles', (_req, res) => {
    const preset = getMedicalPresetInfo();
    res.json({
      apiVersion: MEDICAL_API_VERSION,
      profiles: listMedicalProfiles(),
      presetDefaults: preset.profiles ?? null,
      presetId: preset.presetId,
    });
  });

  router.get('/task-modes', (_req, res) => {
    const preset = getMedicalPresetInfo();
    res.json({
      apiVersion: MEDICAL_API_VERSION,
      taskModes: listMedicalTaskModes(),
      presetId: preset.presetId,
    });
  });

  router.get('/models', (_req, res) => {
    let record;
    try {
      record = readConfig();
    } catch {
      return sendMedicalError(res, new MedicalRequestError(
        'MEDICAL_CONFIG_UNAVAILABLE',
        'PilotDeck model configuration is unavailable.',
        503,
      ));
    }

    if (record?.parseError) {
      return sendMedicalError(res, new MedicalRequestError(
        'MEDICAL_CONFIG_INVALID',
        'PilotDeck model configuration is invalid.',
        503,
      ));
    }

    const catalog = medicalModelsFromConfig(record?.config || {});
    return res.json({
      apiVersion: MEDICAL_API_VERSION,
      ...catalog,
      selection: 'pilotdeck-routing',
    });
  });

  router.get('/rag/corpora', asyncHandler(async (req, res) => {
    const result = await withRequestAbort(req, (signal) => sidecar.listCorpora({ signal }));
    res.json({
      apiVersion: MEDICAL_API_VERSION,
      corpora: normalizeCorpora(result),
    });
  }));

  router.post('/dialogue/chat', routeBodyLimit(MAX_DIALOGUE_BODY_BYTES), asyncHandler(async (req, res) => {
    const input = parseDialogueRequest(req.body);
    const owner = ownerKey(req);
    assertMedicalSessionOwner(input.sessionId, owner);
    assertSessionAvailable(input.sessionId, activeSessions);
    assertMedicalCapacity(activeSessions, owner);
    const prompt = buildDialoguePrompt(input);

    await streamGatewayGeneration({
      req,
      res,
      prompt,
      sessionId: input.sessionId,
      runChat,
      abortChat,
      activeSessions,
      owner,
      task: 'dialogue',
      model: input.model,
      gatewayProfile: GATEWAY_MEDICAL_PROFILES[input.profile.id],
    });
  }));

  router.post('/dialogue/stop', routeBodyLimit(MAX_STOP_BODY_BYTES), asyncHandler(async (req, res) => {
    await stopMedicalGeneration({
      req,
      res,
      abortChat,
      activeSessions,
      expectedTask: 'dialogue',
    });
  }));

  router.post('/med-trauma/analyze', routeBodyLimit(MAX_MEDICAL_BODY_BYTES), asyncHandler(async (req, res) => {
    const input = parseTraumaRequest(req.body);
    const owner = ownerKey(req);
    assertMedicalSessionOwner(input.sessionId, owner);
    assertSessionAvailable(input.sessionId, activeSessions);
    assertMedicalCapacity(activeSessions, owner);
    const modelInputImages = input.images.filter((image) => image.data);
    const modelImages = modelInputImages.length > 0
      ? await withRequestAbort(
        req,
        (signal) => prepareSafeModelImages(sidecar, modelInputImages, signal),
      )
      : [];
    const prompt = buildTraumaPrompt({
      ...input,
      imageCount: modelImages.length,
    });

    // Use two-phase pipeline by default; fall back to single-pass via env flag
    const useTwoPhase = process.env.PILOTDECK_MEDICAL_TWO_PHASE_TRAUMA !== 'false';

    if (useTwoPhase) {
      await runTraumaPipeline({
        req,
        res,
        prompt,
        sessionId: input.sessionId,
        images: modelImages,
        stage: input.stage,
        promptStyle: input.promptStyle,
        imageMetadata: input.imageMetadata,
        runChat,
        abortChat,
        activeSessions,
        owner,
        model: input.model,
      });
    } else {
      await streamGatewayGeneration({
        req,
        res,
        prompt,
        sessionId: input.sessionId,
        images: modelImages,
        runChat,
        abortChat,
        activeSessions,
        owner,
        task: 'trauma-analysis',
        model: input.model,
        gatewayProfile: 'war-trauma-assessment',
        publicMetadata: {
          stage: input.stage.id,
          promptStyle: input.promptStyle,
          images: input.imageMetadata,
        },
      });
    }
  }));

  router.post('/med-trauma/stop', routeBodyLimit(MAX_STOP_BODY_BYTES), asyncHandler(async (req, res) => {
    await stopMedicalGeneration({
      req,
      res,
      abortChat,
      activeSessions,
      expectedTask: 'trauma-analysis',
    });
  }));

  router.post('/sidecar/attachments/prepare', routeBodyLimit(MAX_MEDICAL_BODY_BYTES), asyncHandler(async (req, res) => {
    const payload = parseAttachmentPreparationRequest(req.body);
    const result = await withRequestAbort(
      req,
      (signal) => sidecar.prepareAttachments(payload, { signal }),
    );
    res.json({ apiVersion: MEDICAL_API_VERSION, result });
  }));

  router.post('/sidecar/tables/prepare', routeBodyLimit(MAX_TABLE_BODY_BYTES), asyncHandler(async (req, res) => {
    const payload = parseTablePreparationRequest(req.body);
    const result = await withRequestAbort(
      req,
      (signal) => sidecar.prepareTable(payload, { signal }),
    );
    res.json({ apiVersion: MEDICAL_API_VERSION, result });
  }));

  router.post('/sidecar/imaging/prepare', routeBodyLimit(MAX_MEDICAL_BODY_BYTES), asyncHandler(async (req, res) => {
    const body = requireObjectBody(req.body);
    rejectSystemPromptFields(body);
    assertOnlyKeys(body, ['images']);
    const images = validateImages(body.images, { required: true });
    const result = await withRequestAbort(
      req,
      (signal) => sidecar.prepareImages({ images }, { signal }),
    );
    res.json({ apiVersion: MEDICAL_API_VERSION, result });
  }));

  router.post('/sidecar/imaging/volume/validate', routeBodyLimit(MAX_TABLE_BODY_BYTES), asyncHandler(async (req, res) => {
    const body = requireObjectBody(req.body);
    rejectSystemPromptFields(body);
    assertOnlyKeys(body, ['metadata']);
    if (!isRecord(body.metadata)) {
      throw new MedicalRequestError(
        'MEDICAL_VOLUME_METADATA_INVALID',
        'metadata must be a volume metadata object.',
      );
    }
    const result = await withRequestAbort(
      req,
      (signal) => sidecar.validateVolume({ metadata: body.metadata }, { signal }),
    );
    res.json({ apiVersion: MEDICAL_API_VERSION, result });
  }));

  router.post('/sidecar/imaging/gallery/validate', routeBodyLimit(MAX_TABLE_BODY_BYTES), asyncHandler(async (req, res) => {
    const body = requireObjectBody(req.body);
    rejectSystemPromptFields(body);
    assertOnlyKeys(body, ['kind', 'metadata']);
    if ((body.kind !== 'dataset' && body.kind !== 'case') || !isRecord(body.metadata)) {
      throw new MedicalRequestError(
        'MEDICAL_GALLERY_METADATA_INVALID',
        'kind must be dataset or case and metadata must be an object.',
      );
    }
    const result = await withRequestAbort(
      req,
      (signal) => sidecar.validateGallery(
        { kind: body.kind, metadata: body.metadata },
        { signal },
      ),
    );
    res.json({ apiVersion: MEDICAL_API_VERSION, result });
  }));

  router.use(createMedicalResourceRouter({
    apiVersion: MEDICAL_API_VERSION,
    createError: (code, message, status, details) => (
      new MedicalRequestError(code, message, status, details)
    ),
    getStore,
    readConfig,
    sidecar,
    staticData,
    operationTimeoutMs: dependencies.operationTimeoutMs,
    legacyEvalEnabled,
    runGatewayTask: (input) => runManagedGatewayTask({
      ...input,
      runChat,
      abortChat,
      activeSessions,
    }),
  }));

  router.use((_req, res) => {
    sendMedicalError(res, new MedicalRequestError(
      'MEDICAL_ROUTE_NOT_FOUND',
      'Medical API route not found.',
      404,
    ));
  });

  router.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large' || error?.status === 413) {
      return sendMedicalError(res, bodyTooLargeError());
    }
    if (error instanceof SyntaxError && error?.status === 400 && 'body' in error) {
      return sendMedicalError(res, new MedicalRequestError(
        'MEDICAL_INVALID_JSON',
        'The medical API request body is not valid JSON.',
        400,
      ));
    }
    return sendMedicalError(res, error);
  });

  return router;
}

export function normalizedMessageToMedicalEvents(message, context = {}) {
  if (!message || typeof message !== 'object') return [];
  const sessionId = safeSessionId(message.sessionId || context.sessionId) || null;
  const base = {
    version: MEDICAL_API_VERSION,
    requestId: context.requestId || null,
    sessionId,
  };

  switch (message.kind) {
    case 'session_created': {
      const createdSessionId = safeSessionId(
        message.newSessionId || message.sessionKey || message.sessionId,
      );
      if (!createdSessionId) return [];
      return [{
        event: 'session',
        data: {
          ...base,
          type: 'session',
          sessionId: createdSessionId,
        },
      }];
    }
    case 'thinking_start':
    case 'assistant_thinking_start':
      return [{
        event: 'thinking',
        data: {
          ...base,
          type: 'thinking',
          text: '<think>',
        },
      }];
    case 'thinking_delta':
    case 'assistant_thinking_delta': {
      const thinkingText = typeof message.content === 'string'
        ? message.content
        : typeof message.text === 'string'
          ? message.text
          : '';
      if (!thinkingText) return [];
      return [{
        event: 'thinking',
        data: {
          ...base,
          type: 'thinking',
          text: thinkingText,
        },
      }];
    }
    case 'thinking_end':
    case 'assistant_thinking_end':
      return [{
        event: 'thinking',
        data: {
          ...base,
          type: 'thinking',
          text: '</think>',
        },
      }];
    case 'stream_delta':
    case 'text': {
      const text = typeof message.content === 'string'
        ? message.content
        : typeof message.text === 'string'
          ? message.text
          : '';
      if (!text) return [];
      return [{
        event: 'delta',
        data: {
          ...base,
          type: 'delta',
          text,
        },
      }];
    }
    case 'status': {
      if (message.code === 'turn_aborted' || message.text === 'turn_aborted') {
        return [{
          event: 'done',
          data: {
            ...base,
            type: 'done',
            reason: 'stopped',
          },
        }];
      }
      const phase = normalizeMedicalStatusPhase(message.text);
      if (!phase) return [];
      return [{
        event: 'status',
        data: {
          ...base,
          type: 'status',
          phase,
          ...(phase === 'context' ? { context: safeTokenBudget(message.tokenBudget) } : {}),
        },
      }];
    }
    case 'complete':
      return [{
        event: 'done',
        data: {
          ...base,
          type: 'done',
          reason: safeFinishReason(message.finishReason),
          usage: safeUsage(message.usage),
        },
      }];
    case 'interrupted':
      return [{
        event: 'done',
        data: {
          ...base,
          type: 'done',
          reason: 'stopped',
        },
      }];
    case 'permission_request':
    case 'interactive_prompt':
      return [{
        event: 'error',
        data: {
          ...base,
          type: 'error',
          code: 'MEDICAL_INTERACTION_UNAVAILABLE',
          message: 'This medical client cannot complete an interactive Gateway request.',
          recoverable: true,
        },
      }];
    case 'error': {
      const safeError = safeGatewayError(message.code);
      return [{
        event: 'error',
        data: {
          ...base,
          type: 'error',
          ...safeError,
        },
      }];
    }
    default:
      return [];
  }
}

export function formatMedicalSseEvent(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

async function streamGatewayGeneration({
  req,
  res,
  prompt,
  sessionId: requestedSessionId,
  images,
  runChat,
  abortChat,
  activeSessions,
  owner,
  task,
  model,
  gatewayProfile,
  publicMetadata,
}) {
  const requestId = randomUUID();
  req.medicalAudit = {
    task,
    model: model || 'pilotdeck-routing',
    profile: gatewayProfile || 'pilotdeck-routing',
    streaming: true,
  };
  let sessionId = requestedSessionId
    || `${medicalSessionPrefixForOwner(owner)}${randomUUID()}`;
  let closed = false;
  let finished = false;
  let terminal = false;

  const runRecord = { requestId, owner, task };
  const registeredSessionIds = new Set();
  const registerSession = (value) => {
    if (!value) return;
    activeSessions.set(value, runRecord);
    registeredSessionIds.add(value);
  };
  registerSession(sessionId);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  writeMedicalEvent(res, {
    event: 'ready',
    data: {
      version: MEDICAL_API_VERSION,
      type: 'ready',
      requestId,
      sessionId,
      task,
      ...(publicMetadata ? { metadata: publicMetadata } : {}),
    },
  });
  writeMedicalEvent(res, {
    event: 'session',
    data: {
      version: MEDICAL_API_VERSION,
      type: 'session',
      requestId,
      sessionId,
    },
  });

  const abortCurrentRun = () => {
    if (!sessionId) return;
    void Promise.resolve(abortChat(sessionId, 'pilotdeck')).catch(() => false);
  };

  res.on('close', () => {
    closed = true;
    if (!finished) abortCurrentRun();
  });

  // ---- Safety rails: repetition detection ----
  let repetitionBuffer = '';
  let repetitionLastNgram = '';
  let repetitionCount = 0;
  const REPETITION_NGRAM = 80;
  const REPETITION_MAX = 6;

  const checkRepetition = (text) => {
    repetitionBuffer += text;
    if (repetitionBuffer.length < 500) return true; // not enough data yet
    const currentNgram = repetitionBuffer.slice(-REPETITION_NGRAM);
    if (currentNgram.length < REPETITION_NGRAM) return true;
    if (currentNgram === repetitionLastNgram) {
      repetitionCount += 1;
    } else {
      repetitionLastNgram = currentNgram;
      repetitionCount = 0;
    }
    return repetitionCount < REPETITION_MAX;
  };

  // ---- Weak answer tracking ----
  let accumulatedOutput = '';
  let retryAttempt = 0;
  let retryRequested = false;
  const MAX_RETRIES = 1;
  const WEAK_ANSWER_MIN_CHARS = 80;

  const checkWeakAnswer = (text) => {
    accumulatedOutput += text;
  };

  const isWeakComplete = () => {
    const trimmed = accumulatedOutput.trim();
    if (trimmed.length >= WEAK_ANSWER_MIN_CHARS) return false;
    if (/^\s*[\{\[]/.test(trimmed) && /[\}\]]\s*$/.test(trimmed)) {
      try { JSON.parse(trimmed); return false; } catch { /* not valid JSON */ }
    }
    return true;
  };

  const writer = {
    send(message) {
      if (closed || terminal || !message || typeof message !== 'object') return;

      // Handle custom SSE events from safety guard
      if (message.kind === 'custom_sse' && message.rawEvent) {
        writeMedicalEvent(res, message.rawEvent);
        if (message.rawEvent.event === 'error') {
          terminal = true;
        }
        return;
      }

      if (message.kind === 'session_created') {
        const createdSessionId = safeSessionId(
          message.newSessionId || message.sessionKey || message.sessionId,
        );
        if (createdSessionId && createdSessionId === sessionId) {
          sessionId = createdSessionId;
          registerSession(createdSessionId);
        } else if (createdSessionId) {
          writeMedicalEvent(res, {
            event: 'error',
            data: {
              version: MEDICAL_API_VERSION,
              type: 'error',
              requestId,
              sessionId,
              code: 'MEDICAL_SESSION_MISMATCH',
              message: 'PilotDeck returned an unexpected medical session.',
              recoverable: true,
            },
          });
          terminal = true;
          abortCurrentRun();
          return;
        }
      }

      // ---- Safety rails checks ----
      // Repetition detection on text deltas
      if (message.kind === 'stream_delta' || message.kind === 'text') {
        const text = typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : '';
        if (text && !checkRepetition(text)) {
          writeMedicalEvent(res, {
            event: 'error',
            data: {
              version: MEDICAL_API_VERSION,
              type: 'error',
              requestId,
              sessionId,
              code: 'MEDICAL_REPETITION_LOOP',
              message: 'Generation was stopped because it entered a repetitive loop.',
              recoverable: false,
            },
          });
          terminal = true;
          abortCurrentRun();
          return;
        }
        if (text) checkWeakAnswer(text);
      }

      // Weak-answer retry on complete — defer to outer retry loop
      if (message.kind === 'complete' && retryAttempt < MAX_RETRIES && isWeakComplete()) {
        accumulatedOutput = '';
        repetitionBuffer = '';
        repetitionLastNgram = '';
        repetitionCount = 0;
        // Signal the outer loop to retry with augmented prompt
        retryRequested = true;
        return;
      }

      const events = normalizedMessageToMedicalEvents(message, { requestId, sessionId });
      for (const event of events) {
        writeMedicalEvent(res, event);
        if (event.event === 'done' || event.event === 'error') {
          terminal = true;
        }
      }

      if (message.kind === 'permission_request' || message.kind === 'interactive_prompt') {
        abortCurrentRun();
      }
    },
  };

  try {
    let retryPrompt = prompt;
    retryAttempt = 0;

    while (retryAttempt <= MAX_RETRIES) {
      retryRequested = false;
      terminal = false;

      await runChat(
        retryPrompt,
        createTrustedGatewayTurnOptions({
          sessionId,
          runMode: 'ask',
          permissionMode: 'default',
          disableTools: true,
          maxTurns: 1,
          timeoutMs: MEDICAL_GENERATION_TIMEOUT_MS,
          ...(model ? { model } : {}),
          ...(gatewayProfile ? { profile: gatewayProfile } : {}),
          turnOverrides: {
            metadata: {
              surface: 'medical',
              task,
              requestId,
              ...(retryAttempt > 0 ? { retry: 'weak-answer', retryCount: retryAttempt } : {}),
            },
          },
          ...(images?.length ? { images } : {}),
        }),
        writer,
        'pilotdeck',
      );

      if (retryRequested && retryAttempt < MAX_RETRIES) {
        retryAttempt += 1;
        retryPrompt = `${prompt}\n\n[系统提示：上轮输出过短，请重新生成更详细完整的回答。]`;
        // Reset safety state for the retry
        repetitionBuffer = '';
        repetitionLastNgram = '';
        repetitionCount = 0;
        accumulatedOutput = '';
        if (closed) break;
        continue;
      }
      break;
    }

    if (!closed && !terminal) {
      writeMedicalEvent(res, {
        event: 'error',
        data: {
          version: MEDICAL_API_VERSION,
          type: 'error',
          requestId,
          sessionId,
          code: 'MEDICAL_STREAM_INCOMPLETE',
          message: 'Medical generation ended without a completion event.',
          recoverable: true,
        },
      });
      terminal = true;
    }
  } catch {
    if (!closed && !terminal) {
      writeMedicalEvent(res, {
        event: 'error',
        data: {
          version: MEDICAL_API_VERSION,
          type: 'error',
          requestId,
          sessionId,
          code: 'MEDICAL_GENERATION_FAILED',
          message: 'Medical generation failed.',
          recoverable: true,
        },
      });
      terminal = true;
    }
  } finally {
    finished = true;
    for (const registeredSessionId of registeredSessionIds) {
      if (activeSessions.get(registeredSessionId)?.requestId === requestId) {
        activeSessions.delete(registeredSessionId);
      }
    }
    if (!closed && !res.writableEnded) res.end();
  }
}

async function runManagedGatewayTask({
  req,
  owner,
  task,
  prompt,
  model,
  gatewayProfile,
  sessionId: requestedSessionId,
  images,
  timeoutMs = MEDICAL_GENERATION_TIMEOUT_MS,
  runChat,
  abortChat,
  activeSessions,
}) {
  req.medicalAudit = {
    task,
    model: model || 'pilotdeck-routing',
    profile: gatewayProfile || 'pilotdeck-routing',
    streaming: false,
    ...(images?.length ? { imageCount: images.length } : {}),
  };
  assertMedicalSessionOwner(requestedSessionId, owner);
  assertSessionAvailable(requestedSessionId, activeSessions);
  assertMedicalCapacity(activeSessions, owner);

  const requestId = randomUUID();
  const sessionId = requestedSessionId
    || `${medicalSessionPrefixForOwner(owner)}${randomUUID()}`;
  const runRecord = { requestId, owner, task };
  activeSessions.set(sessionId, runRecord);

  let completed = false;
  let output = '';
  let terminalError = null;
  let rejectControl;
  const control = new Promise((_resolve, reject) => {
    rejectControl = reject;
  });
  const stop = (error, reason) => {
    if (terminalError) return;
    terminalError = error;
    rejectControl(error);
    void Promise.resolve(abortChat(sessionId, 'pilotdeck', reason)).catch(() => false);
  };
  const clientAbort = () => stop(
    new MedicalRequestError(
      'MEDICAL_REQUEST_ABORTED',
      'Medical request was aborted.',
      499,
    ),
    'client_aborted',
  );
  req.once('aborted', clientAbort);
  const boundedTimeout = Number.isSafeInteger(timeoutMs)
    ? Math.max(1_000, Math.min(timeoutMs, MEDICAL_GENERATION_TIMEOUT_MS))
    : MEDICAL_GENERATION_TIMEOUT_MS;
  const timer = setTimeout(() => stop(
    new MedicalRequestError(
      'MEDICAL_GENERATION_TIMEOUT',
      'Medical generation timed out.',
      504,
    ),
    'timeout',
  ), boundedTimeout);

  const writer = {
    send(message) {
      if (terminalError || !message || typeof message !== 'object') return;
      if (message.kind === 'session_created') {
        const created = safeSessionId(
          message.newSessionId || message.sessionKey || message.sessionId,
        );
        if (created && created !== sessionId) {
          stop(
            new MedicalRequestError(
              'MEDICAL_SESSION_MISMATCH',
              'PilotDeck returned an unexpected medical session.',
              502,
            ),
            'session_mismatch',
          );
        }
        return;
      }
      if (message.kind === 'stream_delta' || message.kind === 'text') {
        const chunk = typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : '';
        if (chunk) {
          output += chunk;
          if (output.length > MAX_TEXT_CHARS * 2) {
            stop(
              new MedicalRequestError(
                'MEDICAL_GENERATION_TOO_LARGE',
                'Medical generation exceeded the response limit.',
                502,
              ),
              'response_too_large',
            );
          }
        }
        return;
      }
      if (message.kind === 'complete') {
        completed = true;
        return;
      }
      if (message.kind === 'permission_request' || message.kind === 'interactive_prompt') {
        stop(
          new MedicalRequestError(
            'MEDICAL_INTERACTION_UNAVAILABLE',
            'This medical client cannot complete an interactive Gateway request.',
            409,
          ),
          'interaction_unavailable',
        );
        return;
      }
      if (
        message.kind === 'interrupted'
        || (message.kind === 'status'
          && (message.code === 'turn_aborted' || message.text === 'turn_aborted'))
      ) {
        stop(
          new MedicalRequestError(
            'MEDICAL_GENERATION_STOPPED',
            'Medical generation was stopped.',
            409,
          ),
          'turn_aborted',
        );
        return;
      }
      if (message.kind === 'error') {
        const safe = safeGatewayError(message.code);
        stop(
          new MedicalRequestError(
            safe.code,
            safe.message,
            gatewayErrorStatus(safe.code),
          ),
          'gateway_error',
        );
      }
    },
  };

  try {
    const execution = runChat(
      prompt,
      createTrustedGatewayTurnOptions({
        sessionId,
        runMode: 'ask',
        permissionMode: 'default',
        disableTools: true,
        maxTurns: 1,
        timeoutMs: boundedTimeout,
        ...(model ? { model } : {}),
        ...(gatewayProfile ? { profile: gatewayProfile } : {}),
        turnOverrides: {
          metadata: {
            surface: 'medical',
            task,
            requestId,
          },
        },
        ...(images?.length ? { images } : {}),
      }),
      writer,
      'pilotdeck',
    );
    await Promise.race([execution, control]);
    if (terminalError) throw terminalError;
    if (!completed) {
      throw new MedicalRequestError(
        'MEDICAL_STREAM_INCOMPLETE',
        'Medical generation ended without a completion event.',
        502,
      );
    }
    if (task !== 'model-ping' && !output.trim()) {
      throw new MedicalRequestError(
        'MEDICAL_EMPTY_RESPONSE',
        'Medical generation returned an empty response.',
        502,
      );
    }
    return {
      requestId,
      sessionId,
      text: output.trim(),
    };
  } catch (error) {
    if (error instanceof MedicalRequestError) throw error;
    throw new MedicalRequestError(
      'MEDICAL_GENERATION_FAILED',
      'Medical generation failed.',
      502,
    );
  } finally {
    clearTimeout(timer);
    req.removeListener('aborted', clientAbort);
    if (activeSessions.get(sessionId)?.requestId === requestId) {
      activeSessions.delete(sessionId);
    }
  }
}

async function stopMedicalGeneration({
  req,
  res,
  abortChat,
  activeSessions,
  expectedTask,
}) {
  const body = requireObjectBody(req.body);
  rejectSystemPromptFields(body);
  assertOnlyKeys(body, ['sessionId']);
  const sessionId = requireSessionId(body.sessionId);
  const active = activeSessions.get(sessionId);
  const owner = ownerKey(req);
  assertMedicalSessionOwner(sessionId, owner);

  if (active && active.owner !== owner) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_FORBIDDEN',
      'This medical session is owned by another authenticated user.',
      403,
    );
  }
  if (active && active.task !== expectedTask) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_TASK_MISMATCH',
      'The active medical session belongs to a different task mode.',
      409,
    );
  }

  let stopped = false;
  try {
    stopped = await abortChat(sessionId, 'pilotdeck');
  } catch {
    throw new MedicalRequestError(
      'MEDICAL_GATEWAY_UNAVAILABLE',
      'PilotDeck generation is temporarily unavailable.',
      503,
    );
  }
  if (!stopped) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_NOT_ACTIVE',
      'No active medical generation was found for this session.',
      404,
    );
  }

  res.json({
    ok: true,
    apiVersion: MEDICAL_API_VERSION,
    status: 'stop_requested',
    sessionId,
  });
}

function parseDialogueRequest(value) {
  const body = requireObjectBody(value);
  rejectSystemPromptFields(body);
  assertOnlyKeys(body, [
    'message',
    'messages',
    'sessionId',
    'profile',
    'profileId',
    'taskMode',
    'taskModeId',
    'model',
  ]);
  assertExclusiveAliases(body, 'profile', 'profileId');
  assertExclusiveAliases(body, 'taskMode', 'taskModeId');

  const taskMode = resolveMedicalTaskMode(
    normalizeOptionalId(body.taskMode ?? body.taskModeId),
    'dialogue',
  );
  if (!taskMode) {
    throw new MedicalRequestError(
      'MEDICAL_TASK_MODE_INVALID',
      'The requested medical dialogue task mode is not supported.',
    );
  }

  const profile = resolveMedicalProfile(
    body.profile ?? body.profileId,
    'dialogue',
    taskMode.defaultProfile,
  );
  if (!profile) {
    throw new MedicalRequestError(
      'MEDICAL_PROFILE_INVALID',
      'The requested medical profile is not available for dialogue.',
    );
  }

  const hasMessage = body.message !== undefined;
  const hasMessages = body.messages !== undefined;
  if (hasMessage === hasMessages) {
    throw new MedicalRequestError(
      'MEDICAL_MESSAGE_REQUIRED',
      'Provide exactly one of message or messages.',
    );
  }

  let message;
  let conversation = [];
  if (hasMessage) {
    message = requireText(body.message, 'message');
  } else {
    const normalized = normalizeConversation(body.messages);
    message = normalized.message;
    conversation = normalized.conversation;
  }

  return {
    message,
    conversation,
    profile,
    taskMode,
    model: optionalModelSelection(body.model),
    sessionId: optionalSessionId(body.sessionId),
  };
}

function parseTraumaRequest(value) {
  const body = requireObjectBody(value);
  rejectSystemPromptFields(body);
  assertOnlyKeys(body, [
    'stage',
    'scene',
    'description',
    'images',
    'profile',
    'profileId',
    'sessionId',
    'model',
    'promptStyle',
    'mode',
  ]);
  assertExclusiveAliases(body, 'profile', 'profileId');
  assertExclusiveAliases(body, 'promptStyle', 'mode');

  const stage = resolveTraumaStage(body.stage);
  if (!stage) {
    throw new MedicalRequestError(
      'MEDICAL_TRAUMA_STAGE_INVALID',
      'The requested trauma stage is not supported.',
    );
  }
  const scene = body.scene === undefined
    ? ''
    : requireText(body.scene, 'scene', 2_000);
  const description = requireText(body.description, 'description');
  const profile = resolveMedicalProfile(body.profile ?? body.profileId, 'trauma-analysis');
  if (!profile) {
    throw new MedicalRequestError(
      'MEDICAL_PROFILE_INVALID',
      'The requested medical profile is not available for trauma analysis.',
    );
  }
  const images = validateImages(body.images, { required: false });
  const promptStyleValue = body.promptStyle ?? body.mode;
  const promptStyle = promptStyleValue === undefined
    ? 'eval'
    : normalizeTraumaPromptStyle(promptStyleValue);

  return {
    stage,
    scene,
    description,
    images,
    imageCount: images.length,
    imageMetadata: images.map((image) => ({
      imageId: image.imageId,
      category: image.category,
      label: image.label,
      index: image.index,
      modelInputAvailable: Boolean(image.data),
      preprocessingRequired: image.preprocessingRequired,
      demo: image.demo,
    })),
    promptStyle,
    profile,
    model: optionalModelSelection(body.model),
    sessionId: optionalSessionId(body.sessionId),
  };
}

function parseAttachmentPreparationRequest(value) {
  const body = requireObjectBody(value);
  rejectSystemPromptFields(body);
  assertOnlyKeys(body, ['attachments']);
  if (!Array.isArray(body.attachments) || body.attachments.length === 0 || body.attachments.length > 12) {
    throw new MedicalRequestError(
      'MEDICAL_ATTACHMENTS_INVALID',
      'attachments must contain between 1 and 12 items.',
    );
  }

  let totalBytes = 0;
  const attachments = body.attachments.map((item, index) => {
    if (!isRecord(item)) {
      throw new MedicalRequestError(
        'MEDICAL_ATTACHMENT_INVALID',
        `attachments[${index}] must be an object.`,
      );
    }
    assertOnlyKeys(item, ['name', 'mimeType', 'data']);
    const name = safeFilename(item.name, `attachment-${index + 1}`);
    const mimeType = requireMimeType(item.mimeType, `attachments[${index}].mimeType`);
    const decoded = normalizeBase64(item.data, `attachments[${index}].data`, MAX_IMAGE_BYTES);
    totalBytes += decoded.bytes;
    return { name, mimeType, data: decoded.base64, size: decoded.bytes };
  });

  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw bodyTooLargeError();
  return { attachments };
}

function parseTablePreparationRequest(value) {
  const body = requireObjectBody(value);
  rejectSystemPromptFields(body);
  assertOnlyKeys(body, ['table']);
  const table = body.table;
  if (!isRecord(table)) {
    throw new MedicalRequestError(
      'MEDICAL_TABLE_INVALID',
      'table must be an object containing columns and rows.',
    );
  }
  assertOnlyKeys(table, ['columns', 'rows']);
  if (!Array.isArray(table.columns) || table.columns.length === 0 || table.columns.length > 100) {
    throw new MedicalRequestError(
      'MEDICAL_TABLE_INVALID',
      'table.columns must contain between 1 and 100 values.',
    );
  }
  if (!Array.isArray(table.rows) || table.rows.length > 1_000) {
    throw new MedicalRequestError(
      'MEDICAL_TABLE_INVALID',
      'table.rows must be an array with at most 1000 rows.',
    );
  }

  const columns = table.columns.map((value, index) => requireShortCell(value, `table.columns[${index}]`));
  const rows = table.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new MedicalRequestError(
        'MEDICAL_TABLE_INVALID',
        `table.rows[${rowIndex}] must contain exactly ${columns.length} cells.`,
      );
    }
    return row.map((cell, columnIndex) => normalizeTableCell(
      cell,
      `table.rows[${rowIndex}][${columnIndex}]`,
    ));
  });
  return { table: { columns, rows } };
}

function normalizeConversation(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONVERSATION_MESSAGES) {
    throw new MedicalRequestError(
      'MEDICAL_MESSAGES_INVALID',
      `messages must contain between 1 and ${MAX_CONVERSATION_MESSAGES} items.`,
    );
  }

  const messages = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new MedicalRequestError(
        'MEDICAL_MESSAGES_INVALID',
        `messages[${index}] must be an object.`,
      );
    }
    assertOnlyKeys(entry, ['role', 'content']);
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      throw new MedicalRequestError(
        'MEDICAL_SYSTEM_PROMPT_FORBIDDEN',
        'Only user and assistant dialogue messages are accepted; system, developer, and tool prompts are forbidden.',
      );
    }
    return {
      role: entry.role,
      content: requireText(entry.content, `messages[${index}].content`, 30_000),
    };
  });

  const last = messages.at(-1);
  if (last.role !== 'user') {
    throw new MedicalRequestError(
      'MEDICAL_MESSAGES_INVALID',
      'The final dialogue message must have the user role.',
    );
  }
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > MAX_TEXT_CHARS) throw bodyTooLargeError();

  return {
    message: last.content,
    conversation: messages.slice(0, -1),
  };
}

function validateImages(value, options) {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGES_REQUIRED',
        'At least one image is required.',
      );
    }
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGE_COUNT) {
    throw new MedicalRequestError(
      'MEDICAL_IMAGES_INVALID',
      `images must contain between 1 and ${MAX_IMAGE_COUNT} items.`,
    );
  }

  let totalBytes = 0;
  const seenIds = new Set();
  const seenIndices = new Set();
  const images = value.map((image, index) => {
    if (!isRecord(image)) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_INVALID',
        `images[${index}] must be an object.`,
      );
    }
    assertOnlyKeys(image, [
      'name',
      'mimeType',
      'data',
      'imageId',
      'image_id',
      'id',
      'category',
      'label',
      'index',
      'demo',
      'dicom',
      'preprocessing_required',
    ]);
    const suppliedIds = [image.imageId, image.image_id, image.id]
      .filter((candidate) => candidate !== undefined);
    if (suppliedIds.length > 1) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_ID_CONFLICT',
        `images[${index}] must provide only one image ID field.`,
      );
    }
    const imageId = suppliedIds.length > 0
      ? normalizeMedicalImageId(suppliedIds[0], `images[${index}]`)
      : `image-${index + 1}`;
    if (seenIds.has(imageId)) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_ID_INVALID',
        'Medical image IDs must be unique.',
      );
    }
    const category = normalizeMedicalImageCategory(
      image.category ?? 'other',
      `images[${index}].category`,
    );
    const label = image.label === undefined
      ? ''
      : requireText(image.label, `images[${index}].label`, 160);
    const order = image.index === undefined ? index : Number(image.index);
    if (
      !Number.isSafeInteger(order)
      || order < 0
      || order > 10_000
      || seenIndices.has(order)
    ) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_ORDER_INVALID',
        'Medical image indices must be unique non-negative integers.',
      );
    }
    seenIds.add(imageId);
    seenIndices.add(order);
    for (const flag of ['demo', 'dicom', 'preprocessing_required']) {
      if (image[flag] !== undefined && typeof image[flag] !== 'boolean') {
        throw new MedicalRequestError(
          'MEDICAL_IMAGE_INVALID',
          `images[${index}].${flag} must be a boolean.`,
        );
      }
    }
    const demo = image.demo === true;
    const dicom = image.dicom === true;
    const preprocessingRequired = image.preprocessing_required === true;
    if (image.data === undefined || image.data === null || image.data === '') {
      if (!demo && !(dicom && preprocessingRequired)) {
        throw new MedicalRequestError(
          'MEDICAL_IMAGE_INVALID',
          `images[${index}].data must be base64 image data.`,
        );
      }
      return {
        name: safeFilename(image.name, `medical-image-${index + 1}`),
        mimeType: null,
        data: null,
        size: 0,
        imageId,
        category,
        label,
        index: order,
        demo,
        dicom,
        preprocessingRequired,
      };
    }
    if (typeof image.data !== 'string') {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_INVALID',
        `images[${index}].data must be base64 image data.`,
      );
    }

    const dataUrlMatch = image.data.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
    const declaredMime = normalizeMimeType(image.mimeType);
    const dataUrlMime = normalizeMimeType(dataUrlMatch?.[1]);
    if (declaredMime && dataUrlMime && declaredMime !== dataUrlMime) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_MIME_MISMATCH',
        `images[${index}] contains conflicting MIME types.`,
      );
    }
    const mimeType = declaredMime || dataUrlMime;
    if (!ALLOWED_MEDICAL_UPLOAD_MIME_TYPES.has(mimeType)) {
      throw new MedicalRequestError(
        'MEDICAL_IMAGE_TYPE_UNSUPPORTED',
        `images[${index}] must be JPEG, PNG, WebP, or DICOM.`,
        415,
      );
    }

    const decoded = normalizeBase64(
      dataUrlMatch ? dataUrlMatch[2] : image.data,
      `images[${index}].data`,
      MAX_IMAGE_BYTES,
    );
    totalBytes += decoded.bytes;
    return {
      // Do not expose a client-controlled filename to the model as attachment
      // metadata; it is another prompt-injection surface. The content and
      // validated MIME type are the only inputs needed for image analysis.
      name: `medical-image-${index + 1}.${imageExtension(mimeType)}`,
      mimeType,
      data: `data:${mimeType};base64,${decoded.base64}`,
      size: decoded.bytes,
      imageId,
      category,
      label,
      index: order,
      demo,
      dicom: mimeType === 'application/dicom' || dicom,
      preprocessingRequired,
    };
  });

  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw bodyTooLargeError();
  return images.sort((left, right) => left.index - right.index);
}

function normalizeBase64(value, fieldName, maxBytes) {
  if (typeof value !== 'string') {
    throw new MedicalRequestError('MEDICAL_BASE64_INVALID', `${fieldName} must be base64 data.`);
  }
  const base64 = value.replace(/\s+/g, '');
  if (
    !base64
    || base64.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    || /=/.test(base64.slice(0, -2))
  ) {
    throw new MedicalRequestError('MEDICAL_BASE64_INVALID', `${fieldName} is not valid base64 data.`);
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > maxBytes) throw bodyTooLargeError();
  return { base64, bytes };
}

function normalizeCorpora(result) {
  const source = Array.isArray(result)
    ? result
    : Array.isArray(result?.corpora)
      ? result.corpora
      : Array.isArray(result?.data?.corpora)
        ? result.data.corpora
        : null;
  if (!source) {
    throw new MedicalSidecarError('MEDICAL_SIDECAR_INVALID_RESPONSE');
  }

  return source.slice(0, 500).map((corpus, index) => {
    if (!isRecord(corpus)) {
      return {
        id: `corpus-${index + 1}`,
        name: `Corpus ${index + 1}`,
      };
    }
    const id = safeMetadataText(corpus.id, 200) || `corpus-${index + 1}`;
    const name = safeMetadataText(corpus.name, 200) || id;
    const description = safeMetadataText(corpus.description, 1_000);
    const reason = safeMetadataText(corpus.reason, 200);
    const documentCount = Number.isSafeInteger(corpus.documentCount) && corpus.documentCount >= 0
      ? corpus.documentCount
      : undefined;
    const updatedAt = safeIsoTimestamp(corpus.updatedAt);
    return {
      id,
      name,
      ready: corpus.ready === true,
      ...(description ? { description } : {}),
      ...(reason ? { reason } : {}),
      ...(documentCount !== undefined ? { documentCount } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  });
}

async function prepareSafeModelImages(sidecar, images, signal) {
  const result = await sidecar.prepareImages({ images }, { signal });
  const artifacts = Array.isArray(result?.images)
    ? result.images
    : Array.isArray(result?.artifacts)
      ? result.artifacts
      : [];
  const safeImages = [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !Array.isArray(artifact.previews)) continue;
    const preview = artifact.previews.find((candidate) => (
      isRecord(candidate)
      && candidate.kind === 'image'
      && typeof candidate.data === 'string'
    ));
    if (!preview) continue;
    const mimeType = normalizeMimeType(preview.media_type ?? preview.mimeType);
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) continue;
    const decoded = normalizeBase64(preview.data, 'sidecar.preview.data', MAX_IMAGE_BYTES);
    safeImages.push({
      name: `medical-sanitized-${safeImages.length + 1}.${imageExtension(mimeType)}`,
      mimeType,
      data: `data:${mimeType};base64,${decoded.base64}`,
      size: decoded.bytes,
    });
    if (safeImages.length >= MAX_IMAGE_COUNT) break;
  }
  if (images.length > 0 && safeImages.length === 0) {
    throw new MedicalRequestError(
      'MEDICAL_IMAGE_PREVIEW_UNAVAILABLE',
      'No de-identified model-safe image preview is available for the uploaded medical image.',
      422,
    );
  }
  return safeImages;
}

function routeBodyLimit(maxBytes) {
  return (req, _res, next) => {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
      if (bytes > maxBytes) throw bodyTooLargeError();
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireObjectBody(value) {
  if (!isRecord(value)) {
    throw new MedicalRequestError(
      'MEDICAL_BODY_INVALID',
      'The medical API request body must be a JSON object.',
    );
  }
  return value;
}

function rejectSystemPromptFields(body) {
  const forbidden = ['system', 'systemPrompt', 'system_prompt', 'developerPrompt', 'instructions'];
  if (forbidden.some((field) => Object.hasOwn(body, field))) {
    throw new MedicalRequestError(
      'MEDICAL_SYSTEM_PROMPT_FORBIDDEN',
      'Client-supplied system or developer prompts are not accepted.',
    );
  }
}

function assertOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new MedicalRequestError(
      'MEDICAL_FIELD_UNSUPPORTED',
      `Unsupported medical API field: ${unknown[0]}.`,
    );
  }
}

function assertExclusiveAliases(body, first, second) {
  if (body[first] !== undefined && body[second] !== undefined) {
    throw new MedicalRequestError(
      'MEDICAL_FIELD_CONFLICT',
      `Provide only one of ${first} or ${second}.`,
    );
  }
}

function requireText(value, fieldName, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MedicalRequestError(
      'MEDICAL_TEXT_REQUIRED',
      `${fieldName} must be a non-empty string.`,
    );
  }
  if (value.length > maxChars) throw bodyTooLargeError();
  if (value.includes('\u0000')) {
    throw new MedicalRequestError(
      'MEDICAL_TEXT_INVALID',
      `${fieldName} contains unsupported control characters.`,
    );
  }
  return value.trim();
}

function requireSessionId(value) {
  const sessionId = optionalSessionId(value);
  if (!sessionId) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_REQUIRED',
      'A valid PilotDeck medical sessionId is required.',
    );
  }
  return sessionId;
}

function optionalSessionId(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = safeMedicalSessionId(value);
  if (!normalized) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_INVALID',
      'sessionId must be a PilotDeck medical session key.',
    );
  }
  return normalized;
}

function safeSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > 200) return '';
  return /^(?:web(?::|-)s_|medical:s_)[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : '';
}

function safeMedicalSessionId(value) {
  const sessionId = safeSessionId(value);
  return sessionId.startsWith('medical:s_') ? sessionId : '';
}

function assertSessionAvailable(sessionId, activeSessions) {
  if (sessionId && activeSessions.has(sessionId)) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_BUSY',
      'This medical session already has an active generation.',
      409,
    );
  }
}

function assertMedicalCapacity(activeSessions, owner) {
  const runs = new Map();
  for (const record of activeSessions.values()) {
    if (record?.requestId) runs.set(record.requestId, record);
  }
  const ownerRuns = [...runs.values()].filter((record) => record.owner === owner).length;
  if (
    runs.size >= MAX_CONCURRENT_MEDICAL_RUNS
    || ownerRuns >= MAX_CONCURRENT_MEDICAL_RUNS_PER_OWNER
  ) {
    throw new MedicalRequestError(
      'MEDICAL_CAPACITY_EXCEEDED',
      'Medical generation capacity is currently full. Retry after an active request completes.',
      429,
    );
  }
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.trim())) {
    throw new MedicalRequestError(
      'MEDICAL_ID_INVALID',
      'Medical profile and task mode IDs must use lowercase letters, numbers, and hyphens.',
    );
  }
  return value.trim();
}

function optionalModelSelection(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new MedicalRequestError(
      'MEDICAL_MODEL_INVALID',
      'model must be a registered provider/model identifier.',
    );
  }
  const normalized = value.trim();
  if (
    normalized.length > 300
    || !/^[a-zA-Z0-9_.:-]+\/[a-zA-Z0-9_.:/-]+$/.test(normalized)
  ) {
    throw new MedicalRequestError(
      'MEDICAL_MODEL_INVALID',
      'model must be a registered provider/model identifier.',
    );
  }
  return normalized;
}

function safeFilename(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .slice(0, 160);
  return normalized || fallback;
}

function requireMimeType(value, fieldName) {
  const normalized = normalizeMimeType(value);
  if (!normalized || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(normalized)) {
    throw new MedicalRequestError(
      'MEDICAL_MIME_TYPE_INVALID',
      `${fieldName} must be a valid MIME type.`,
    );
  }
  return normalized;
}

function normalizeMimeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function imageExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function normalizeMedicalImageId(value, fieldName) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.trim())
  ) {
    throw new MedicalRequestError(
      'MEDICAL_IMAGE_ID_INVALID',
      `${fieldName} image ID is invalid.`,
    );
  }
  return value.trim();
}

function normalizeMedicalImageCategory(value, fieldName) {
  const category = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!['wound', 'xray', 'ecg', 'ct', 'other'].includes(category)) {
    throw new MedicalRequestError(
      'MEDICAL_IMAGE_CATEGORY_INVALID',
      `${fieldName} must be wound, xray, ecg, ct, or other.`,
    );
  }
  return category;
}

function normalizeTraumaPromptStyle(value) {
  const style = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (style !== 'eval' && style !== 'plain') {
    throw new MedicalRequestError(
      'MEDICAL_PROMPT_STYLE_INVALID',
      'promptStyle must be eval or plain.',
    );
  }
  return style;
}

function requireShortCell(value, fieldName) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000) {
    throw new MedicalRequestError(
      'MEDICAL_TABLE_INVALID',
      `${fieldName} must be a non-empty string no longer than 1000 characters.`,
    );
  }
  return value.trim();
}

function normalizeTableCell(value, fieldName) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new MedicalRequestError('MEDICAL_TABLE_INVALID', `${fieldName} must be a finite value.`);
    }
    return value;
  }
  if (typeof value === 'string' && value.length <= 4_000 && !value.includes('\u0000')) {
    return value;
  }
  throw new MedicalRequestError(
    'MEDICAL_TABLE_INVALID',
    `${fieldName} must be a short string, finite number, boolean, or null.`,
  );
}

function normalizeMedicalStatusPhase(value) {
  const status = typeof value === 'string' ? value : '';
  if (status === 'started') return 'started';
  if (status === 'model_request_started') return 'generating';
  if (status === 'compacting') return 'context-management';
  if (status === 'token_budget') return 'context';
  return '';
}

function safeGatewayError(value) {
  const code = typeof value === 'string' ? value : '';
  return SAFE_GATEWAY_ERRORS[code] || {
    code: 'MEDICAL_GENERATION_FAILED',
    message: 'Medical generation failed.',
    recoverable: true,
  };
}

function gatewayErrorStatus(code) {
  if (code === 'MEDICAL_GATEWAY_UNAVAILABLE') return 503;
  if (code === 'MEDICAL_SESSION_BUSY') return 409;
  if (code === 'MEDICAL_GENERATION_TIMEOUT') return 504;
  if (code === 'MEDICAL_GENERATION_STOPPED') return 409;
  return 502;
}

function safeFinishReason(value) {
  const allowed = new Set(['stop', 'length', 'end_turn', 'completed']);
  return typeof value === 'string' && allowed.has(value) ? value : 'completed';
}

function safeUsage(value) {
  const source = isRecord(value) ? value : {};
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens']) {
    if (Number.isFinite(source[key]) && source[key] >= 0) usage[key] = source[key];
  }
  return usage;
}

function safeTokenBudget(value) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const key of ['used', 'total', 'effectiveTotal', 'ratio']) {
    if (Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
  }
  if (['ok', 'warning', 'blocking', 'unknown'].includes(source.state)) {
    result.state = source.state;
  }
  return result;
}

function capability(available, adapter, sidecarHealth = null) {
  return {
    available: available === true,
    adapter,
    ...(!available && sidecarHealth?.reason ? { reason: sidecarHealth.reason } : {}),
  };
}

function normalizeSidecarDescription(sidecar) {
  if (typeof sidecar?.describe === 'function') return sidecar.describe();
  return {
    configured: false,
    available: false,
    status: 'unavailable',
    reason: 'not_configured',
  };
}

function configuredVisionModelStatus(readConfig) {
  let record;
  try {
    record = readConfig();
  } catch {
    return { available: false, reason: 'config_unavailable' };
  }
  if (record?.parseError) {
    return { available: false, reason: 'config_invalid' };
  }
  const catalog = medicalModelsFromConfig(record?.config || {});
  const selected = catalog.models.find((model) => model.id === catalog.defaultModel);
  if (!selected) return { available: false, reason: 'model_unavailable' };
  if (selected.supportsImages !== true) {
    return { available: false, reason: 'model_vision_unsupported' };
  }
  return { available: true, reason: null };
}

export function medicalSessionPrefixForOwner(owner) {
  const digest = createHash('sha256')
    .update(String(owner || 'authenticated-user'))
    .digest('hex')
    .slice(0, 16);
  return `medical:s_u${digest}_`;
}

function assertMedicalSessionOwner(sessionId, owner) {
  if (!sessionId) return;
  if (!sessionId.startsWith(medicalSessionPrefixForOwner(owner))) {
    throw new MedicalRequestError(
      'MEDICAL_SESSION_FORBIDDEN',
      'This medical session is owned by another authenticated user.',
      403,
    );
  }
}

function ownerKey(req) {
  return String(
    req.user?.id
    ?? req.user?.userId
    ?? req.user?.username
    ?? 'authenticated-user',
  );
}

async function withRequestAbort(req, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  try {
    return await operation(controller.signal);
  } finally {
    req.removeListener('aborted', abort);
  }
}

function writeMedicalEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(formatMedicalSseEvent(event));
  }
}

function bodyTooLargeError() {
  return new MedicalRequestError(
    'MEDICAL_BODY_TOO_LARGE',
    'The medical API request body exceeds the allowed size.',
    413,
  );
}

function sendMedicalError(res, error) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  let status = 500;
  let code = 'MEDICAL_INTERNAL_ERROR';
  let message = 'The medical API request failed.';
  let extra = {};

  if (error instanceof MedicalRequestError) {
    status = error.status;
    code = error.code;
    message = error.safeMessage;
    if (error.details) extra = { details: error.details };
  } else if (error instanceof MedicalCapabilityUnavailableError) {
    status = error.status;
    code = error.code;
    message = 'The requested medical capability is unavailable.';
    extra = {
      capability: error.capability,
      reason: error.reason,
    };
  } else if (error instanceof MedicalSidecarError) {
    status = error.status;
    code = error.code;
    message = status === 504
      ? 'The medical sidecar request timed out.'
      : 'The medical sidecar request failed.';
  } else if (error instanceof MedicalStoreError) {
    status = error.status;
    code = error.code;
    message = status === 409
      ? 'The medical record changed; reload it before retrying.'
      : status === 413
        ? 'The medical record exceeds the allowed size.'
        : status === 429
          ? 'Medical storage capacity is currently full.'
          : status >= 500
            ? 'Medical storage is temporarily unavailable.'
            : 'The medical record request is invalid.';
  } else if (error instanceof MedicalStaticDataError) {
    status = error.status;
    code = error.code;
    message = status === 404
      ? 'Medical demo data was not found.'
      : status === 400 || status === 415 || status === 422
        ? 'The medical demo data request is invalid.'
        : 'Medical demo data is not installed.';
    extra = { reason: error.reason };
  }

  res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  });
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isJsonRequest(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  return /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/.test(contentType);
}

function safeMetadataText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

function safeIsoTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

const router = createMedicalRouter();

export default router;
