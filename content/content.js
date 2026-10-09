'use strict';

// Applies the tab's volume to this frame. This runs in the isolated content-script world,
// and all its changes go through Firefox's Xray wrappers, which reach the browser's own
// implementations whatever the page has done to its JavaScript objects:
//  - <audio>/<video>: below 100%, an element's real volume is scaled down. Above 100%, the
//    element is routed through Web Audio, the only way to amplify it. Media that Web Audio
//    isn't allowed to read (cross-origin or DRM-protected) only goes up to full volume.
//  - Web Audio: page.js puts a gain node in front of each AudioContext's output and hands
//    it over, and this script sets it to the tab volume.
// page.js runs in the page's own world and keeps the page seeing the volume it set itself,
// so the site's own volume control keeps working, multiplied by the tab volume. The page
// can tamper with page.js, so whatever comes from there is treated as untrusted.

(() => {
  if (globalThis.tabVolumeControlLoaded) return; // injected again by the background script
  globalThis.tabVolumeControlLoaded = true;

  const MARK = Symbol.for('tab-volume-control'); // put on the media prototype by page.js
  const CHANNEL = `tvc-${crypto.randomUUID()}`; // prefix for events shared only with page.js
  const HAVE_CURRENT_DATA = 2;
  const ORIGIN_RETRY_DELAYS = [3000, 15000, 60000];

  let level = 1; // the tab volume as a factor: 1 = 100%
  let boostMaster = null; // page.js's gain node for media boosted here
  let enforcer = 0;
  let lastScan = 0;

  const media = new Set();
  const masters = new Set(); // page.js's gain nodes, one per AudioContext
  const routedByPage = new WeakSet(); // elements the page plays through its own Web Audio graph
  const boosted = new WeakMap(); // element -> our source node feeding boostMaster
  const unroutable = new WeakSet();
  const watchedRoots = new WeakSet();
  const originChecks = new Map(); // media URL -> { readable: true | false | undefined, tries }

  function toPage(kind, detail) {
    document.dispatchEvent(new CustomEvent(`${CHANNEL}:${kind}`, { detail }));
  }

  function fromPage(kind, handler) {
    document.addEventListener(`${CHANNEL}:${kind}`, (event) => {
      event.preventDefault(); // tells page.js this script is running
      handler(event.detail);
    });
  }

  // Whether page.js runs in this frame. Checked on the frame's real media prototype (the
  // Xray view of HTMLMediaElement can't be swapped out by the page), not through elements,
  // whose prototype chain the page can change.
  function pageScriptRunning() {
    return Object.hasOwn(HTMLMediaElement.prototype.wrappedJSObject, MARK);
  }

  const written = new WeakMap(); // element -> real volume this script last set
  const recorded = new WeakMap(); // element -> the page's volume, when page.js isn't running

  // The volume the page set itself. page.js reports it, but the page can make that report
  // say anything, so it's only used within 0–1: no page ends up louder than the tab volume.
  // Without page.js, a real volume this script didn't set must be the page's own.
  function pageVolume(el) {
    if (pageScriptRunning()) {
      try {
        const reported = el.wrappedJSObject.volume;
        if (typeof reported === 'number' && reported >= 0 && reported <= 1) return reported;
      } catch {
        // fall through
      }
      return 1;
    }
    if (!recorded.has(el) || el.volume !== written.get(el)) recorded.set(el, el.volume);
    return recorded.get(el);
  }

  function setRealVolume(el, value) {
    written.set(el, value);
    if (el.volume !== value) el.volume = value; // the browser's own setter, through the Xray
  }

  function apply(el) {
    const wanted = pageVolume(el);
    if (routedByPage.has(el)) {
      // The page plays it through its own Web Audio graph, where page.js's gain node applies
      // the tab volume. Firefox lets an element feed several graphs at once, so stop ours.
      unboost(el);
      setRealVolume(el, wanted);
      return;
    }
    if (level > 1 && !boosted.has(el)) boost(el);
    // A boosted element keeps the page's volume; boostMaster applies the tab volume.
    setRealVolume(el, boosted.has(el) ? wanted : Math.min(wanted * level, 1));
  }

  function boost(el) {
    if (!canRoute(el)) return;
    if (!boostMaster) toPage('boost-context'); // page.js answers right away with 'boost-master'
    const context = boostMaster?.context;
    if (context?.state !== 'running') return; // a stopped context would silence the element
    try {
      const source = context.createMediaElementSource(el);
      source.connect(boostMaster);
      boosted.set(el, source);
    } catch {
      unroutable.add(el);
    }
  }

  function unboost(el) {
    const source = boosted.get(el);
    if (!source) return;
    source.disconnect();
    boosted.delete(el);
    unroutable.add(el);
  }

  // Routing an element through Web Audio can't be undone, and Web Audio only gets silence
  // from cross-origin media fetched without CORS and from DRM-protected media. So only
  // route media that's known to be readable.
  function canRoute(el) {
    if (unroutable.has(el)) return false;
    if (el.mediaKeys) {
      unroutable.add(el);
      return false;
    }
    // Only route once it plays (tried again on 'playing'), by which time a page that
    // routes the element through Web Audio itself has normally done so.
    if (el.paused || el.readyState < HAVE_CURRENT_DATA) return false;
    if (el.srcObject) return true;
    const src = el.currentSrc;
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    if (el.crossOrigin !== null) return true; // fetched with CORS, so readable from any origin
    let origin;
    try {
      origin = new URL(src).origin;
    } catch {
      return false;
    }
    return origin === location.origin && isReadable(src);
  }

  // A same-origin URL can still redirect to another origin, so page.js checks it (see
  // there). A failed check is retried a few times in case it was just a network hiccup.
  function isReadable(url) {
    let check = originChecks.get(url);
    if (!check) {
      check = { readable: undefined, tries: 0 };
      originChecks.set(url, check);
      requestOriginCheck(url, check);
    }
    return check.readable === true;
  }

  function requestOriginCheck(url, check) {
    check.tries++;
    toPage('check-origin', url);
  }

  function setMaster(master, { immediate = false } = {}) {
    try {
      if (master.context.state === 'closed') {
        masters.delete(master);
      } else if (immediate) {
        master.gain.value = level;
      } else if (Math.abs(master.gain.value - level) > 0.001) {
        master.gain.setTargetAtTime(level, master.context.currentTime, 0.015);
      }
    } catch {
      masters.delete(master);
    }
  }

  function applyAll() {
    for (const master of masters) setMaster(master);
    for (const el of media) apply(el);
  }

  // Finds media elements and shadow roots under root, closed shadow roots included.
  function scan(root) {
    for (const el of root.querySelectorAll('audio, video')) remember(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = node.openOrClosedShadowRoot;
      if (shadow) watchRoot(shadow);
    }
  }

  // 'play' and 'volumechange' don't leave a shadow root, so listen inside it.
  function watchRoot(root) {
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    root.addEventListener('play', onMediaEvent, true);
    root.addEventListener('volumechange', onMediaEvent, true);
    scan(root);
  }

  function remember(el) {
    if (media.has(el)) return;
    for (const known of media) {
      if (!known.isConnected && known.paused) media.delete(known);
    }
    media.add(el);
    el.addEventListener('playing', onMediaEvent);
    el.addEventListener('volumechange', onMediaEvent); // reapplies if anything else changed it
    el.addEventListener('encrypted', onEncrypted);
  }

  function track(el) {
    remember(el);
    apply(el);
  }

  function onMediaEvent(event) {
    if (event.target instanceof HTMLMediaElement) track(event.target);
  }

  function onEncrypted(event) {
    unroutable.add(event.currentTarget);
  }

  function setLevel(volume) {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    const next = Math.max(0, volume) / 100;
    if (next === level) return;
    level = next;
    // While the volume is changed, page.js checks this script is still running (and undoes
    // everything if not), and this script regularly puts back anything the page changed.
    toPage(level === 1 ? 'idle' : 'engaged');
    clearInterval(enforcer);
    enforcer = level === 1 ? 0 : setInterval(applyAll, 2000);
    if (Date.now() - lastScan > 2000) {
      lastScan = Date.now();
      scan(document);
    }
    applyAll();
  }

  // From page.js. Handlers are registered before saying hello, because page.js catches up
  // on earlier events straight away.
  fromPage('ping', () => {});
  fromPage('media', (el) => {
    if (el instanceof HTMLMediaElement) track(el);
  });
  fromPage('page-routed', (el) => {
    if (!(el instanceof HTMLMediaElement)) return;
    routedByPage.add(el);
    track(el);
  });
  fromPage('shadow-root', (root) => {
    if (root instanceof ShadowRoot) watchRoot(root);
  });
  fromPage('master', (master) => {
    if (!(master instanceof GainNode) || masters.has(master)) return;
    masters.add(master);
    setMaster(master, { immediate: true });
  });
  fromPage('boost-master', (master) => {
    if (boostMaster || !(master instanceof GainNode)) return;
    boostMaster = master;
    const context = master.context;
    // A new context starts out suspended and runs once the page may play sound. Boost
    // what's waiting once it does, and if autoplay rules keep it suspended, try again when
    // the user interacts with the page.
    context.addEventListener('statechange', () => {
      if (context.state === 'running') applyAll();
    });
    const resume = () => {
      if (context.state === 'suspended') context.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  });
  fromPage('origin', (json) => {
    let result;
    try {
      result = JSON.parse(json);
    } catch {
      return;
    }
    const check = originChecks.get(result?.url);
    if (!check || check.readable !== undefined) return;
    if (result.readable === true) {
      check.readable = true;
      applyAll();
      return;
    }
    const delay = ORIGIN_RETRY_DELAYS[check.tries - 1];
    if (delay === undefined) check.readable = false;
    else setTimeout(() => requestOriginCheck(result.url, check), delay);
  });

  document.dispatchEvent(new CustomEvent('tab-volume-control:hello', { detail: CHANNEL, cancelable: true }));

  window.addEventListener('play', onMediaEvent, true);
  window.addEventListener('volumechange', onMediaEvent, true);
  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    if (level !== 1) applyAll();
  });
  if (document.readyState !== 'loading') scan(document); // injected into an already loaded page

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'volume') setLevel(message.volume);
  });

  browser.runtime.sendMessage({ type: 'get-volume' }).then(setLevel, () => {});
})();
