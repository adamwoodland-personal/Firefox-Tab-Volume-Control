// Shared helpers for the end-to-end tests. They run the extension in a real Firefox through
// WebDriver BiDi (puppeteer-core), against pages served from a local web server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOT_PART_OF_EXTENSION = new Set([
  'tests', 'node_modules', 'web-ext-artifacts', 'package.json', 'package-lock.json', '.git', '.gitignore',
]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Firefox

export function findFirefox() {
  const candidates = [
    process.env.FIREFOX_PATH,
    ...{
      win32: [
        `${process.env.PROGRAMFILES}\\Mozilla Firefox\\firefox.exe`,
        `${process.env['PROGRAMFILES(X86)']}\\Mozilla Firefox\\firefox.exe`,
        `${process.env.LOCALAPPDATA}\\Mozilla Firefox\\firefox.exe`,
      ],
      darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
      linux: ['/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox'],
    }[process.platform] ?? [],
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('Firefox not found. Set FIREFOX_PATH to the Firefox executable.');
  return found;
}

// Starts Firefox (headless unless HEADFUL is set), with the test build of the extension
// installed unless `install` is false. Audio may autoplay, so tests don't need clicks.
export async function startFirefox({ install = true } = {}) {
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: findFirefox(),
    headless: !process.env.HEADFUL,
    extraPrefsFirefox: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
  });
  const extensionDir = buildTestExtension();
  const firefox = {
    browser,
    extensionId: null,
    async install() {
      firefox.extensionId = await browser.installExtension(extensionDir);
    },
    async uninstall() {
      await browser.uninstallExtension(firefox.extensionId);
      firefox.extensionId = null;
    },
    async close() {
      await browser.close();
      fs.rmSync(extensionDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  if (install) await firefox.install();
  return firefox;
}

// The extension with test-only hooks added, in a temporary folder. The hooks let test pages
// drive the background script and look inside the content scripts; production code has none.
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-volume-control-test-'));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => !NOT_PART_OF_EXTENSION.has(path.relative(ROOT, source).split(path.sep)[0]),
  });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts.push({ matches: ['http://127.0.0.1/*', 'https://cyberia.love/*'], js: ['test-hook.js'], run_at: 'document_start' });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Relays requests from test pages (top frames only) to the background script; see ask().
  fs.writeFileSync(path.join(dir, 'test-hook.js'), `
document.addEventListener('tvc-test', (event) => {
  browser.runtime.sendMessage(JSON.parse(event.detail)).then((reply) => {
    document.dispatchEvent(new CustomEvent('tvc-test-reply', { detail: JSON.stringify(reply ?? null) }));
  });
});`);
  // Must not be an async listener: that would answer every message, the extension's own included.
  fs.appendFileSync(path.join(dir, 'background.js'), `
browser.runtime.onMessage.addListener((message, sender) =>
  String(message?.type).startsWith('test-') ? handleTestMessage(message, sender) : undefined);

async function handleTestMessage(message, sender) {
  const tabByUrl = async (url) => (await browser.tabs.query({})).find((tab) => tab.url.startsWith(url));
  switch (message.type) {
    case 'test-set': return setTabVolume(sender.tab.id, message.volume);
    case 'test-set-url': return setTabVolume((await tabByUrl(message.url)).id, message.volume);
    case 'test-audible': return (await browser.tabs.get(sender.tab.id)).audible;
    case 'test-frames': {
      const frames = await browser.scripting.executeScript({
        target: { tabId: (await tabByUrl(message.url)).id, allFrames: true },
        func: () => globalThis.tabVolumeControlLoaded === true,
      });
      return frames.map((frame) => frame.result);
    }
    default: return undefined;
  }
}`);

  patch(dir, 'content/page.js', [
    // Lets pages read page.js's gain nodes: see gainValues().
    ['const masters = new Set();', 'const masters = window.__tvcMasters = new Set();'],
  ]);
  patch(dir, 'content/content.js', [
    // Counts the media content.js has boosted: see boostedCount().
    ['      boosted.set(el, source);', '      boosted.set(el, source);\n      (globalThis.testBoosted ??= new Set()).add(source);'],
    ['    boosted.delete(el);', '    boosted.delete(el);\n    globalThis.testBoosted?.delete(source);'],
    [/\}\)\(\);\s*$/, `  document.addEventListener('tvc-test-boosted', () => {
    document.dispatchEvent(new CustomEvent('tvc-test-reply', { detail: String(globalThis.testBoosted?.size ?? 0) }));
  });
})();
`],
  ]);
  return dir;
}

// Fails loudly when the code a hook relies on has changed, so the hook gets updated.
function patch(dir, file, replacements) {
  const full = path.join(dir, file);
  let text = fs.readFileSync(full, 'utf8');
  for (const [from, to] of replacements) {
    if (typeof from === 'string' ? !text.includes(from) : !from.test(text)) {
      throw new Error(`tests/helpers.mjs: ${file} no longer contains ${from}; update the test hook.`);
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(full, text);
}

// Talking to the test build from a test page

function ask(page, event, detail) {
  return page.evaluate((event, detail) => new Promise((resolve, reject) => {
    document.addEventListener('tvc-test-reply', (reply) => resolve(JSON.parse(reply.detail)), { once: true });
    document.dispatchEvent(new CustomEvent(event, { detail }));
    setTimeout(() => reject(new Error(`no reply to ${event}`)), 5000);
  }), event, detail);
}

const background = (page, message) => ask(page, 'tvc-test', JSON.stringify(message));

/** Sets the volume (in %) of the page's own tab. Resolves to the background's answer. */
export const setTabVolume = (page, volume) => background(page, { type: 'test-set', volume });
/** Sets the volume of the first tab whose URL starts with `url`, from another page. */
export const setTabVolumeByUrl = (page, url, volume) => background(page, { type: 'test-set-url', url, volume });
/** Firefox's own "this tab is playing sound" flag. */
export const isAudible = (page) => background(page, { type: 'test-audible' });
/** For each frame of the tab at `url`: whether the content scripts are loaded there. */
export const framesWithScripts = (page, url) => background(page, { type: 'test-frames', url });
/** How many media elements content.js has routed through Web Audio to boost them. */
export const boostedCount = (page) => ask(page, 'tvc-test-boosted').then(Number);

/** The values of page.js's gain nodes in the page's frame (one per AudioContext). */
export const gainValues = (frame) => frame.evaluate(() =>
  [...window.__tvcMasters].map((ref) => Math.round(ref.deref().gain.value * 1000) / 1000));

/**
 * An element's real volume. Read in an isolated sandbox, which Firefox gives an Xray view
 * like a content script's, so it sees the browser's own `volume`, not the page's.
 */
export const realVolume = (frame, selector) =>
  frame.isolatedRealm().evaluate((selector) => document.querySelector(selector)?.volume, selector);

/** Retries `read` until `test` accepts its result or `timeout` ms pass; returns the last result. */
export async function waitFor(read, test, timeout = 12000) {
  const start = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - start < timeout) {
    await sleep(250);
    value = await read();
  }
  return value;
}

// Pages

/** A 2-second 440 Hz tone as a 16-bit mono WAV file. */
export const TONE = (() => {
  const rate = 22050;
  const samples = rate * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return wav;
})();

export function sendTone(req, res, headers = {}) {
  res.writeHead(200, { 'content-type': 'audio/wav', ...headers }).end(req.method === 'HEAD' ? undefined : TONE);
}

export function sendPage(res, html, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(`<!doctype html><body>${html}`);
}

/**
 * Serves `handler` on a random port. The server answers as two origins, `a`
 * (http://127.0.0.1:PORT) and `b` (http://localhost:PORT), for cross-origin cases.
 */
export async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res, origins));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const origins = { a: `http://127.0.0.1:${port}`, b: `http://localhost:${port}` };
  return {
    ...origins,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Defines outputLevels(): the loudness of what each of page.js's gain nodes sends on. */
export const MEASURE_OUTPUT = `<script>
  window.outputLevels = async () => {
    const levels = [];
    for (const ref of window.__tvcMasters) {
      const master = ref.deref();
      const analyser = master.context.createAnalyser();
      master.connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      master.disconnect(analyser);
      levels.push(Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length));
    }
    return levels;
  };
</script>`;

// Assertions

export function assertNear(actual, expected, message, tolerance = 0.011) {
  const values = Array.isArray(actual) ? actual : [actual];
  assert.ok(
    values.length > 0 && values.every((value) => typeof value === 'number' && Math.abs(value - expected) < tolerance),
    `${message}: expected ${expected}, got ${JSON.stringify(actual)}`,
  );
}
