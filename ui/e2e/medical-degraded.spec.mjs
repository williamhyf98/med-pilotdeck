/**
 * Medical Degraded Mode e2e test.
 *
 * Validates that each subsystem explicitly reports "unavailable" rather
 * than silently succeeding when its backend dependency is missing.
 *
 * Prerequisites: PilotDeck Gateway + UI Server running.
 * Sidecar may be stopped to test degraded paths.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.PILOTDECK_MEDICAL_BASE || 'http://127.0.0.1:3001';

test.describe('Medical Degraded Modes', () => {
  test('health endpoint reports accurate sidecar status', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/health`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();

    // Sidecar info must be present
    expect(body.sidecar).toBeDefined();
    expect(typeof body.sidecar.available).toBe('boolean');
    expect(typeof body.sidecar.configured).toBe('boolean');

    // When sidecar is unavailable, status should be 'degraded' not 'ok'
    if (!body.sidecar.available && body.sidecar.configured) {
      expect(body.status).toBe('degraded');
    }

    // Every capability must have an `available` boolean
    for (const [name, cap] of Object.entries(body.capabilities || {})) {
      expect(typeof cap.available).toBe('boolean');
      // When unavailable, should have a reason
      if (!cap.available) {
        expect(cap.reason || cap.adapter).toBeTruthy();
      }
    }
  });

  test('M3D capability is explicitly false when not configured', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/health`);
    const body = await response.json();

    const m3d = body.capabilities?.m3d;
    expect(m3d).toBeDefined();
    // M3D is disabled by default in both presets
    expect(m3d.available).toBe(false);
  });

  test('ragCorpora capability reflects sidecar state', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/health`);
    const body = await response.json();

    const rag = body.capabilities?.ragCorpora;
    expect(rag).toBeDefined();

    if (body.sidecar?.available) {
      // Sidecar available — RAG should accurately report its state
      expect(typeof rag.available).toBe('boolean');
    } else {
      // Sidecar unavailable — RAG should be false
      expect(rag.available).toBe(false);
    }
  });

  test('error responses never leak paths, keys, or stacks', async ({ request }) => {
    // Hit an endpoint that should 400/422 with bad input
    const response = await request.post(`${BASE}/api/medical/dialogue/chat`, {
      data: { prompt: '', sessionId: '' },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);

    const body = await response.json().catch(() => ({}));
    const errorMsg = body?.error?.message || body?.message || JSON.stringify(body);

    // Must not contain path separators or secrets
    expect(errorMsg).not.toMatch(/[A-Z]:\\|\\src\\|\/home\/|api[_-]?key|sk-[A-Za-z0-9]{8,}/i);
  });

  test('model endpoint handles missing config gracefully', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/models`);

    if (response.status() === 503) {
      const body = await response.json();
      expect(body.error?.code).toBe('MEDICAL_CONFIG_UNAVAILABLE');
    }
    // Both 200 and 503 are acceptable depending on deployment config
  });
});
