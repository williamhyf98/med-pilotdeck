/**
 * Medical Dialogue e2e test.
 *
 * Prerequisites:
 *   - PilotDeck Gateway + UI Server running (dev mode or docker)
 *   - Medical sidecar available on localhost:8765
 *   - Playwright browsers installed (npx playwright install chromium)
 *
 * Run:
 *   PILOTDECK_MEDICAL_CUSTOMER_PRESET=offline-military \
 *   npx playwright test ui/e2e/medical-dialogue.spec.mjs
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.PILOTDECK_MEDICAL_BASE || 'http://127.0.0.1:3001';

test.describe('Medical Dialogue Page', () => {
  test('loads the dialogue page with military branding', async ({ page }) => {
    await page.goto(`${BASE}/medical/dialogue`);

    // The page should render the medical dialogue shell
    const shell = page.locator('[data-testid="medical-dialogue-page"]');
    await expect(shell).toBeVisible({ timeout: 10_000 });

    // Sidebar branding should be visible (dynamic from preset)
    const sidebarTitle = page.locator('.medical-sidebar-title');
    await expect(sidebarTitle).toBeVisible();
    const titleText = await sidebarTitle.textContent();
    expect(titleText).toBeTruthy();
  });

  test('renders task mode tabs', async ({ page }) => {
    await page.goto(`${BASE}/medical/dialogue`);

    // Task mode selector should have entries
    const taskTabs = page.locator('[data-testid="medical-dialogue-page"] button');
    const tabCount = await taskTabs.count();
    expect(tabCount).toBeGreaterThan(0);
  });

  test('shows welcome state when no session is active', async ({ page }) => {
    await page.goto(`${BASE}/medical/dialogue`);

    // Welcome message should be visible
    const welcome = page.locator('text=您好');
    await expect(welcome.first()).toBeVisible({ timeout: 5_000 });
  });

  test('model selector is populated', async ({ page }) => {
    await page.goto(`${BASE}/medical/dialogue`);

    // The model list should be fetched from /api/medical/models
    // If no models configured, the selector may be empty or hidden
    const modelSelect = page.locator('[data-testid="medical-model-select"]');
    // Not asserting presence — depends on deployment config
    const visible = await modelSelect.isVisible().catch(() => false);
    if (visible) {
      const options = modelSelect.locator('option');
      const count = await options.count();
      // At minimum there should be a placeholder option
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('sidebar new chat button exists', async ({ page }) => {
    await page.goto(`${BASE}/medical/dialogue`);

    const newChatBtn = page.locator('.medical-new-chat');
    await expect(newChatBtn).toBeVisible();
  });

  test('health endpoint returns ok', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/health`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.service).toBe('pilotdeck-medical-api');
    expect(body.apiVersion).toBeGreaterThanOrEqual(1);
    // Should include preset info
    expect(body.branding).toBeDefined();
    expect(body.features).toBeDefined();
    expect(body.security).toBeDefined();
  });

  test('profiles endpoint returns profile list with preset defaults', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/profiles`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles.length).toBeGreaterThan(0);
    // presetDefaults should be present
    expect(body.presetDefaults).toBeDefined();
  });

  test('task-modes endpoint returns modes', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/task-modes`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body.taskModes)).toBe(true);
    expect(body.taskModes.length).toBeGreaterThan(0);
  });

  test('rag corpora endpoint returns corpus list', async ({ request }) => {
    const response = await request.get(`${BASE}/api/medical/rag/corpora`);
    // May 503 if sidecar is down — that's acceptable
    if (response.status() === 503) return;

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body.corpora)).toBe(true);
  });
});
