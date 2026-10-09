// Media inside shadow roots, whose 'play' events never reach the document.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNear, sendPage, sendTone, serve, setTabVolume, sleep, startFirefox } from './helpers.mjs';

describe('shadow DOM', { timeout: 120_000 }, () => {
  let server;
  let firefox;
  let page;

  before(async () => {
    server = await serve((req, res) => {
      if (req.url === '/tone.wav') return sendTone(req, res);
      if (req.url === '/') {
        return sendPage(res, `
          <div id="host"></div>
          <div id="declarative"><template shadowrootmode="open"><audio id="d" src="/tone.wav" loop autoplay></audio></template></div>
          <script>
            window.volumeChanges = { closed: 0, declarative: 0 };
            const root = document.getElementById('host').attachShadow({ mode: 'closed' });
            window.closedAudio = document.createElement('audio');
            closedAudio.src = '/tone.wav';
            closedAudio.loop = true;
            closedAudio.autoplay = true;
            root.append(closedAudio);
            closedAudio.addEventListener('volumechange', () => volumeChanges.closed++);
            document.getElementById('declarative').shadowRoot.getElementById('d')
              .addEventListener('volumechange', () => volumeChanges.declarative++);
          </script>`);
      }
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto(`${server.a}/`);
    await setTabVolume(page, 50);
    await page.reload(); // so everything autoplays with the tab already at 50%
    await sleep(1500);
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('turns down media autoplaying in a closed shadow root', async () => {
    // The page can't see the real volume, but it changing fires volumechange.
    assert.ok(await page.evaluate(() => volumeChanges.closed >= 1), 'real volume changed');
    assert.equal(await page.evaluate(() => closedAudio.volume), 1, 'the page still sees its own volume');
  });

  it('turns down media autoplaying in a declarative shadow root', async () => {
    assert.ok(await page.evaluate(() => volumeChanges.declarative >= 1), 'real volume changed');
    const real = await page.mainFrame().isolatedRealm().evaluate(() =>
      document.getElementById('declarative').shadowRoot.getElementById('d').volume);
    assertNear(real, 0.5, 'real volume');
  });
});
