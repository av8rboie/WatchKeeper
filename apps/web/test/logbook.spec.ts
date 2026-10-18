import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { LogEntry, Passage } from '@watchkeeper/shared';

const SHOTS = 'test/screenshots';
const ORIGIN = 'http://127.0.0.1:8090';
/** Test controls live on the backend port, outside ingress. */
const BACKEND = 'http://127.0.0.1:8091';

test.describe.configure({ mode: 'serial' });

async function waitForData(request: APIRequestContext) {
  await expect
    .poll(async () => ((await (await request.get('api/v1/system/status')).json()) as { gps: { fix: boolean } }).gps.fix, { timeout: 30_000 })
    .toBe(true);
}

/** The passage under way, started through the API if a previous test didn't. */
async function passage(request: APIRequestContext): Promise<Passage> {
  const active = (await (await request.get('api/v1/passages/active')).json()) as { passage: Passage | null };
  if (active.passage) return active.passage;
  await waitForData(request);
  return (await (await request.post('api/v1/passages', { data: { name: 'Norfolk to Bermuda', fromPlace: 'Norfolk', toPlace: 'Bermuda' } })).json()) as Passage;
}

const entry = (request: APIRequestContext, data: object) => request.post(`${BACKEND}/__test/log/entry`, { data });

async function setTheme(page: Page, theme: 'day' | 'night') {
  const html = page.locator('html');
  if ((await html.getAttribute('data-theme')) !== theme) {
    await page.getByRole('button', { name: theme === 'night' ? 'Switch to night mode' : 'Switch to day mode' }).locator('visible=true').click();
  }
  await expect(html).toHaveAttribute('data-theme', theme);
}

test('phone: start a passage, quick entry, timeline, day and night', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  await waitForData(request);
  await page.goto('log');
  await expect(page.getByRole('heading', { name: 'Logbook' })).toBeVisible();
  const active = (await (await request.get('api/v1/passages/active')).json()) as { passage: Passage | null };
  if (!active.passage) {
    await expect(page.getByText('No passage under way')).toBeVisible();
    await page.getByRole('button', { name: 'Start passage' }).click();
    await page.getByLabel('From').fill('Norfolk');
    await page.getByLabel('To', { exact: true }).fill('Bermuda');
    await page.getByRole('button', { name: 'Start passage' }).click();
  }
  await expect(page.getByText('Norfolk to Bermuda · Day 1')).toBeVisible();
  await expect(page.locator('.log-stats')).toContainText('Run');
  await expect(page.locator('.log-stats')).toContainText('Avg SOG');

  // What the scheduler and a trigger would have written by now.
  await entry(request, { kind: 'hourly' });
  await entry(request, { kind: 'event', eventType: 'pressure_drop', remarks: 'Barometer down 2.4 hPa in 3 h. Threshold 2.0 hPa.' });
  await page.reload();
  const hourly = page.getByRole('link', { name: /HOURLY, unsigned$/ });
  await expect(hourly).toBeVisible();
  await expect(hourly).toContainText('UNSIGNED');
  await expect(hourly).toContainText(/\d+°\d+\.\d′N \d+°\d+\.\d′W · COG \d+°T · SOG \d+\.\d kn/);
  await expect(hourly).toContainText(/TWS \d+ kn from \d+°T · \d+ hPa/);
  // The amber UNSIGNED border (the phone's pixel ratio rounds its width, so check the color).
  await expect(hourly.locator('.log-card')).toHaveCSS('border-top-color', 'rgb(154, 83, 0)');
  await expect(page.getByRole('link', { name: /EVENT · PRESSURE/ })).toContainText('Barometer down 2.4 hPa in 3 h');

  // Quick entry.
  await page.getByRole('link', { name: 'Quick entry' }).click();
  await expect(page.getByRole('heading', { name: 'Quick entry' })).toBeVisible();
  await expect(page.locator('.qe-captured')).toContainText(/SOG \d+\.\d kn/, { timeout: 10_000 });
  await expect(page.locator('.qe-captured')).toContainText(/Port eng (on|off) · Stbd eng (on|off)/);
  await page.getByRole('button', { name: 'Reef in' }).click();
  await page.getByRole('button', { name: '1–2 m' }).click();
  await page.getByLabel('Notes').fill('First reef in the main ahead of the front. All good.');
  await expect(page.getByRole('button', { name: 'Reef in' })).toHaveAttribute('aria-pressed', 'true');
  await setTheme(page, 'day');
  await page.screenshot({ path: `${SHOTS}/phone-quick-entry-day.png` });
  await page.getByRole('button', { name: 'Save to log' }).click();

  await expect(page).toHaveURL(/\/log$/);
  const manual = page.getByRole('link', { name: /MANUAL · REEF IN/ });
  await expect(manual).toContainText('First reef in the main ahead of the front.');
  await expect(manual).toContainText('Sea 1–2 m');
  await expect(page.getByRole('button', { name: /^Unsigned \d+$/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phone-logbook-day.png` });
  await setTheme(page, 'night');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.screenshot({ path: `${SHOTS}/phone-logbook-night.png` });
  await setTheme(page, 'day');

  // Filters.
  await page.getByRole('button', { name: 'Hourly', exact: true }).click();
  await expect(page.getByRole('link', { name: /MANUAL · REEF IN/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /HOURLY/ }).first()).toBeVisible();
});

test('sign and amend: the original stays visible with the reason', async ({ page, request }) => {
  await passage(request);
  const list = (await (await request.get('api/v1/log?kind=hourly&unsigned=true')).json()) as LogEntry[];
  const target = list[0] ?? ((await (await entry(request, { kind: 'hourly', minutesAgo: 120 })).json()) as LogEntry);
  await page.goto(`log/${target.id}`);
  await expect(page.getByText('Not signed yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign entry' }).click();
  await expect(page.getByText(/^Signed by Skipper at \d\d:\d\d UTC/)).toBeVisible();

  await page.getByRole('button', { name: 'Amend' }).click();
  await page.getByLabel('Field').selectOption({ label: 'Sea state' });
  await page.getByLabel('New value').fill('2–3 m');
  await expect(page.getByLabel('Reason')).toHaveValue('');
  await page.getByRole('button', { name: 'Save amendment' }).click();
  await expect(page.getByRole('alert')).toHaveText('Give a reason for the change.');
  await page.getByLabel('Reason').fill('Building faster than forecast');
  await page.getByRole('button', { name: 'Save amendment' }).click();

  const amendments = page.locator('section', { has: page.getByRole('heading', { name: 'Amendments' }) });
  await expect(amendments).toContainText('Sea state:');
  await expect(amendments).toContainText('2–3 m');
  await expect(amendments).toContainText('Reason: Building faster than forecast. Skipper');
  await expect(amendments.locator('.amended-old')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(page.getByText('SIGNED · AMENDED')).toBeVisible();
  if (test.info().project.name === 'desktop') await page.screenshot({ path: `${SHOTS}/desktop-entry-detail.png`, fullPage: true });
});

test('passage summary exports PDF, CSV and GPX', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'downloads on desktop');
  const p = await passage(request);
  await page.goto(`passages/${p.id}`);
  await expect(page.getByRole('heading', { name: p.name })).toBeVisible();
  await expect(page.locator('.log-stats')).toContainText('Entries');
  for (const ext of ['PDF', 'CSV', 'GPX']) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: ext, exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`Norfolk-to-Bermuda\\.${ext.toLowerCase()}$`));
    const chunks = (await (await download.createReadStream()).toArray()) as Buffer[];
    const body = Buffer.concat(chunks);
    if (ext === 'PDF') expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    if (ext === 'CSV') expect(body.toString('utf8')).toMatch(/^\ufefftime_utc,kind,event,clock_source,lat \(deg\)/);
    if (ext === 'GPX') expect(body.toString('utf8')).toContain('<gpx version="1.1"');
  }
});

test('passage suggestion prompts but never acts on its own', async ({ page, request }) => {
  const p = await passage(request);
  await page.goto('log');
  await expect(page.getByRole('heading', { name: 'Logbook' })).toBeVisible();
  await request.post(`${BACKEND}/__test/log/suggest`, { data: { kind: 'end', reason: 'Anchor down' } });
  const strip = page.locator('.suggest-strip');
  await expect(strip).toContainText('Anchor down. End the passage Norfolk to Bermuda?');
  await strip.getByRole('button', { name: 'Not now' }).click();
  await expect(strip).toHaveCount(0);
  const still = (await (await request.get('api/v1/passages/active')).json()) as { passage: Passage | null };
  expect(still.passage?.id).toBe(p.id);
});

test('guests see that the logbook is for crew', async ({ page, context }) => {
  await context.addCookies([{ name: 'ha_user', value: encodeURIComponent('ha-guest|Helm phone'), url: ORIGIN }]);
  await page.goto('log');
  await expect(page.getByText('The logbook is for crew.')).toBeVisible();
  await context.clearCookies();
});

test('ending the passage stops the hourly log', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'run once, last');
  const p = await passage(request);
  await page.goto(`passages/${p.id}`);
  await page.getByRole('button', { name: 'End passage' }).click();
  await page.getByRole('button', { name: 'End passage' }).click();
  await expect(page.getByText(/Day \d+ · ended/)).toBeVisible();
  await page.goto('log');
  await expect(page.getByText('No passage under way')).toBeVisible();
  await expect(page.getByRole('link', { name: /EVENT · PASSAGE END/ }).first()).toBeVisible();
});
