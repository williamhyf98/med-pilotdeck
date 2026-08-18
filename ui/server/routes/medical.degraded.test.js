/**
 * Medical degraded-mode test matrix.
 *
 * Validates error codes, recoverable flags, and response sanitization
 * for each known failure scenario without requiring live sidecar/Gateway.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEDICAL_API_VERSION,
  normalizedMessageToMedicalEvents,
  formatMedicalSseEvent,
} from './medical.js';

describe('medical SSE event normalization', () => {
  it('emits ready + session events for a well-formed stream start', () => {
    // normalizedMessageToMedicalEvents is the core event mapper
    const events = normalizedMessageToMedicalEvents(
      { kind: 'session_created', sessionId: 'medical:s_test_001' },
      { requestId: 'req-1', sessionId: 'medical:s_test_001' },
    );
    assert.ok(events.length > 0);
    assert.equal(events[0].event, 'session');
    assert.equal(events[0].data.type, 'session');
    assert.equal(events[0].data.version, MEDICAL_API_VERSION);
  });

  it('forwards permission_request as error with correct code', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'permission_request' },
      { requestId: 'req-2', sessionId: 's2' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.code, 'MEDICAL_INTERACTION_UNAVAILABLE');
    assert.equal(events[0].data.recoverable, true);
  });

  it('maps known gateway errors to safe medical codes', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'error', code: 'gateway_unavailable' },
      { requestId: 'req-3' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'error');
    assert.equal(events[0].data.code, 'MEDICAL_GATEWAY_UNAVAILABLE');
    assert.equal(events[0].data.recoverable, true);
  });

  it('maps model_request_failed to safe code', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'error', code: 'model_request_failed' },
      { requestId: 'req-4' },
    );
    assert.equal(events[0].data.code, 'MEDICAL_MODEL_REQUEST_FAILED');
    assert.equal(events[0].data.recoverable, true);
  });

  it('maps content_filter_stop as non-recoverable', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'error', code: 'content_filter_stop' },
      { requestId: 'req-5' },
    );
    assert.equal(events[0].data.code, 'MEDICAL_CONTENT_FILTERED');
    assert.equal(events[0].data.recoverable, false);
  });

  it('maps turn_timeout as recoverable', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'error', code: 'turn_timeout' },
      { requestId: 'req-6' },
    );
    assert.equal(events[0].data.code, 'MEDICAL_GENERATION_TIMEOUT');
    assert.equal(events[0].data.recoverable, true);
  });

  it('maps turn_aborted status to done/stopped', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'status', code: 'turn_aborted' },
      { requestId: 'req-7' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    assert.equal(events[0].data.reason, 'stopped');
  });

  it('maps complete to done with usage', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'complete', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 200 } },
      { requestId: 'req-8' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    assert.equal(events[0].data.reason, 'stop');
    assert.deepEqual(events[0].data.usage, { inputTokens: 100, outputTokens: 200 });
  });

  it('maps interrupted to done/stopped', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'interrupted' },
      { requestId: 'req-9' },
    );
    assert.equal(events[0].event, 'done');
    assert.equal(events[0].data.reason, 'stopped');
  });

  it('returns empty array for unknown message kinds', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'unknown_kind' },
      { requestId: 'req-10' },
    );
    assert.deepEqual(events, []);
  });

  it('returns empty array for null/undefined input', () => {
    assert.deepEqual(normalizedMessageToMedicalEvents(null), []);
    assert.deepEqual(normalizedMessageToMedicalEvents(undefined), []);
    assert.deepEqual(normalizedMessageToMedicalEvents('not an object'), []);
  });

  it('forwards thinking deltas as thinking events', () => {
    const startEvents = normalizedMessageToMedicalEvents(
      { kind: 'assistant_thinking_start' },
      { requestId: 'req-11' },
    );
    assert.equal(startEvents.length, 1);
    assert.equal(startEvents[0].event, 'thinking');
    assert.equal(startEvents[0].data.text, '<think>');

    const deltaEvents = normalizedMessageToMedicalEvents(
      { kind: 'assistant_thinking_delta', content: '分析中...' },
      { requestId: 'req-12' },
    );
    assert.equal(deltaEvents.length, 1);
    assert.equal(deltaEvents[0].event, 'thinking');
    assert.equal(deltaEvents[0].data.text, '分析中...');

    const endEvents = normalizedMessageToMedicalEvents(
      { kind: 'assistant_thinking_end' },
      { requestId: 'req-13' },
    );
    assert.equal(endEvents[0].event, 'thinking');
    assert.equal(endEvents[0].data.text, '</think>');
  });

  it('filters empty text from delta events', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'stream_delta', content: '' },
      { requestId: 'req-14' },
    );
    assert.deepEqual(events, []);

    const thinkingEvents = normalizedMessageToMedicalEvents(
      { kind: 'assistant_thinking_delta', content: '' },
      { requestId: 'req-15' },
    );
    assert.deepEqual(thinkingEvents, []);
  });
});

describe('medical SSE wire format', () => {
  it('produces valid SSE event:data lines', () => {
    const formatted = formatMedicalSseEvent({
      event: 'delta',
      data: { type: 'delta', text: 'hello' },
    });
    assert.ok(formatted.startsWith('event: delta\n'));
    assert.ok(formatted.includes('data: {'));
    assert.ok(formatted.endsWith('\n\n'));
  });

  it('round-trips event data through JSON', () => {
    const data = { type: 'done', reason: 'stop', requestId: 'r1' };
    const wire = formatMedicalSseEvent({ event: 'done', data });
    const lines = wire.split('\n');
    const dataLine = lines.find((l) => l.startsWith('data: '));
    assert.ok(dataLine);
    const parsed = JSON.parse(dataLine.slice(6));
    assert.deepEqual(parsed, data);
  });
});

describe('error response sanitization', () => {
  it('each error code has a non-empty message', () => {
    // Verify that all SAFE_GATEWAY_ERRORS entries have messages
    // This is an indirect test via the event mapper
    for (const code of [
      'gateway_unavailable',
      'session_busy',
      'model_request_failed',
      'content_filter_stop',
      'turn_timeout',
      'turn_aborted',
    ]) {
      const events = normalizedMessageToMedicalEvents(
        { kind: 'error', code },
        { requestId: 'test' },
      );
      assert.ok(events.length > 0, `Should have event for code: ${code}`);
      const event = events[0];
      if (event.event === 'error') {
        assert.ok(typeof event.data.message === 'string' && event.data.message.length > 0,
          `Error message should be non-empty for code: ${code}`);
      }
    }
  });

  it('unknown error codes fall through without leaking internals', () => {
    const events = normalizedMessageToMedicalEvents(
      { kind: 'error', code: 'unknown_internal_error_xyz' },
      { requestId: 'test' },
    );
    // Unknown error should still produce a safe event
    if (events.length > 0) {
      const msg = events[0].data.message || '';
      // Must not contain raw code identifiers that might leak internals
      assert.ok(!msg.includes('internal'), 'Error message should not leak internal identifiers');
    }
  });
});
