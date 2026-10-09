// Frames: data:, blob: and about:blank frames, and tabs that were open before installing.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertNear, framesWithScripts, gainValues, realVolume, sendPage, sendTone, serve, setTabVolume, setTabVolumeByUrl,
  sleep, startFirefox,
} from './helpers.mjs';

describe('frames', { timeout: 180_000 }, () => {
  let server;
  let firefox;

  before(async () => {
    server = await serve((req, res, { a }) => {
      if (req.url === '/tone.wav') return sendTone(req, res);
      if (req.url === '/blank') return sendPage(res, '');
      if (req.url === '/frames') {
        return sendPage(res, `
          <iframe src="data:text/html,<audio src='${a}/tone.wav' loop autoplay></audio>"></iframe>
          <script>
            const blob = new Blob(['<audio src="${a}/tone.wav" loop autoplay></audio>'], { type: 'text/html' });
            const blobFrame = document.createElement('iframe');
            blobFrame.src = URL.createObjectURL(blob);
            document.body.append(blobFrame);
            // An empty frame, used straight away.
            const blank = document.createElement('iframe');
            document.body.append(blank);
            const w = blank.contentWindow;
            window.blankContext = new w.AudioContext();
            const osc = blankContext.createOscillator();
            osc.connect(blankContext.destination);
            osc.start();
            window.blankAudio = w.document.createElement('audio');
            blankAudio.src = '/tone.wav';
            blankAudio.loop = true;
            w.document.body.append(blankAudio);
            blankAudio.volume = 0.8;
          </script>`);
      }
      if (req.url === '/srcdoc') {
        return sendPage(res, `<script>
          // A srcdoc frame used in the same task, before Firefox has set it up.
          const frame = document.createElement('iframe');
          frame.srcdoc = 'x';
          document.body.append(frame);
          window.patched = Object.hasOwn(frame.contentWindow.HTMLMediaElement.prototype, Symbol.for('tab-volume-control'));
        </script>`);
      }
      if (req.url === '/old') return sendPage(res, '<audio id="top" src="/tone.wav" loop autoplay></audio><iframe src="/child"></iframe>');
      if (req.url === '/child') return sendPage(res, '<audio id="inner" src="/tone.wav" loop autoplay></audio>');
      res.writeHead(404).end();
    });
    firefox = await startFirefox({ install: false });
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('covers a tab that was open before the extension was installed, child frames included', async () => {
    const old = await firefox.browser.newPage();
    await old.goto(`${server.a}/old`);
    await sleep(800);
    await firefox.install();
    const controller = await firefox.browser.newPage();
    await controller.goto(`${server.a}/blank`);
    assert.equal(await setTabVolumeByUrl(controller, `${server.a}/old`, 50), true);
    await sleep(800);
    assertNear(await realVolume(old.mainFrame(), '#top'), 0.5, 'top frame');
    assertNear(await realVolume(old.frames().find((f) => f.url().endsWith('/child')), '#inner'), 0.5, 'child frame');
    // Checked again: every frame now has the scripts exactly once.
    assert.deepEqual(await framesWithScripts(controller, `${server.a}/old`), [true, true]);
    await old.close();
    await controller.close();
  });

  it('covers data:, blob: and about:blank frames', async () => {
    const page = await firefox.browser.newPage();
    await page.goto(`${server.a}/frames`);
    await page.evaluate(() => blankAudio.play());
    await sleep(800);
    await setTabVolume(page, 50);
    await sleep(500);
    const frame = (prefix) => page.frames().find((f) => f.url().startsWith(prefix));
    assertNear(await realVolume(frame('data:'), 'audio'), 0.5, 'data: frame');
    assertNear(await realVolume(frame('blob:'), 'audio'), 0.5, 'blob: frame');
    assertNear(await realVolume(frame('about:blank'), 'audio'), 0.4, 'about:blank frame (page set 0.8)');
    // Firefox sets up a new about:blank frame itself, so its gain node lives in its own page.js.
    assertNear(await gainValues(frame('about:blank')), 0.5, 'about:blank frame AudioContext');
    await page.close();
  });

  it('sets up a frame the page uses before Firefox has', async () => {
    const page = await firefox.browser.newPage();
    await page.goto(`${server.a}/srcdoc`);
    assert.equal(await page.evaluate(() => window.patched), true);
    await page.close();
  });
});
