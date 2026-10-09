// A page trying to get around the tab volume for its <audio>/<video> elements.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNear, realVolume, sendPage, sendTone, serve, setTabVolume, sleep, startFirefox } from './helpers.mjs';

describe('a page working against the extension', { timeout: 180_000 }, () => {
  let server;
  let firefox;
  let page;
  const real = (id) => realVolume(page.mainFrame(), `#${id}`);
  // Sets an element's real volume to 1 with the browser's own setter, taken from a new frame
  // that page.js hasn't reached yet (a srcdoc frame, through frames[], in the same task).
  async function forceRealVolume(expression) {
    const native = await page.evaluate((expression) => {
      const frame = document.createElement('iframe');
      frame.srcdoc = 'x';
      document.body.append(frame);
      const set = Object.getOwnPropertyDescriptor(frames[frames.length - 1].HTMLMediaElement.prototype, 'volume').set;
      set.call(new Function(`return ${expression}`)(), 1);
      return set.toString().includes('[native code]');
    }, expression);
    assert.equal(native, true, 'the test really used the browser’s own setter');
  }

  before(async () => {
    server = await serve((req, res) => {
      if (req.url === '/') return sendPage(res, '<audio id="a" src="/tone.wav" loop></audio>');
      if (req.url === '/tone.wav') return sendTone(req, res);
      res.writeHead(404).end();
    });
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto(`${server.a}/`);
    await page.evaluate(async () => {
      const a = document.getElementById('a');
      a.volume = 0.8;
      await a.play();
    });
    await setTabVolume(page, 20);
    await sleep(300);
  });

  after(async () => {
    await firefox?.close();
    await server?.close();
  });

  it('gives the page nothing to call', async () => {
    assert.equal(await page.evaluate(() => typeof window[Symbol.for('tab-volume-control')]), 'undefined');
    assert.equal(await page.evaluate(() => typeof HTMLMediaElement.prototype[Symbol.for('tab-volume-control')]), 'boolean');
  });

  it("undoes the page setting an element's real volume directly", async () => {
    assertNear(await real('a'), 0.16, 'before');
    await forceRealVolume("document.getElementById('a')");
    await sleep(150);
    assertNear(await real('a'), 0.16, 'after (back to 0.8 × 20%)');
  });

  it('keeps control of an element whose prototype the page swapped out', async () => {
    await page.evaluate(async () => {
      const s = document.createElement('audio');
      s.id = 'sneaky';
      s.src = '/tone.wav';
      s.loop = true;
      document.body.append(s);
      await s.play();
      Object.setPrototypeOf(s, HTMLElement.prototype); // hides page.js from the element
    });
    await forceRealVolume("document.getElementById('sneaky')");
    await sleep(300);
    assertNear(await real('sneaky'), 0.2, 'sneaky real volume');
  });

  it("corrects an element outside the document that blocks the extension's listener", async () => {
    await page.evaluate(async () => {
      window.d = new Audio('/tone.wav');
      d.loop = true;
      d.addEventListener('volumechange', (event) => event.stopImmediatePropagation()); // registered first
      await d.play();
    });
    await sleep(300);
    await forceRealVolume('window.d');
    await sleep(2600); // the extension re-checks every 2 seconds
    const realOfDetached = await page.mainFrame().isolatedRealm().evaluate(() =>
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get.call(window.wrappedJSObject.d));
    assertNear(realOfDetached, 0.2, 'detached real volume');
  });

  it('ignores a forged handshake', async () => {
    const forged = await page.evaluate(() => document.dispatchEvent(
      new CustomEvent('tab-volume-control:hello', { detail: 'tvc-forged', cancelable: true })));
    assert.equal(forged, true, 'page.js did not accept it');
    await setTabVolume(page, 10);
    await sleep(300);
    assertNear(await real('a'), 0.08, 'still enforced');
  });
});
