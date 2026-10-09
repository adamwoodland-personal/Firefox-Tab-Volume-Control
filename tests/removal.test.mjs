// Removing the extension while a page is open puts all its sound back the way it was.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  MEASURE_OUTPUT, assertNear, boostedCount, gainValues, realVolume, sendPage, sendTone, serve, setTabVolume, sleep,
  startFirefox,
} from './helpers.mjs';

describe('removing the extension', { timeout: 120_000 }, () => {
  let server;
  let firefox;
  let page;
  const real = (id) => realVolume(page.mainFrame(), `#${id}`);
  const gains = () => gainValues(page.mainFrame());

  before(async () => {
    server = await serve((req, res, { b }) => {
      if (req.url === '/tone.wav') return sendTone(req, res);
      if (req.url === '/') {
        return sendPage(res, `${MEASURE_OUTPUT}
          <audio id="plain" src="${b}/tone.wav" loop></audio>
          <audio id="boostable" src="/tone.wav" loop></audio>
          <script>
            window.ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.3;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
          </script>`);
      }
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto(`${server.a}/`);
    await page.evaluate(async () => {
      await ctx.resume();
      for (const [id, volume] of [['plain', 0.8], ['boostable', 0.5]]) {
        const el = document.getElementById(id);
        el.volume = volume;
        await el.play();
      }
    });
    // Boost (so one element is routed through Web Audio), then go silent.
    await setTabVolume(page, 200);
    await sleep(1000);
    await setTabVolume(page, 0);
    await sleep(400);
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('is silent at 0% beforehand', async () => {
    assert.equal(await boostedCount(page), 1);
    assertNear(await real('plain'), 0, 'plain real volume');
    assertNear(await gains(), 0, 'gain nodes (page context and boost)');
    assert.ok((await page.evaluate(() => outputLevels())).every((level) => level < 1e-4), 'nothing reaches the speakers');
  });

  it('restores every volume within a couple of seconds of removal', async () => {
    await firefox.uninstall();
    await sleep(3000);
    assertNear(await real('plain'), 0.8, 'plain is back at the page volume');
    assertNear(await real('boostable'), 0.5, 'the boosted one too');
    assertNear(await gains(), 1, 'every gain node');
    assert.ok((await page.evaluate(() => outputLevels())).every((level) => level > 0.01), 'Web Audio and boosted media audible again');
  });

  it('leaves the page fully working', async () => {
    assert.equal(await page.evaluate(() => {
      const el = document.getElementById('plain');
      el.volume = 0.3;
      return el.volume;
    }), 0.3);
    assertNear(await real('plain'), 0.3, 'real volume follows the page');
  });
});
