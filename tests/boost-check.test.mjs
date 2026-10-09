// Deciding whether same-origin media can be boosted: the check page.js makes for it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNear, realVolume, sendPage, sendTone, serve, setTabVolume, sleep, startFirefox } from './helpers.mjs';

// At 200% with the page at 0.3, a boosted element keeps its real volume at 0.3 (the boost
// happens in Web Audio), while an element that can't be boosted goes to 0.6.
const BOOSTED = 0.3;
const NOT_BOOSTED = 0.6;

describe('boost check', { timeout: 120_000 }, () => {
  let server;
  let firefox;
  let flakyChecks = 0;

  async function playAt200(path) {
    const page = await firefox.browser.newPage();
    await page.goto(`${server.a}${path}`);
    await page.evaluate(async () => {
      for (const el of document.querySelectorAll('audio')) {
        el.volume = 0.3;
        await el.play();
      }
    });
    await setTabVolume(page, 200);
    await sleep(800);
    return page;
  }

  before(async () => {
    server = await serve((req, res) => {
      if (req.url === '/head-not-allowed.wav') return req.method === 'HEAD' ? res.writeHead(405).end() : sendTone(req, res);
      if (req.url === '/flaky.wav') {
        // The extension's check asks for one byte; fail the first one.
        if (req.headers.range === 'bytes=0-0' && flakyChecks++ === 0) return res.writeHead(503).end();
        return sendTone(req, res);
      }
      if (req.url === '/tone.wav') return sendTone(req, res);
      if (req.url === '/head') return sendPage(res, '<audio id="h" src="/head-not-allowed.wav" loop></audio>');
      if (req.url === '/flaky') return sendPage(res, '<audio id="f" src="/flaky.wav" loop></audio>');
      if (req.url === '/csp') {
        return sendPage(res, '<audio id="c" src="/tone.wav" loop></audio>', {
          'content-security-policy': "default-src 'self'; connect-src 'none'; script-src 'unsafe-inline'",
        });
      }
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it("boosts media from a server that doesn't support HEAD requests", async () => {
    const page = await playAt200('/head');
    assertNear(await realVolume(page.mainFrame(), '#h'), BOOSTED, 'real volume');
    await page.close();
  });

  it('retries a check that failed', async () => {
    const page = await playAt200('/flaky');
    assertNear(await realVolume(page.mainFrame(), '#f'), NOT_BOOSTED, 'after the failed check');
    await sleep(4000); // first retry after 3 s
    assertNear(await realVolume(page.mainFrame(), '#f'), BOOSTED, 'after the retry');
    await page.close();
  });

  it("doesn't boost when the site's CSP blocks the check, but keeps it playing", async () => {
    const page = await playAt200('/csp');
    assertNear(await realVolume(page.mainFrame(), '#c'), NOT_BOOSTED, 'real volume');
    assert.equal(await page.evaluate(() => !document.getElementById('c').paused), true);
    await page.close();
  });
});
