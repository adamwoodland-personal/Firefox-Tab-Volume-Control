// Runs in the page's own JavaScript world, before any of the page's scripts.
//
// content.js does the actual volume control from the isolated content-script world, where
// the page can't interfere with it. This script does what has to happen inside the page:
//  - it keeps the page seeing the volume *it* set on <audio> and <video> elements, so a
//    site's own volume control keeps working on top of the tab volume;
//  - it puts a gain node in front of each AudioContext's output, which content.js sets to
//    the tab volume, so sound made with Web Audio follows it too;
//  - it tells content.js about things content.js can't find by itself: media elements
//    outside the document, AudioContexts, shadow roots and media played through Web Audio.
//
// The page can see and tamper with anything here, so content.js treats it as a helper, not
// as an authority, and nothing here takes orders from the page. The two talk through
// events named with a secret that content.js hands over before any page script runs.
//
// If content.js stops answering (the extension was disabled, removed or updated while the
// page was open), this script puts back every volume that was changed.
(() => {
  const MARK = Symbol.for('tab-volume-control');
  if (Object.hasOwn(HTMLMediaElement.prototype, MARK)) return; // already running in this frame

  // The browser's own implementations, kept before the page can replace them.
  const native = (proto, name) => Object.getOwnPropertyDescriptor(proto, name);
  const volume = native(HTMLMediaElement.prototype, 'volume');
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const { dispatchEvent, addEventListener } = EventTarget.prototype;
  const { toString } = Object.prototype;
  const defaultView = native(Document.prototype, 'defaultView').get;
  const NativeCustomEvent = CustomEvent;
  const NativeEvent = Event;
  const NativeWeakRef = WeakRef;
  const NativeAbortController = AbortController;
  const nativeFetch = fetch;
  const nativeSetInterval = setInterval;
  const nativeClearInterval = clearInterval;
  const nativeQueueMicrotask = queueMicrotask;
  const { stringify } = JSON;
  const doc = document;
  const scratch = doc.createElement('audio');
  const audio = typeof AudioNode === 'function' ? {
    AudioContext,
    connect: AudioNode.prototype.connect,
    disconnect: AudioNode.prototype.disconnect,
    contextOf: native(AudioNode.prototype, 'context').get,
    destinationOf: native(BaseAudioContext.prototype, 'destination').get,
    createGain: BaseAudioContext.prototype.createGain,
    createMediaElementSource: AudioContext.prototype.createMediaElementSource,
    gainOf: native(GainNode.prototype, 'gain').get,
    cancelScheduledValues: AudioParam.prototype.cancelScheduledValues,
    setValue: native(AudioParam.prototype, 'value').set,
  } : null;

  let channel = null; // event-name prefix shared with content.js, once it has said hello
  let monitor = 0;
  const pageVolumes = new WeakMap(); // element -> the volume the page set (or had when first seen)
  const elements = new Set(); // weak references to the elements in pageVolumes
  let sweepAt = 256;
  const shadowRoots = new Set(); // weak references
  const routedByPage = new Set(); // weak references to elements the page routes through Web Audio
  const routedByPageSet = new WeakSet();
  const masters = new Set(); // weak references to our gain nodes, one per AudioContext
  const masterGains = new WeakMap(); // destination node -> our gain node in front of it
  let boostMaster = null; // gain node for media content.js boosts, in a context of our own

  function live(refs) {
    const items = [];
    for (const ref of refs) {
      const item = ref.deref();
      if (item) items.push(item);
      else refs.delete(ref);
    }
    return items;
  }

  // Sends something to content.js. Returns true if content.js is running and handled it.
  function tell(kind, detail) {
    if (!channel) return false;
    const event = new NativeCustomEvent(`${channel}:${kind}`, { detail, cancelable: true });
    return !dispatchEvent.call(doc, event);
  }

  function checkController() {
    if (channel && !tell('ping')) restore();
  }

  // content.js has gone: put back everything it changed.
  function restore() {
    channel = null;
    nativeClearInterval(monitor);
    monitor = 0;
    for (const element of live(elements)) {
      const wanted = pageVolumes.get(element);
      if (volume.get.call(element) !== wanted) volume.set.call(element, wanted);
    }
    for (const master of live(masters)) {
      const gain = audio.gainOf.call(master);
      audio.cancelScheduledValues.call(gain, 0);
      audio.setValue.call(gain, 1);
    }
  }

  function remember(element, wanted) {
    if (!pageVolumes.has(element)) {
      elements.add(new NativeWeakRef(element));
      if (elements.size > sweepAt) sweepAt = live(elements).length * 2 + 256;
    }
    pageVolumes.set(element, wanted);
    return wanted;
  }

  // content.js reads an element's volume through this getter before changing it for the
  // first time, so the page keeps getting the value from before the change.
  const volumeAccessor = Object.getOwnPropertyDescriptor({
    get volume() {
      const known = pageVolumes.get(this);
      if (known !== undefined) return known;
      return remember(this, volume.get.call(this)); // throws the usual TypeError for non-media objects
    },
    set volume(value) {
      const realBefore = volume.get.call(this); // throws the usual TypeError for non-media objects
      volume.set.call(scratch, value); // throws the usual errors for bad values...
      const wanted = volume.get.call(scratch); // ...and converts the value the same way
      const before = pageVolumes.get(this) ?? realBefore;
      remember(this, wanted);
      if (!tell('media', this)) {
        volume.set.call(this, wanted); // content.js isn't running: plain behaviour
        checkController();
      } else if (wanted !== before && volume.get.call(this) === realBefore) {
        // The real volume didn't change, so Firefox won't fire volumechange. Fire it
        // anyway so the page notices its own change.
        nativeQueueMicrotask(() => dispatchEvent.call(this, new NativeEvent('volumechange')));
      }
    },
  }, 'volume');

  function play() {
    if (!tell('media', this)) checkController(); // lets content.js find elements outside the document
    return nativePlay.call(this);
  }

  function attachShadow(init) {
    const root = nativeAttachShadow.call(this, init);
    shadowRoots.add(new NativeWeakRef(root));
    tell('shadow-root', root); // closed roots included
    return root;
  }

  // The output of a real-time AudioContext, i.e. the speakers. Offline contexts and stream
  // destinations aren't touched. Checked by type name so nodes from other frames count too.
  function isSpeakers(node) {
    return toString.call(node) === '[object AudioDestinationNode]'
      && toString.call(audio.contextOf.call(node)) === '[object AudioContext]';
  }

  function masterFor(destination) {
    let master = masterGains.get(destination);
    if (!master) {
      master = audio.createGain.call(audio.contextOf.call(destination));
      audio.connect.call(master, destination);
      masterGains.set(destination, master);
      masters.add(new NativeWeakRef(master));
      tell('master', master); // content.js sets it to the tab volume
    }
    return master;
  }

  function connect(destination, ...rest) {
    if (!isSpeakers(destination)) return audio.connect.call(this, destination, ...rest);
    audio.connect.call(this, masterFor(destination), ...rest);
    return destination;
  }

  function disconnect(...args) {
    const master = isSpeakers(args[0]) && masterGains.get(args[0]);
    if (master) {
      try {
        return audio.disconnect.call(this, master, ...args.slice(1));
      } catch {
        // Not connected through our gain node (e.g. connected before this script ran).
      }
    }
    return audio.disconnect.apply(this, args);
  }

  // An element the page plays through Web Audio is controlled by our gain node in front
  // of the context's output, so content.js has to leave the element's own volume alone.
  function createMediaElementSource(element) {
    const node = audio.createMediaElementSource.call(this, element);
    if (!routedByPageSet.has(element)) {
      routedByPageSet.add(element);
      routedByPage.add(new NativeWeakRef(element));
    }
    tell('page-routed', element);
    return node;
  }

  // Firefox only injects content scripts into a new about:blank frame later, but a page can
  // use the frame's window straight away, e.g. to make an AudioContext there. Set such a
  // frame up the moment the page reaches into it.
  function frameAccessor(descriptor, isDocument) {
    const get = descriptor.get;
    return {
      ...descriptor,
      get: Object.getOwnPropertyDescriptor({
        get frame() {
          const result = get.call(this);
          if (result) {
            try {
              install(isDocument ? defaultView.call(result) : result);
            } catch {
              // A cross-origin frame: it gets its own copy of this script.
            }
          }
          return result;
        },
      }, 'frame').get,
    };
  }
  const frameAccessors = [];
  for (const type of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement']) {
    for (const name of ['contentWindow', 'contentDocument']) {
      const descriptor = native(window[type].prototype, name);
      if (descriptor?.get) frameAccessors.push([type, name, frameAccessor(descriptor, name === 'contentDocument')]);
    }
  }

  // Patches a window's built-ins. Frames set up through frameAccessor share this frame's
  // state and talk to this frame's content.js.
  function install(win) {
    const mediaProto = win.HTMLMediaElement.prototype;
    if (Object.hasOwn(mediaProto, MARK)) return;
    Object.defineProperty(mediaProto, MARK, { value: true });
    Object.defineProperty(mediaProto, 'volume', volumeAccessor);
    mediaProto.play = play;
    win.Element.prototype.attachShadow = attachShadow;
    for (const [type, name, accessor] of frameAccessors) Object.defineProperty(win[type].prototype, name, accessor);
    if (audio && typeof win.AudioNode === 'function') {
      win.AudioNode.prototype.connect = connect;
      win.AudioNode.prototype.disconnect = disconnect;
      win.AudioContext.prototype.createMediaElementSource = createMediaElementSource;
    }
  }

  // Web Audio can only boost media it's allowed to read, and a same-origin URL can still
  // redirect to another origin (a CDN, say). A same-origin-mode request fails if any
  // redirect leaves the origin, so a successful response proves the media is readable.
  // A failure proves nothing (the site's CSP may block fetch(), or the network hiccuped),
  // so content.js may ask again.
  function checkOrigin(url) {
    if (typeof url !== 'string') return;
    const abort = new NativeAbortController();
    nativeFetch(url, { mode: 'same-origin', headers: { Range: 'bytes=0-0' }, signal: abort.signal })
      .then((response) => {
        abort.abort(); // only the headers are needed
        return response.status === 200 || response.status === 206;
      }, () => false)
      .then((readable) => tell('origin', stringify({ url, readable })));
  }

  // The context content.js routes media into to boost it. It's private to this script, so
  // the page can't reach it.
  function provideBoostContext() {
    if (!boostMaster && audio) {
      try {
        boostMaster = masterFor(audio.destinationOf.call(new audio.AudioContext()));
      } catch {
        return;
      }
    }
    if (boostMaster) tell('boost-master', boostMaster);
  }

  function listen(kind, handler) {
    const prefix = channel;
    addEventListener.call(doc, `${prefix}:${kind}`, (event) => {
      if (channel === prefix) handler(event.detail);
    });
  }

  // content.js introduces itself with the secret prefix for all further events. It does so
  // before any page script runs, so the page can't pick it up. A newer content.js (after
  // an update) only replaces one that has stopped answering.
  addEventListener.call(doc, 'tab-volume-control:hello', (event) => {
    const proposed = event.detail;
    if (typeof proposed !== 'string' || !proposed.startsWith('tvc-')) return;
    if (channel && tell('ping')) return;
    if (channel) restore();
    channel = proposed;
    event.preventDefault();
    listen('engaged', () => {
      if (!monitor) monitor = nativeSetInterval(checkController, 2000);
    });
    listen('idle', () => {
      nativeClearInterval(monitor);
      monitor = 0;
    });
    listen('boost-context', provideBoostContext);
    listen('check-origin', checkOrigin);
    // Catch content.js up on what happened before it arrived.
    for (const master of live(masters)) tell('master', master);
    for (const root of live(shadowRoots)) tell('shadow-root', root);
    for (const element of live(routedByPage)) tell('page-routed', element);
    for (const element of live(elements)) tell('media', element);
  });

  install(window);
})();
