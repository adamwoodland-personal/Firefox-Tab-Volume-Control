// Web Audio: page.js's gain node in front of each AudioContext's output, and media the page
// routes through Web Audio itself.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  MEASURE_OUTPUT, assertNear, boostedCount, gainValues, realVolume, sendPage, sendTone, serve, setTabVolume, sleep,
  startFirefox,
} from './helpers.mjs';

describe('Web Audio', { timeout: 180_000 }, () => {
  let server;
  let firefox;
  let page;
  const gains = () => gainValues(page.mainFrame());
  const real = (id) => realVolume(page.mainFrame(), `#${id}`);

  before(async () => {
    server = await serve((req, res) => {
      if (req.url === '/') {
        return sendPage(res, `${MEASURE_OUTPUT}
          <audio id="el" src="/tone.wav" loop></audio>
          <audio id="el2" src="/tone.wav" loop></audio>
          <script>
            window.ctx = new AudioContext();
            window.osc = ctx.createOscillator();
            window.g = ctx.createGain();
            g.gain.value = 0.2;
            window.connectResult = osc.connect(g).connect(ctx.destination);
            osc.start();
          </script>`);
      }
      if (req.url === '/tone.wav') return sendTone(req, res);
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto(`${server.a}/`);
    await page.evaluate(() => ctx.resume());
    await sleep(300);
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('puts one gain node in front of each AudioContext output', async () => {
    assert.equal(await page.evaluate(() => ctx.state), 'running');
    assert.equal(await page.evaluate(() => connectResult === ctx.destination), true, 'connect() still returns its argument');
    assert.deepEqual(await gains(), [1]);
  });

  it('sets it to the tab volume, boost included', async () => {
    await setTabVolume(page, 30);
    await sleep(300);
    assertNear(await gains(), 0.3, 'at 30%');
    await setTabVolume(page, 250);
    await sleep(300);
    assertNear(await gains(), 2.5, 'at 250%');
  });

  it('covers contexts created later', async () => {
    await page.evaluate(() => {
      window.ctx2 = new AudioContext();
      ctx2.createOscillator().connect(ctx2.destination);
    });
    assert.deepEqual(await gains(), [2.5, 2.5]);
  });

  it("keeps Web Audio's own behaviour", async () => {
    const result = await page.evaluate(() => {
      const errorName = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.name; } };
      const offline = new OfflineAudioContext(1, 128, 44100);
      offline.createOscillator().connect(offline.destination);
      return {
        crossContext: errorName(() => osc.connect(ctx2.destination)),
        reconnect: errorName(() => { g.disconnect(ctx.destination); g.connect(ctx.destination); }),
        notConnected: errorName(() => ctx.createGain().disconnect(ctx.destination)),
        gainNodesAfterOfflineContext: window.__tvcMasters.size,
      };
    });
    assert.deepEqual(result, {
      crossContext: 'InvalidAccessError',
      reconnect: 'ok',
      notConnected: 'InvalidAccessError',
      gainNodesAfterOfflineContext: 2, // offline rendering isn't touched
    });
  });

  it('leaves media the page plays through Web Audio to the gain node', async () => {
    await setTabVolume(page, 50);
    await page.evaluate(async () => {
      const el = document.getElementById('el');
      el.volume = 0.8;
      await el.play();
    });
    await sleep(300);
    assertNear(await real('el'), 0.4, 'before the page routes it');
    await page.evaluate(() => ctx.createMediaElementSource(document.getElementById('el')).connect(ctx.destination));
    await sleep(200);
    assertNear(await real('el'), 0.8, 'after: the gain node applies the 50% instead');
    assert.equal(await page.evaluate(() => document.getElementById('el').volume), 0.8);
    assertNear(await gains(), 0.5, 'gain nodes');
  });

  it('stops its own boost when the page also routes boosted media through Web Audio', async () => {
    await setTabVolume(page, 200);
    await page.evaluate(async () => {
      const el2 = document.getElementById('el2');
      el2.volume = 0.5;
      await el2.play();
    });
    await sleep(800);
    assert.equal(await boostedCount(page), 1, 'boosted by the extension');
    assertNear(await real('el2'), 0.5, 'keeps the page volume');
    await page.evaluate(() => ctx.createMediaElementSource(document.getElementById('el2')).connect(ctx.destination));
    await sleep(200);
    // Firefox lets an element feed several graphs at once; ours must stop or it plays twice.
    assert.equal(await boostedCount(page), 0, 'extension disconnected its own path');
    assertNear(await real('el2'), 0.5, 'still at the page volume');
  });

  it('controls what actually reaches the speakers', async () => {
    // Firefox's "playing" flag can't tell here: it counts playing elements even when their
    // sound only goes into Web Audio. So measure the signal itself.
    const loudest = async () => Math.max(...await page.evaluate(() => outputLevels()));
    await setTabVolume(page, 100);
    await sleep(300);
    const full = await loudest();
    assert.ok(full > 0.05, `signal at 100%: ${full}`);
    await setTabVolume(page, 50);
    await sleep(300);
    assertNear((await loudest()) / full, 0.5, 'at 50%, relative to 100%', 0.05);
    await setTabVolume(page, 0);
    await sleep(500);
    assert.ok((await loudest()) < 1e-4, 'silent at 0%');
  });
});
