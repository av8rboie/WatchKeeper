import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = 'test/screenshots';
const PREFIX = process.env.INGRESS_PREFIX!;
const ORIGIN = 'http://127.0.0.1:8090';

/** The ingress proxy reads the HA user from this cookie; the default is the skipper. */
async function asHaUser(context: BrowserContext, id: string, name: string) {
  await context.addCookies([{ name: 'ha_user', value: encodeURIComponent(`${id}|${name}`), url: ORIGIN }]);
}

/** Record every same-origin request so we can check nothing escapes the ingress prefix. */
function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(ORIGIN)) urls.push(r.url());
  });
  return urls;
}

test.describe('shell under an ingress path', () => {
  test('loads, navigates and fetches only under the random prefix', async ({ page }, info) => {
    const urls = trackRequests(page);
    await page.goto('');
    await expect(page).toHaveURL(new RegExp(`${PREFIX}/d$`));
    await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-dashboards-day.png` });

    const nav = info.project.name === 'phone' ? page.locator('nav.tabbar') : page.locator('nav.sidebar');
    await nav.getByRole('link', { name: info.project.name === 'phone' ? 'Log' : 'Logbook' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}/log$`));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Logbook' })).toBeVisible();

    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u.startsWith(`${ORIGIN}${PREFIX}/`), u).toBe(true);
  });

  test('the HTML has no absolute asset paths', async ({ request }) => {
    const html = await (await request.get('')).text();
    expect(html).toContain(`<base href="${PREFIX}/">`);
    // The injected <base> is the one absolute path; every asset is relative to it.
    expect(html.replace(/<base [^>]*>/, '')).not.toMatch(/(src|href)="\/(?!\/)/);
  });

  test('bottom tabs on phone, sidebar on desktop', async ({ page }, info) => {
    await page.goto('d');
    const tabs = page.locator('nav.tabbar');
    const sidebar = page.locator('nav.sidebar');
    if (info.project.name === 'phone') {
      await expect(tabs).toBeVisible();
      await expect(sidebar).toBeHidden();
      await expect(tabs.getByRole('link')).toHaveText(['Dashboards', 'Log', 'Maintenance', 'More']);
      expect((await tabs.boundingBox())?.height).toBe(72);
    } else {
      await expect(sidebar).toBeVisible();
      await expect(tabs).toBeHidden();
      await expect(sidebar.getByRole('link')).toHaveText(['Dashboards', 'Logbook', 'Maintenance', 'Anchor watch', 'Checklists', 'Settings']);
      expect((await sidebar.boundingBox())?.width).toBe(240);
    }
  });

  test('status strip shows Data Hub, Signal K, GPS and GPS time', async ({ page }) => {
    await page.goto('d');
    const status = page.getByRole('button', { name: 'System status. Open settings.' }).locator('visible=true');
    await expect(status).toContainText('GPS fix', { timeout: 10_000 });
    await expect(status).toContainText(/\d\d:\d\d UTC/);
    await expect(status).toContainText('GPS');
    await expect(status).not.toContainText('lost');
    await status.click();
    await expect(page).toHaveURL(/\/settings#system$/);
  });

  test('night mode toggles and persists per device', async ({ page }, info) => {
    await page.goto('d');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'day');
    await page.getByRole('button', { name: 'Switch to night mode' }).locator('visible=true').click();
    await expect(html).toHaveAttribute('data-theme', 'night');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'night');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-dashboards-night.png` });
    await page.getByRole('button', { name: 'Switch to day mode' }).locator('visible=true').click();
  });
});

test.describe('roles through HA users', () => {
  test('the skipper sees role mapping with every HA user', async ({ page }) => {
    await page.goto('settings');
    const roles = page.locator('section', { has: page.getByRole('heading', { name: 'Roles' }) });
    await expect(roles).toContainText('Skipper');
    await expect(roles).toContainText('Crew');
    await expect(roles).toContainText('Helm phone');
  });

  test('a guest device elevates to crew with a helm PIN, then returns to guest', async ({ page, context }, info) => {
    await asHaUser(context, 'ha-guest', 'Helm phone');
    await page.goto('settings');
    await expect(page.getByRole('heading', { name: 'Roles' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Sign in with PIN' }).click();
    await page.getByRole('button', { name: /^Crew/ }).click();
    for (const d of '0000') await page.locator('.pin-pad').getByRole('button', { name: d, exact: true }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong PIN.');
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-helm-pin.png` });
    for (const d of '2222') await page.locator('.pin-pad').getByRole('button', { name: d, exact: true }).click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/d$/);
    await page.goto('settings');
    await expect(page.locator('.screen-head')).toContainText('acting as Crew · crew');
    await page.goto('login');
    await page.getByRole('button', { name: 'End and return to guest' }).click();
    await expect(page.getByText('Who is on watch?')).toBeVisible();
  });
});

test.describe('live values', () => {
  test('stream over the Data Hub socket and go stale within the effective timeout when Signal K is lost', async ({ page, request }, info) => {
    test.skip(info.project.name !== 'desktop', 'stops the shared fake Signal K; run once');
    await page.goto('settings');
    const row = (path: string) => page.locator('.path-row', { hasText: path });
    const sog = row('navigation.speedOverGround');
    await expect(sog).toHaveAttribute('data-stale', 'false', { timeout: 10_000 });
    await expect(sog).toContainText(/\d+\.\d kn/);
    await expect(row('propulsion.port.revolutions')).toContainText('2,178 rpm');
    // Values keep arriving: the wobble in the generated SOG changes within a few seconds.
    const first = await sog.locator('.path-row__value').textContent();
    await expect(sog.locator('.path-row__value')).not.toHaveText(first ?? '', { timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-settings.png`, fullPage: true });

    await request.post(`http://127.0.0.1:8091/__test/signalk/stop`);
    // SOG's effective timeout is 5 s; allow for the last batch and the 1 s UI tick.
    await expect(sog).toHaveAttribute('data-stale', 'true', { timeout: 8000 });
    await expect(sog).toContainText('stale');
    await expect(page.locator('nav.sidebar')).toContainText('Signal K lost', { timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-settings-stale.png`, fullPage: true });
    await request.post(`http://127.0.0.1:8091/__test/signalk/start`);
  });
});
