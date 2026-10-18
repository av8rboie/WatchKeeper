import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test/screenshots';

async function login(page: Page, name: string, pin: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  for (const d of pin) await page.locator('.pin-pad').getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page).toHaveURL(/\/d$/);
}

test.describe('shell', () => {
  test('login with the PIN pad lands on dashboards', async ({ page }, info) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /^Skipper/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-login.png` });
    await login(page, 'Skipper', '1111');
    await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
  });

  test('a wrong PIN is refused', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /^Crew/ }).click();
    for (const d of '0000') await page.locator('.pin-pad').getByRole('button', { name: d, exact: true }).click();
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong PIN.');
  });

  test('bottom tabs on phone, sidebar on desktop', async ({ page }, info) => {
    await login(page, 'Skipper', '1111');
    const tabs = page.locator('nav.tabbar');
    const sidebar = page.locator('nav.sidebar');
    if (info.project.name === 'phone') {
      await expect(tabs).toBeVisible();
      await expect(sidebar).toBeHidden();
      await expect(tabs.getByRole('link')).toHaveText(['Dashboards', 'Log', 'Maintenance', 'More']);
      const box = await tabs.boundingBox();
      expect(box?.height).toBe(72);
    } else {
      await expect(sidebar).toBeVisible();
      await expect(tabs).toBeHidden();
      await expect(sidebar.getByRole('link')).toHaveText(['Dashboards', 'Logbook', 'Maintenance', 'Anchor watch', 'Checklists', 'Settings']);
      expect((await sidebar.boundingBox())?.width).toBe(240);
    }
    await expect(page.getByRole('link', { name: 'Dashboards' }).locator('visible=true')).toHaveAttribute('aria-current', 'page');
  });

  test('status strip shows Signal K, GPS and UTC', async ({ page }) => {
    await login(page, 'Skipper', '1111');
    const status = page.getByRole('button', { name: 'System status. Open settings.' }).locator('visible=true');
    await expect(status).toContainText('Signal K');
    await expect(status).toContainText('GPS fix', { timeout: 10_000 });
    await expect(status).toContainText(/\d\d:\d\d UTC/);
    await status.click();
    await expect(page).toHaveURL(/\/settings#system$/);
  });

  test('night mode toggles and persists per device', async ({ page }, info) => {
    await login(page, 'Skipper', '1111');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'day');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-dashboards-day.png` });
    await page.getByRole('button', { name: 'Switch to night mode' }).locator('visible=true').click();
    await expect(html).toHaveAttribute('data-theme', 'night');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'night');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-dashboards-night.png` });
    await page.getByRole('button', { name: 'Switch to day mode' }).locator('visible=true').click();
    await expect(html).toHaveAttribute('data-theme', 'day');
  });

  test('guests see no user management', async ({ page }) => {
    await login(page, 'Guest', '3333');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users' })).toHaveCount(0);
  });

  test('PWA manifest and icons are served', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons as { src: string }[]) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
    expect((await request.get('/sw.js')).ok()).toBe(true);
  });
});

test.describe('path browser', () => {
  test('lists live values and every path goes stale when Signal K is lost', async ({ page, request }, info) => {
    test.skip(info.project.name !== 'desktop', 'stops the shared fake Signal K; run once');
    await login(page, 'Skipper', '1111');
    await page.goto('/settings');
    const row = (path: string) => page.locator('.path-row', { hasText: path });
    await expect(row('navigation.speedOverGround')).toContainText(/\d+\.\d kn/, { timeout: 10_000 });
    await expect(row('propulsion.port.revolutions')).toContainText('2,178 rpm');
    await expect(row('navigation.speedOverGround')).toHaveAttribute('data-stale', 'false');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-settings.png`, fullPage: true });

    await request.post('/__test/signalk/stop');
    // Disconnect marks everything stale at once; well inside the 5 s SOG timeout.
    await expect(row('navigation.speedOverGround')).toHaveAttribute('data-stale', 'true', { timeout: 5000 });
    await expect(row('navigation.speedOverGround')).toContainText('stale');
    await expect(page.locator('.path-row[data-stale="false"]')).toHaveCount(0);
    await expect(page.locator('nav.sidebar')).toContainText('Signal K lost', { timeout: 7000 });
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-settings-stale.png`, fullPage: true });
    await request.post('/__test/signalk/start');
  });
});
