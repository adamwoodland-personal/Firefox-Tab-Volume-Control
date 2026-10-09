// <audio> and <video>: turning down, boosting, and keeping the page's own volume intact.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertNear, boostedCount, gainValues, realVolume, sendPage, sendTone, serve, setTabVolume, sleep, startFirefox,
} from './helpers.mjs';

describe('audio and video elements', { timeout: 180_000 }, () => {
  let server;
  let firefox;
  let page;
  const pageVolumes = () => page.evaluate(() => Object.fromEntries(all().map((el) => [el.id, el.volume])));
  const real = (id) => realVolume(page.mainFrame(), `#${id}`);

  before(async () => {
    server = await serve((req, res, { b }) => {
      if (req.url === '/') {
        return sendPage(res, `
          <audio id="same" src="/tone.wav" loop></audio>
          <audio id="cross" src="${b}/tone.wav" loop></audio>
          <audio id="redirect" src="/redirect.wav" loop></audio>
          <audio id="cors" src="${b}/cors/tone.wav" crossorigin="anonymous" loop></audio>
          <script>
            window.volumeChanges = {};
            window.detached = new Audio('/tone.wav');
            detached.id = 'detached';
            detached.loop = true;
            window.all = () => [...document.querySelectorAll('audio'), detached];
            for (const el of all()) el.addEventListener('volumechange', () => { volumeChanges[el.id] = (volumeChanges[el.id] ?? 0) + 1; });
          </script>`);
      }
      if (req.url === '/tone.wav') return sendTone(req, res);
      if (req.url === '/cors/tone.wav') return sendTone(req, res, { 'access-control-allow-origin': '*' });
      if (req.url === '/redirect.wav') return res.writeHead(302, { location: `${b}/tone.wav` }).end();
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto(`${server.a}/`);
    await page.evaluate(async () => {
      for (const el of all()) el.volume = 0.3;
      await Promise.all(all().map((el) => el.play()));
    });
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('turns every element down while the page keeps seeing its own volume', async () => {
    assert.equal(await setTabVolume(page, 50), true);
    await sleep(400);
    for (const id of ['same', 'cross', 'redirect', 'cors']) {
      assertNear(await real(id), 0.15, `${id} real volume`);
    }
    assert.deepEqual(Object.values(await pageVolumes()), [0.3, 0.3, 0.3, 0.3, 0.3]);
    // An element outside the document: its real volume changed, so it fired volumechange.
    assert.ok(await page.evaluate(() => volumeChanges.detached >= 1));
  });

  it('follows the page changing its own volume', async () => {
    await page.evaluate(() => { document.getElementById('same').volume = 0.6; });
    await sleep(100);
    assert.equal((await pageVolumes()).same, 0.6);
    assertNear(await real('same'), 0.3, 'same real volume');
    await page.evaluate(() => { document.getElementById('same').volume = 0.3; });
  });

  it('boosts media that Web Audio may read, and only that', async () => {
    await setTabVolume(page, 200);
    await sleep(800); // the same-origin check and the boost context starting
    // Boosted media keeps the page's volume; page.js's gain node does the boosting.
    assertNear(await real('same'), 0.3, 'same-origin');
    assertNear(await real('cors'), 0.3, 'cross-origin with CORS');
    assertNear(await boostedCount(page), 3, 'boosted elements (same, cors, detached)');
    assertNear(await gainValues(page.mainFrame()), 2, 'boost gain');
    // Web Audio would only get silence from these, so they just go up to full volume.
    assertNear(await real('cross'), 0.6, 'cross-origin without CORS');
    assertNear(await real('redirect'), 0.6, 'same-origin URL redirecting to another origin');
    assert.deepEqual(Object.values(await pageVolumes()), [0.3, 0.3, 0.3, 0.3, 0.3]);
    assert.ok(await page.evaluate(() => all().every((el) => !el.paused && el.currentTime > 0)), 'all still playing');
  });

  it('lets the page change the volume of boosted media', async () => {
    const before = await page.evaluate(() => volumeChanges.same ?? 0);
    await page.evaluate(() => { document.getElementById('same').volume = 0.5; });
    await sleep(100);
    assert.equal((await pageVolumes()).same, 0.5);
    assertNear(await real('same'), 0.5, 'same real volume');
    assert.ok(await page.evaluate((before) => volumeChanges.same > before, before), 'volumechange fired');
  });

  it('puts everything back at 100%', async () => {
    await setTabVolume(page, 100);
    await sleep(300);
    assertNear(await real('cross'), 0.3, 'cross real volume');
    assertNear(await gainValues(page.mainFrame()), 1, 'boost gain');
    assert.equal((await pageVolumes()).same, 0.5);
  });

  it("keeps the browser's own errors and return values", async () => {
    const result = await page.evaluate(() => {
      const el = document.getElementById('same');
      const errorName = (fn) => { try { fn(); return 'no error'; } catch (e) { return e.name; } };
      return {
        outOfRange: errorName(() => { el.volume = 2; }),
        notANumber: errorName(() => { el.volume = NaN; }),
        wrongThis: errorName(() => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get.call({})),
        playReturnsPromise: el.play() instanceof Promise,
      };
    });
    assert.deepEqual(result, { outOfRange: 'IndexSizeError', notANumber: 'TypeError', wrongThis: 'TypeError', playReturnsPromise: true });
  });

  it('applies to elements added later', async () => {
    await setTabVolume(page, 50);
    await sleep(300);
    await page.evaluate(async () => {
      const el = document.createElement('audio');
      el.id = 'late';
      el.src = '/tone.wav';
      el.loop = true;
      el.volume = 0.8;
      document.body.append(el);
      await el.play();
    });
    await sleep(200);
    assert.equal(await page.evaluate(() => document.getElementById('late').volume), 0.8);
    assertNear(await real('late'), 0.4, 'late real volume');
  });

  it('keeps the tab volume when the page reloads', async () => {
    await page.reload();
    await page.evaluate(async () => {
      const el = document.getElementById('cross');
      el.volume = 0.6;
      await el.play();
    });
    await sleep(300);
    assert.equal((await pageVolumes()).cross, 0.6);
    assertNear(await real('cross'), 0.3, 'cross real volume');
  });

  it('leaves the page working after the extension is removed', async () => {
    await firefox.uninstall();
    const result = await page.evaluate(async () => {
      const el = document.getElementById('cross');
      el.volume = 0.7;
      el.pause();
      await el.play();
      return { volume: el.volume, playing: !el.paused };
    });
    assert.deepEqual(result, { volume: 0.7, playing: true });
    assertNear(await real('cross'), 0.7, 'cross real volume');
  });
});
