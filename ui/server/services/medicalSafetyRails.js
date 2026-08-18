/**
 * Medical safety rails for PilotDeck medical generation.
 *
 * Three complementary guards that wrap streamGatewayGeneration and
 * runManagedGatewayTask:
 *
 * 1. N-gram repetition detection — monitors delta text for looping
 *    patterns and aborts the run when repetition is detected.
 *
 * 2. Weak-answer retry — if a completed generation produces fewer than
 *    the minimum character threshold (and is not valid structured JSON),
 *    the prompt is retried once with metadata marking the retry context.
 *
 * 3. Thinking-language enforcement — ensures that thinking deltas from
 *    the Gateway are forwarded as SSE `<think>` tokens rather than
 *    silently dropped, and that stop-think signals only suppress
 *    rendering without affecting generation.
 */

// ---------------------------------------------------------------------------
// 1. N-gram repetition detection
// ---------------------------------------------------------------------------

/**
 * Default configuration — tune per deployment via env or preset.
 */
const DEFAULT_REPETITION_CONFIG = {
  /** Number of consecutive identical n-gram blocks before triggering a kill. */
  maxConsecutiveRepeats: 6,
  /** N-gram size in characters. */
  ngramSize: 80,
  /** Minimum total delta characters before detection activates. */
  minCharsBeforeCheck: 500,
};

/**
 * Create a repetition detector for a single generation stream.
 *
 * Returns an object with:
 *  - feed(text): append delta text, returns { safe: boolean, repeatCount: number }
 *  - reset(): clear accumulated state
 */
export function createRepetitionDetector(config = {}) {
  const { maxConsecutiveRepeats, ngramSize, minCharsBeforeCheck } = {
    ...DEFAULT_REPETITION_CONFIG,
    ...config,
  };

  let accumulated = '';
  let lastNgram = '';
  let repeatCount = 0;
  let totalChars = 0;

  return {
    feed(text) {
      if (typeof text !== 'string' || !text) return { safe: true, repeatCount: 0 };
      accumulated += text;
      totalChars += text.length;

      if (totalChars < minCharsBeforeCheck) return { safe: true, repeatCount: 0 };

      // Extract the latest n-gram window
      const currentNgram = accumulated.slice(-ngramSize);
      if (currentNgram.length < ngramSize) return { safe: true, repeatCount: 0 };

      if (currentNgram === lastNgram) {
        repeatCount += 1;
      } else {
        lastNgram = currentNgram;
        repeatCount = 0;
      }

      return {
        safe: repeatCount < maxConsecutiveRepeats,
        repeatCount,
      };
    },

    reset() {
      accumulated = '';
      lastNgram = '';
      repeatCount = 0;
      totalChars = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Weak-answer detection
// ---------------------------------------------------------------------------

const DEFAULT_WEAK_ANSWER_CONFIG = {
  /** Minimum character threshold. Answers below this trigger a retry. */
  minChars: 80,
  /** Maximum number of retries. */
  maxRetries: 1,
};

/**
 * Check whether a completed generation output qualifies as "weak"
 * (too short and not structured JSON).
 *
 * @param {string} text
 * @param {object} [config]
 * @returns {{ weak: boolean, reason?: string }}
 */
export function isWeakAnswer(text, config = {}) {
  const { minChars } = { ...DEFAULT_WEAK_ANSWER_CONFIG, ...config };

  if (typeof text !== 'string') return { weak: false };

  const trimmed = text.trim();
  if (trimmed.length >= minChars) return { weak: false };

  // Structured JSON of any length is considered intentional
  if (/^\s*[\{\[]/.test(trimmed) && /[\}\]]\s*$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return { weak: false };
    } catch {
      // Not valid JSON — fall through to weak check
    }
  }

  return { weak: true, reason: `output too short (${trimmed.length} < ${minChars} chars)` };
}

// ---------------------------------------------------------------------------
// 3. Thinking delta normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Gateway message that contains thinking content into
 * medical SSE events.  By default `normalizedMessageToMedicalEvents`
 * discards `assistant_thinking_delta` / `kind: 'thinking'` messages.
 * This helper bridges that gap.
 *
 * Mapping:
 *  - assistant_thinking_start / thinking_start → SSE `<think>` open token
 *  - assistant_thinking_delta  / thinking_delta  → SSE inline token
 *  - assistant_thinking_end    / thinking_end     → SSE `</think>` close token
 *
 * @param {object} message — Gateway message
 * @returns {{ event: string, data: object }[]}
 */
export function thinkingDeltaToMedicalEvents(message) {
  if (!message || typeof message !== 'object') return [];

  const isThinking =
    message.kind === 'thinking_start' ||
    message.kind === 'assistant_thinking_start' ||
    message.kind === 'thinking_delta' ||
    message.kind === 'assistant_thinking_delta' ||
    message.kind === 'thinking_end' ||
    message.kind === 'assistant_thinking_end';

  if (!isThinking) return [];

  switch (message.kind) {
    case 'thinking_start':
    case 'assistant_thinking_start':
      return [{
        event: 'thinking',
        data: { type: 'thinking_start', text: '<think>' },
      }];
    case 'thinking_delta':
    case 'assistant_thinking_delta': {
      const text = typeof message.content === 'string'
        ? message.content
        : typeof message.text === 'string'
          ? message.text
          : '';
      if (!text) return [];
      return [{
        event: 'thinking',
        data: { type: 'thinking_delta', text },
      }];
    }
    case 'thinking_end':
    case 'assistant_thinking_end':
      return [{
        event: 'thinking',
        data: { type: 'thinking_end', text: '</think>' },
      }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 4. Combined stream guard factory
// ---------------------------------------------------------------------------

/**
 * Wraps a Gateway message writer with safety rails.
 *
 * Usage inside streamGatewayGeneration:
 *
 *   const guard = createStreamGuard({ writer, abortCurrentRun, config });
 *   // replace writer with guard.writer in runChat call
 *
 * The guard intercepts every message, runs repetition detection on
 * deltas, and triggers abort + error when a loop is detected.
 *
 * On `complete`, the guard checks for weak answers and requests a
 * retry.
 *
 * Thinking deltas are forwarded as additional SSE events alongside
 * the normal delta stream.
 *
 * @param {object} options
 * @param {object} options.writer — original message writer
 * @param {function} options.abortCurrentRun — aborts the active Gateway run
 * @param {function} options.onRetryRequested — called when weak answer triggers a retry
 * @param {object} [options.repetitionConfig]
 * @param {object} [options.weakAnswerConfig]
 * @returns {object} { writer, getAccumulatedText, getRepetitionState }
 */
export function createStreamGuard({
  writer,
  abortCurrentRun,
  onRetryRequested,
  repetitionConfig,
  weakAnswerConfig,
}) {
  const detector = createRepetitionDetector(repetitionConfig);
  const config = { ...DEFAULT_WEAK_ANSWER_CONFIG, ...weakAnswerConfig };
  let accumulatedText = '';
  let terminated = false;
  let retried = false;

  const guardWriter = {
    send(message) {
      if (terminated) return;

      // Forward thinking deltas as additional events
      const thinkingEvents = thinkingDeltaToMedicalEvents(message);
      for (const event of thinkingEvents) {
        writer.send({ kind: 'custom_sse', rawEvent: event });
      }

      // Run repetition detection on text deltas
      if (message.kind === 'stream_delta' || message.kind === 'text') {
        const text = typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : '';
        if (text) {
          accumulatedText += text;
          const { safe, repeatCount } = detector.feed(text);
          if (!safe) {
            terminated = true;
            writer.send({
              kind: 'custom_sse',
              rawEvent: {
                event: 'error',
                data: {
                  type: 'error',
                  code: 'MEDICAL_REPETITION_LOOP',
                  message: 'Generation was stopped because it entered a repetitive loop.',
                  recoverable: false,
                  ...(repeatCount !== undefined ? { detail: { repeatCount } } : {}),
                },
              },
            });
            abortCurrentRun?.();
            return;
          }
        }
      }

      // Weak-answer check on complete
      if (message.kind === 'complete' && !retried) {
        const accumulated = typeof message.accumulatedText === 'string'
          ? message.accumulatedText
          : accumulatedText;

        const { weak } = isWeakAnswer(accumulated, config);
        if (weak && onRetryRequested) {
          retried = true;
          onRetryRequested({
            accumulatedText: accumulated,
            reason: `output too short (${accumulated.trim().length} < ${config.minChars} chars)`,
          });
          // Don't forward the original complete — let the retry handle it
          return;
        }
      }

      // Forward custom SSE events
      if (message.kind === 'custom_sse' && message.rawEvent) {
        return; // handled by the writer's caller via custom event emission
      }

      // Pass through to original writer
      writer.send(message);
    },

    getAccumulatedText() {
      return accumulatedText;
    },

    resetForRetry() {
      detector.reset();
      accumulatedText = '';
      terminated = false;
    },
  };

  return {
    writer: guardWriter,
    getAccumulatedText: () => accumulatedText,
    getRepetitionState: () => ({ terminated }),
  };
}
