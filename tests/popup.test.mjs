// The popup's own code, run as a web page with the extension APIs mocked. (Firefox's
// automation can't open a real extension popup.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROOT, serve, sleep, startFirefox } from './helpers.mjs';

// Three tabs: the current one at 150%, one Firefox doesn't let extensions into, and one
// whose volume changes stop working (its page navigated somewhere restricted).
const MOCK = `
const tabs = [
  { id: 1, windowId: 1, title: 'Current tab', url: 'https://example.com/watch', audible: true, mutedInfo: { muted: false }, lastAccessed: 3 },
  { id: 2, windowId: 1, title: 'Add-ons Manager', url: 'about:addons', audible: true, mutedInfo: { muted: false }, lastAccessed: 2 },
  { id: 3, windowId: 1, title: 'Podcast', url: 'https://podcasts.example.com/42', audible: true, mutedInfo: { muted: false }, lastAccessed: 1 },
];
window.sent = [];
window.browser = {
  runtime: {
    async sendMessage(message) {
      sent.push(message);
      if (message.type === 'take-popup-target') return null;
      if (message.type === 'probe') return message.tabId !== 2;
      if (message.type === 'set-volume') return message.tabId !== 3;
      return true;
    },
  },
  tabs: { query: async (q) => (q.active ? [tabs[0]] : tabs), update: async () => {}, onUpdated: { addListener() {} } },
  windows: { update: async () => {} },
  storage: { session: { get: async () => ({ 'volume:1': 150 }) } },
  commands: { getAll: async () => [{ name: '_execute_action', shortcut: 'Alt+Shift+V' }] },
};`;

describe('popup', { timeout: 120_000 }, () => {
  let server;
  let firefox;
  let page;
  const pageErrors = [];
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.row')].map((row) => ({
    title: row.querySelector('.tab-title').textContent,
    disabled: row.classList.contains('unsupported') && row.querySelector('.slider').disabled,
    tooltip: Boolean(row.title),
  })));
  const status = () => page.evaluate(() => document.querySelector('#current .status').textContent);
  const sentVolumes = (tabId) => page.evaluate((tabId) =>
    sent.filter((m) => m.type === 'set-volume' && m.tabId === tabId).map((m) => m.volume), tabId);

  before(async () => {
    server = await serve((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/mock.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(MOCK);
      const file = path.join(ROOT, url.pathname);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
      let body = fs.readFileSync(file);
      if (url.pathname === '/popup/popup.html') {
        body = body.toString().replace('<script src="../shared.js">', '<script src="/mock.js"></script>\n<script src="../shared.js">');
      }
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)];
      res.writeHead(200, { 'content-type': type }).end(body);
    });
    firefox = await startFirefox({ install: false });
    page = await firefox.browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${server.a}/popup/popup.html`);
    await sleep(500);
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('shows the current tab and its volume', async () => {
    const shown = await page.evaluate(() => ({
      title: document.querySelector('#current .tab-title').textContent,
      readout: document.querySelector('.readout-input').value,
      pressed: document.querySelector('.preset[aria-pressed="true"]')?.value,
    }));
    assert.deepEqual(shown, { title: 'Current tab', readout: '150', pressed: '150' });
    assert.equal(await status(), 'Boosted');
  });

  it('checks every tab it lists and disables the ones Firefox keeps extensions out of', async () => {
    assert.deepEqual(await page.evaluate(() => sent.filter((m) => m.type === 'probe').map((m) => m.tabId).sort()), [1, 2, 3]);
    assert.deepEqual(await rows(), [
      { title: 'Add-ons Manager', disabled: true, tooltip: true },
      { title: 'Podcast', disabled: false, tooltip: false },
    ]);
    assert.equal(await page.evaluate(() => document.querySelector('#current .notice').hidden), true);
  });

  it('disables a row once a change to it fails', async () => {
    await page.evaluate(() => {
      const slider = document.querySelectorAll('.row')[1].querySelector('.slider');
      slider.value = 250; // a quarter of the way: 50%
      slider.dispatchEvent(new Event('input'));
    });
    await sleep(300);
    assert.deepEqual(await sentVolumes(3), [50]);
    assert.equal((await rows())[1].disabled, true);
  });

  it('sends preset and keyboard changes, with 0% labelled Silent rather than Muted', async () => {
    await page.evaluate(() => document.querySelector('.preset[value="0"]').click());
    await sleep(100);
    assert.equal(await status(), 'Silent');
    await page.evaluate(() => {
      const slider = document.querySelector('#current .slider');
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    await sleep(100);
    assert.deepEqual(await sentVolumes(1), [0, 5]);
    assert.equal(await page.evaluate(() => document.querySelector('.readout-input').value), '5');
  });

  it('raises no errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
