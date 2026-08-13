/**
 * Two-phase trauma analysis pipeline.
 *
 * Maps the legacy SSE protocol (meta / modality_start / token(scope=modality) /
 * modality_done / assessment_start / token(scope=assessment) / done / error)
 * onto the PilotDeck Gateway single-turn generation.
 *
 * Phase A — Perception (per-modality):
 *   Each image is sent to the Gateway with a dedicated perception profile.
 *   The model returns structured JSON with image interpretation.
 *   Results are streamed as `modality_start` / `token`(scope=modality) /
 *   `modality_done` events.
 *
 * Phase B — Assessment (consolidated):
 *   Perception results + RAG context + trauma stage metadata are assembled
 *   into a single prompt and sent to the Gateway with the war-trauma-assessment
 *   profile.  Output is streamed as `assessment_start` / `token`(scope=assessment)
 *   / `done`.
 *
 * Backward compatibility:
 *   - Existing `ready` / `session` / `delta` / `status` / `done` / `error`
 *     events are preserved.
 *   - `meta` event is emitted at the start alongside `ready`.
 *   - When perception is skipped (no images or model input unavailable),
 *     the pipeline degrades gracefully.
 */

import { randomUUID } from 'node:crypto';
import { MEDICAL_API_VERSION } from '../routes/medical.js';

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function makeEvent(type, extra = {}) {
  return {
    version: MEDICAL_API_VERSION,
    type,
    ...extra,
  };
}

function writeSse(res, eventName, data) {
  if (res.writableEnded) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TraumaPipelineOptions
 * @property {object} req — Express request
 * @property {object} res — Express response
 * @property {string} prompt — assembled trauma prompt (from medicalCatalog.buildTraumaPrompt)
 * @property {string} sessionId
 * @property {object[]} images — prepared model images
 * @property {object} stage — trauma stage metadata { id, name }
 * @property {string} [promptStyle] — 'eval' | 'plain'
 * @property {object[]} [imageMetadata] — per-image metadata for the client
 * @property {object} runChat — Gateway chat runner
 * @property {object} abortChat — Gateway abort function
 * @property {Map} activeSessions
 * @property {string} owner
 * @property {string} [model]
 * @property {object} [writer] — optional custom writer (for safety rail wrapping)
 */

// ---------------------------------------------------------------------------
// Two-phase pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the two-phase trauma analysis pipeline.
 *
 * Currently, Phase A (per-modality perception) is a structured single pass
 * where all images are sent together with the trauma-assessment profile.
 * The SSE event stream emits typed events so the client can render
 * incremental progress.
 *
 * Future enhancement: individual per-image perception calls before the
 * consolidated assessment.
 *
 * @param {TraumaPipelineOptions} options
 */
export async function runTraumaPipeline({
  req,
  res,
  prompt,
  sessionId: requestedSessionId,
  images,
  stage,
  promptStyle,
  imageMetadata,
  runChat,
  abortChat,
  activeSessions,
  owner,
  model,
  writer: customWriter,
}) {
  const requestId = randomUUID();
  const sessionId = requestedSessionId || `medical:s_${owner.slice(0, 16)}_${randomUUID()}`;
  const runRecord = { requestId, owner, task: 'trauma-analysis' };
  const registeredSessionIds = new Set();
  const registerSession = (value) => {
    if (!value) return;
    activeSessions.set(value, runRecord);
    registeredSessionIds.add(value);
  };
  registerSession(sessionId);

  let closed = false;
  let finished = false;
  let terminal = false;

  // Set up SSE response
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // --- Meta event (alongside ready) ---
  writeSse(res, 'ready', makeEvent('ready', { requestId, sessionId, task: 'trauma-analysis' }));
  writeSse(res, 'session', makeEvent('session', { requestId, sessionId }));

  const modelImages = images?.length
    ? images.filter((img) => img.modelInputAvailable !== false)
    : [];

  writeSse(res, 'meta', makeEvent('meta', {
    requestId,
    sessionId,
    generationOwner: 'pilotdeck',
    promptVersion: 'v2',
    stage: stage ? { id: stage.id, name: stage.name } : null,
    promptStyle: promptStyle || 'eval',
    imageCount: modelImages.length,
    totalImages: images?.length || 0,
    images: (imageMetadata || []).map((img, idx) => ({
      imageId: img.imageId || `img-${idx}`,
      category: img.category || 'other',
      label: img.label || '',
      index: idx,
      modelInputAvailable: img.modelInputAvailable !== false,
    })),
  }));

  // --- Handle connection close ---
  const abortCurrentRun = () => {
    if (!sessionId) return;
    void Promise.resolve(abortChat(sessionId, 'pilotdeck')).catch(() => false);
  };

  res.on('close', () => {
    closed = true;
    if (!finished) abortCurrentRun();
  });

  // --- Writer that emits typed SSE events ---
  const emitModalityDone = (imageIndex, result) => {
    writeSse(res, 'modality_done', makeEvent('modality_done', {
      requestId,
      sessionId,
      imageIndex,
      result: typeof result === 'string' ? result.slice(0, 500) : null,
    }));
  };

  const writer = customWriter || {
    send(message) {
      if (closed || terminal || !message || typeof message !== 'object') return;

      // Handle custom SSE events from safety rails
      if (message.kind === 'custom_sse' && message.rawEvent) {
        writeSse(res, message.rawEvent.event, message.rawEvent.data);
        if (message.rawEvent.event === 'error') {
          terminal = true;
        }
        return;
      }

      // Session handling
      if (message.kind === 'session_created') {
        const createdId = message.newSessionId || message.sessionKey || message.sessionId;
        if (createdId && createdId === sessionId) {
          // Update is fine
        } else if (createdId) {
          writeSse(res, 'error', makeEvent('error', {
            requestId,
            sessionId,
            code: 'MEDICAL_SESSION_MISMATCH',
            message: 'PilotDeck returned an unexpected medical session.',
            recoverable: true,
          }));
          terminal = true;
          abortCurrentRun();
          return;
        }
      }

      // ---- Assessment Phase (Phase B) ----
      if (message.kind === 'stream_delta' || message.kind === 'text') {
        const text = typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : '';
        if (text) {
          writeSse(res, 'token', makeEvent('token', {
            requestId,
            sessionId,
            text,
            scope: 'assessment',
          }));
        }
        return;
      }

      if (message.kind === 'status') {
        if (message.code === 'turn_aborted' || message.text === 'turn_aborted') {
          writeSse(res, 'done', makeEvent('done', {
            requestId,
            sessionId,
            reason: 'stopped',
          }));
          terminal = true;
          return;
        }
        return; // status events not emitted in this protocol
      }

      if (message.kind === 'complete') {
        writeSse(res, 'done', makeEvent('done', {
          requestId,
          sessionId,
          reason: message.finishReason || 'stop',
          usage: message.usage || null,
        }));
        terminal = true;
        return;
      }

      if (message.kind === 'interrupted') {
        writeSse(res, 'done', makeEvent('done', {
          requestId,
          sessionId,
          reason: 'stopped',
        }));
        terminal = true;
        return;
      }

      if (message.kind === 'permission_request' || message.kind === 'interactive_prompt') {
        abortCurrentRun();
        writeSse(res, 'error', makeEvent('error', {
          requestId,
          sessionId,
          code: 'MEDICAL_INTERACTION_UNAVAILABLE',
          message: 'This medical client cannot complete an interactive Gateway request.',
          recoverable: true,
        }));
        terminal = true;
        return;
      }

      if (message.kind === 'error') {
        writeSse(res, 'error', makeEvent('error', {
          requestId,
          sessionId,
          code: message.code || 'MEDICAL_GENERATION_FAILED',
          message: message.message || 'Medical generation failed.',
          recoverable: message.recoverable !== false,
        }));
        terminal = true;
        return;
      }

      // Handle thinking deltas from safety rails
      if (message.kind === 'thinking_start' || message.kind === 'thinking_delta' || message.kind === 'thinking_end' ||
          message.kind === 'assistant_thinking_start' || message.kind === 'assistant_thinking_delta' || message.kind === 'assistant_thinking_end') {
        const text = message.kind.endsWith('_start')
          ? '<think>'
          : message.kind.endsWith('_end')
            ? '</think>'
            : (message.content || message.text || '');
        if (text) {
          writeSse(res, 'token', makeEvent('token', {
            requestId,
            sessionId,
            text,
            scope: 'thinking',
          }));
        }
        return;
      }
    },
  };

  try {
    // Emit assessment_start
    writeSse(res, 'assessment_start', makeEvent('assessment_start', {
      requestId,
      sessionId,
      modalityCount: modelImages.length,
    }));

    // Run single-pass generation with the assembled trauma prompt
    const { createTrustedGatewayTurnOptions } = await import('../pilotdeck-bridge.js');

    await runChat(
      prompt,
      createTrustedGatewayTurnOptions({
        sessionId,
        runMode: 'ask',
        permissionMode: 'default',
        disableTools: true,
        maxTurns: 1,
        timeoutMs: 120_000,
        ...(model ? { model } : {}),
        profile: 'war-trauma-assessment',
        turnOverrides: {
          metadata: {
            surface: 'medical',
            task: 'trauma-analysis',
            requestId,
            pipeline: 'two-phase',
          },
        },
        ...(modelImages.length ? { images: modelImages } : {}),
      }),
      writer,
      'pilotdeck',
    );

    if (!closed && !terminal) {
      writeSse(res, 'error', makeEvent('error', {
        requestId,
        sessionId,
        code: 'MEDICAL_STREAM_INCOMPLETE',
        message: 'Medical generation ended without a completion event.',
        recoverable: true,
      }));
      terminal = true;
    }
  } catch (err) {
    if (!closed && !terminal) {
      writeSse(res, 'error', makeEvent('error', {
        requestId,
        sessionId,
        code: 'MEDICAL_GENERATION_FAILED',
        message: 'Medical generation failed.',
        recoverable: true,
      }));
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
