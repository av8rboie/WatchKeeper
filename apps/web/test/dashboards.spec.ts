import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Dashboard, DashboardSummary, Threshold } from '@watchkeeper/shared';

const SHOTS = 'test/screenshots';
/** Test controls live on the backend port, outside ingress. */
const BACKEND = 'http://127.0.0.1:8091';
const KN = 1852 / 3600;

test.describe.configure({ mode: 'serial' });

/** Starter dashboards from the simulator's paths, created once per run. */
async function starter(request: APIRequestContext): Promise<Record<string, string>> {
  let list = (await (await request.get('api/v1/dashboards')).json()) as DashboardSummary[];
  if (list.length === 0) {
    // Wait until the backend is streaming from the simulator (device approval takes a couple of seconds).
    await expect
      .poll(async () => ((await (await request.get('api/v1/system/status')).json()) as { gps: { fix: boolean } }).gps.fix, { timeout: 30_000 })
      .toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    list = (await (await request.post('api/v1/dashboards/starter')).json()) as DashboardSummary[];
  }
  return Object.fromEntries(list.map((d) => [d.name, d.id]));
}

const getDashboard = async (request: APIRequestContext, id: string) => (await (await request.get(`api/v1/dashboards/${id}`)).json()) as Dashboard;
const sim = (request: APIRequestContext, body: object) => request.post(`${BACKEND}/__test/sim/control`, { data: body });
const tile = (page: Page, label: string) => page.locator('.widget', { has: page.locator('.widget__label', { hasText: new RegExp(`^${label}$`) }) });

async function setTheme(page: Page, theme: 'day' | 'night') {
  const html = page.locator('html');
  if ((await html.getAttribute('data-theme')) !== theme) {
    await page.getByRole('button', { name: theme === 'night' ? 'Switch to night mode' : 'Switch to day mode' }).locator('visible=true').click();
  }
  await expect(html).toHaveAttribute('data-theme', theme);
}

test('starter dashboards are built from what Signal K publishes', async ({ request }) => {
  const ids = await starter(request);
  expect(Object.keys(ids)).toEqual(['Helm', 'Engines', 'Energy', 'Anchor']);
  const helm = await getDashboard(request, ids.Helm!);
  expect(helm.widgets.map((w) => w.type)).toEqual(['wind', 'numeric', 'heading', 'numeric', 'battery', 'depth', 'numeric']);
});

test('phone helm dashboard, day and night', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  const ids = await starter(request);
  await page.goto(`d/${ids.Helm}`);
  await expect(page.getByRole('heading', { name: 'Helm' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Dashboard 1 of 4' })).toBeVisible();
  await expect(page.getByRole('img', { name: /^Wind: apparent \d+ degrees (port|starboard)$/ })).toBeVisible({ timeout: 15_000 });
  await expect(tile(page, 'SOG')).toContainText(/\d+\.\d\s*kn/);
  await expect(tile(page, 'SOG')).toContainText(/STW \d+\.\d kn/);
  await expect(tile(page, 'Heading')).toContainText(/COG \d+°T · AP wind/);
  await expect(tile(page, 'Barometer')).toContainText('hPa');
  await expect(tile(page, 'House battery')).toContainText('%');
  await expect(tile(page, 'Water temp')).toContainText('°F');
  // Two columns: SOG and Heading side by side, equal width, under the full-width wind tile.
  const [sog, hdg, wind] = await Promise.all([tile(page, 'SOG').boundingBox(), tile(page, 'Heading').boundingBox(), tile(page, 'Wind').boundingBox()]);
  expect(Math.abs(sog!.y - hdg!.y)).toBeLessThan(2);
  expect(Math.abs(sog!.width - hdg!.width)).toBeLessThan(2);
  expect(wind!.width).toBeGreaterThan(sog!.width * 1.9);
  await setTheme(page, 'day');
  await page.screenshot({ path: `${SHOTS}/phone-helm-day.png` });
  await setTheme(page, 'night');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.screenshot({ path: `${SHOTS}/phone-helm-night.png` });
  await setTheme(page, 'day');
});

test('phone: swipe moves to the next dashboard', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'phone', 'phone gesture');
  const ids = await starter(request);
  await page.goto(`d/${ids.Helm}`);
  await expect(page.getByRole('heading', { name: 'Helm' })).toBeVisible();
  await page.locator('.dashboard').evaluate((el) => {
    const t = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(320)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [t(80)], bubbles: true }));
  });
  await expect(page).toHaveURL(new RegExp(`/d/${ids.Engines}$`));
  await expect(page.getByRole('heading', { name: 'Engines' })).toBeVisible();
});

test('desktop edit mode, day and night', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop layout');
  const ids = await starter(request);
  await page.goto(`d/${ids.Engines}/edit`);
  await expect(page.getByRole('group', { name: 'Layout being edited' }).getByRole('button', { name: 'Desktop' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Editing the desktop layout of Engines' })).toContainText('Phone and Tablet layouts are untouched');
  await page.getByRole('button', { name: 'Edit Port engine RPM' }).click();
  const panel = page.getByRole('complementary', { name: 'Widget settings and path browser' });
  await expect(panel.getByRole('heading', { name: 'Widget settings' })).toBeVisible();
  await expect(panel.getByLabel('Type')).toHaveValue('gauge');
  await expect(panel.getByLabel('Label', { exact: true })).toHaveValue('Port engine RPM');
  await expect(panel.locator('.path-chip').first()).toContainText('propulsion.port.revolutions');
  await expect(panel.getByText(/Source value \d+(\.\d+)? Hz, shown as \d+ rpm/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Path browser' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Signal K paths' }).getByRole('button').first()).toBeVisible();
  await setTheme(page, 'day');
  await page.screenshot({ path: `${SHOTS}/desktop-edit-day.png` });
  await setTheme(page, 'night');
  await page.screenshot({ path: `${SHOTS}/desktop-edit-night.png` });
  await setTheme(page, 'day');
});

test('a layout edited on desktop does not change the phone layout', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop edit');
  const ids = await starter(request);
  const before = await getDashboard(request, ids.Engines!);
  await page.goto(`d/${ids.Engines}/edit`);
  const handle = page.locator('.widget-frame__handle').first();
  const box = (await handle.boundingBox())!;
  const saved = page.waitForResponse((r) => r.url().endsWith(`/dashboards/${ids.Engines}/layouts`) && r.request().method() === 'PUT');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 260, { steps: 15 });
  await page.mouse.up();
  expect((await saved).ok()).toBe(true);
  const after = await getDashboard(request, ids.Engines!);
  expect(after.layouts.desktop).not.toEqual(before.layouts.desktop);
  expect(after.layouts.phone).toEqual(before.layouts.phone);
  expect(after.layouts.tablet).toEqual(before.layouts.tablet);
});

test('two browsers: a change saved in one appears in the other within 2 s', async ({ browser, request, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'two desktop browsers');
  const ids = await starter(request);
  const viewer = await (await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })).newPage();
  const editor = await (await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })).newPage();
  await viewer.goto(`d/${ids.Helm}`);
  await expect(tile(viewer, 'SOG')).toBeVisible();
  await editor.goto(`d/${ids.Helm}/edit`);
  await editor.getByRole('button', { name: 'Edit SOG' }).click();
  const saved = editor.waitForResponse((r) => r.url().endsWith(`/dashboards/${ids.Helm}`) && r.request().method() === 'PUT');
  await editor.getByLabel('Label', { exact: true }).fill('Speed over ground');
  await saved;
  const t0 = Date.now();
  await expect(tile(viewer, 'Speed over ground')).toBeVisible({ timeout: 2000 });
  expect(Date.now() - t0).toBeLessThan(2000);
  // Put it back for the other tests and screenshots.
  const restored = editor.waitForResponse((r) => r.url().endsWith(`/dashboards/${ids.Helm}`) && r.request().method() === 'PUT');
  await editor.getByLabel('Label', { exact: true }).fill('SOG');
  await restored;
  await viewer.context().close();
  await editor.context().close();
});

test('a live value shows on the helm dashboard', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'drives the shared simulator');
  const ids = await starter(request);
  await page.goto(`d/${ids.Helm}`);
  await expect(tile(page, 'SOG')).toContainText('kn');
  await sim(request, { overrides: { 'navigation.speedOverGround': 9.87 * KN } });
  await expect(tile(page, 'SOG').locator('.tile__num')).toHaveText('9.9', { timeout: 3000 });
  await sim(request, { clear: ['navigation.speedOverGround'] });
});

test('threshold alarm: raises in the banner, acknowledge silences, snooze hides it', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'drives the shared simulator');
  const ids = await starter(request);
  // Limits for this test only; real depth limits are the skipper's to set.
  const res = await request.post('api/v1/thresholds', { data: { path: 'environment.depth.belowKeel', label: 'Depth below keel', warnLow: 3, alarmLow: 2 } });
  expect(res.status()).toBe(201);
  const threshold = (await res.json()) as Threshold;
  try {
    await page.goto(`d/${ids.Helm}`);
    await sim(request, { overrides: { 'environment.depth.belowKeel': 1.2 } });
    const banner = page.getByRole('alert').filter({ hasText: 'Depth below keel' });
    // Depth is a medium-rate path (5 s).
    await expect(banner).toContainText('below alarm limit', { timeout: 15_000 });
    await expect(tile(page, 'Depth below keel')).toHaveAttribute('data-state', 'alarm');
    await page.screenshot({ path: `${SHOTS}/desktop-alarm.png` });
    await banner.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(banner.getByRole('button', { name: 'Acknowledged' })).toBeDisabled();
    await banner.getByRole('button', { name: 'Snooze 2 min' }).click();
    await expect(banner).toBeHidden();
  } finally {
    await sim(request, { clear: ['environment.depth.belowKeel'] });
    await request.delete(`api/v1/thresholds/${threshold.id}`);
  }
});
