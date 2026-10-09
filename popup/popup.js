'use strict';
/* global DEFAULT_VOLUME, MAX_VOLUME, clampVolume, volumeKey, getTabVolume */

const PRESETS = [0, 50, 100, 150, 200, 300];
const KEY_STEPS = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 25, PageDown: -25 };
const WHEEL_STEP = 5;

// The slider puts 100% in the middle: the left half covers 0–100%, the right half the boost.
const SLIDER_MAX = 1000;
const MIDDLE = SLIDER_MAX / 2;
const BOOST_RANGE = MAX_VOLUME - DEFAULT_VOLUME;

function toSlider(volume) {
  return volume <= DEFAULT_VOLUME
    ? (volume / DEFAULT_VOLUME) * MIDDLE
    : MIDDLE + ((volume - DEFAULT_VOLUME) / BOOST_RANGE) * MIDDLE;
}

function fromSlider(position) {
  return clampVolume(position <= MIDDLE
    ? (position / MIDDLE) * DEFAULT_VOLUME
    : DEFAULT_VOLUME + ((position - MIDDLE) / MIDDLE) * BOOST_RANGE);
}

// Moves to the next multiple of |delta| in delta's direction.
function nudge(volume, delta) {
  const step = Math.abs(delta);
  return delta > 0 ? Math.floor(volume / step) * step + step : Math.ceil(volume / step) * step - step;
}

// Sends changes to the background script one at a time. While a slider is dragged,
// values that pile up in the meantime are skipped in favour of the latest one.
const outbox = new Map();

async function sendVolume(tabId, volume) {
  let pending = outbox.get(tabId);
  if (pending) {
    pending.volume = volume;
    return;
  }
  pending = { volume };
  outbox.set(tabId, pending);
  while (pending.volume !== null) {
    const next = pending.volume;
    pending.volume = null;
    const applied = await browser.runtime.sendMessage({ type: 'set-volume', tabId, volume: next }).catch(() => null);
    if (applied === false) controls.get(tabId)?.setUnsupported();
  }
  outbox.delete(tabId);
}

// Asks whether the tab's volume can be changed (which also sets up any frames that are
// missing the content scripts). Discarded tabs get their volume once they load again.
async function probe(tab) {
  if (tab.discarded) return;
  const ok = await browser.runtime.sendMessage({ type: 'probe', tabId: tab.id }).catch(() => null);
  if (ok === false) controls.get(tab.id)?.setUnsupported();
}

const controls = new Map(); // tab id -> control

// Wires up a slider, readout and mute button for one tab. Used for the main control and
// for each row in the "Other tabs" list.
function bindControl(root, tab, initialVolume) {
  const slider = root.querySelector('.slider');
  const input = root.querySelector('.readout-input');
  const text = root.querySelector('.readout-text');
  const status = root.querySelector('.status');
  const muteButton = root.querySelector('.mute');
  const presetButtons = root.querySelectorAll('.preset');
  let volume = initialVolume;
  let muted = Boolean(tab.mutedInfo?.muted);

  function show({ moveSlider = true } = {}) {
    if (moveSlider) slider.value = toSlider(volume);
    slider.setAttribute('aria-valuetext', `${volume}%`);
    root.classList.toggle('boosted', volume > DEFAULT_VOLUME);
    root.classList.toggle('muted', muted);
    if (text) text.textContent = `${volume}%`;
    if (input && document.activeElement !== input) input.value = volume;
    if (status) status.textContent = muted ? 'Muted' : volume === 0 ? 'Silent' : volume > DEFAULT_VOLUME ? 'Boosted' : '';
    for (const button of presetButtons) {
      button.setAttribute('aria-pressed', String(Number(button.value) === volume));
    }
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.title = muted ? 'Unmute tab' : 'Mute tab';
  }

  function change(next, options) {
    next = clampVolume(next);
    if (next === volume) return;
    volume = next;
    show(options);
    sendVolume(tab.id, volume);
  }

  slider.addEventListener('input', () => change(fromSlider(slider.valueAsNumber), { moveSlider: false }));
  slider.addEventListener('change', () => show()); // snap the thumb to the value shown
  slider.addEventListener('dblclick', () => change(DEFAULT_VOLUME));
  slider.addEventListener('wheel', (event) => {
    if (slider.disabled) return;
    event.preventDefault();
    change(nudge(volume, event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
  }, { passive: false });
  slider.addEventListener('keydown', (event) => {
    if (event.key === 'Home') change(0);
    else if (event.key === 'End') change(MAX_VOLUME);
    else if (Object.hasOwn(KEY_STEPS, event.key)) change(nudge(volume, KEY_STEPS[event.key]));
    else return;
    event.preventDefault();
  });

  for (const button of presetButtons) {
    button.addEventListener('click', () => change(Number(button.value)));
  }

  if (input) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        input.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        change(volume + (event.key === 'ArrowUp' ? 1 : -1));
        input.value = volume;
        input.select();
      }
    });
    input.addEventListener('blur', () => {
      const typed = Number.parseInt(input.value, 10);
      if (Number.isFinite(typed)) change(typed);
      input.value = volume;
    });
  }

  muteButton.addEventListener('click', () => {
    browser.tabs.update(tab.id, { muted: !muted });
  });

  show();
  const control = {
    root,
    setMuted(value) {
      muted = value;
      show();
    },
    // Firefox doesn't let extensions into this tab's page; only muting works.
    setUnsupported() {
      root.classList.add('unsupported');
      const notice = root.querySelector('.notice');
      if (notice) notice.hidden = false;
      else root.title = 'Firefox doesn’t let extensions change the volume of this page. You can still mute it.';
      for (const el of root.querySelectorAll('.slider, .readout-input, .preset')) el.disabled = true;
    },
  };
  controls.set(tab.id, control);
  return control;
}

function showTab(root, tab) {
  root.querySelector('.tab-title').textContent = tab.title || tab.url;
  const host = root.querySelector('.tab-host');
  if (host) {
    try {
      host.textContent = new URL(tab.url).host || tab.url;
    } catch {
      host.textContent = '';
    }
  }
  const icon = root.querySelector('.favicon');
  icon.hidden = !tab.favIconUrl;
  icon.onerror = () => {
    icon.hidden = true; // e.g. chrome:// icons, which extension pages can't load
  };
  if (tab.favIconUrl) icon.src = tab.favIconUrl;
}

function addRow(tab, volume) {
  const section = document.getElementById('others');
  const row = document.getElementById('row-template').content.firstElementChild.cloneNode(true);
  showTab(row, tab);
  row.querySelector('.slider').setAttribute('aria-label', `Volume of ${tab.title || tab.url}`);
  row.querySelector('.row-tab').addEventListener('click', async () => {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    window.close();
  });
  section.querySelector('.tab-list').append(row);
  section.hidden = false;
  bindControl(row, tab, volume);
  probe(tab);
}

async function showShortcut() {
  const commands = await browser.commands.getAll();
  const shortcut = commands.find((command) => command.name === '_execute_action')?.shortcut;
  if (!shortcut) return;
  const hint = document.querySelector('.shortcut');
  const key = document.createElement('kbd');
  key.textContent = shortcut;
  hint.append(' Shortcut: ', key);
}

async function init() {
  const [pendingTarget, [activeTab], allTabs, stored] = await Promise.all([
    browser.runtime.sendMessage({ type: 'take-popup-target' }).catch(() => null),
    browser.tabs.query({ active: true, currentWindow: true }),
    browser.tabs.query({}),
    browser.storage.session.get(null),
  ]);
  const volumeOf = (tabId) => stored[volumeKey(tabId)] ?? DEFAULT_VOLUME;

  const current = document.getElementById('current');
  current.querySelector('.scale-max').textContent = `${MAX_VOLUME}%`;
  const presets = current.querySelector('.presets');
  for (const volume of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.value = volume;
    button.textContent = `${volume}%`;
    presets.append(button);
  }

  const target = allTabs.find((tab) => tab.id === (pendingTarget ?? activeTab?.id));
  if (!target) return;
  showTab(current, target);
  bindControl(current, target, volumeOf(target.id));

  // Tabs making sound, and tabs whose volume was changed, sorted by sound then recent use.
  const others = allTabs
    .filter((tab) => tab.id !== target.id && (tab.audible || volumeOf(tab.id) !== DEFAULT_VOLUME))
    .sort((a, b) => Number(b.audible) - Number(a.audible) || b.lastAccessed - a.lastAccessed);
  for (const tab of others) addRow(tab, volumeOf(tab.id));

  browser.tabs.onUpdated.addListener(async (tabId, changes, tab) => {
    const control = controls.get(tabId);
    if (control) {
      if (changes.mutedInfo) control.setMuted(changes.mutedInfo.muted);
      if (changes.title || changes.favIconUrl) showTab(control.root, tab);
    } else if (changes.audible) {
      const volume = await getTabVolume(tabId);
      if (!controls.has(tabId)) addRow(tab, volume);
    }
  }, { properties: ['audible', 'mutedInfo', 'title', 'favIconUrl'] });

  showShortcut();
  probe(target);
}

init();
