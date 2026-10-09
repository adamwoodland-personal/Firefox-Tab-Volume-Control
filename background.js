'use strict';
/* global DEFAULT_VOLUME, clampVolume, volumeKey, getTabVolume */

const MENU_ROOT = 'volume';
const MENU_SLIDER = 'volume-slider';
const MENU_PRESETS = [0, 25, 50, 75, 100, 150, 200, 300, 400];
const presetMenuId = (volume) => `volume-${volume}`;
const ignore = () => {};

// The tab whose "Volume slider…" menu item was clicked. The popup asks for it as it opens.
let popupTarget = null;

async function setTabVolume(tabId, volume) {
  volume = clampVolume(volume);
  if (volume === DEFAULT_VOLUME) await browser.storage.session.remove(volumeKey(tabId));
  else await browser.storage.session.set({ [volumeKey(tabId)]: volume });
  showOnButton(tabId, volume);
  browser.tabs.sendMessage(tabId, { type: 'volume', volume }).catch(ignore);
  return ensureContentScripts(tabId);
}

// Like Firefox's own tab menu items, act on every selected tab when the clicked tab is
// part of a multi-selection.
async function setVolumeOfSelection(tab, volume) {
  const tabs = tab.highlighted
    ? await browser.tabs.query({ windowId: tab.windowId, highlighted: true })
    : [tab];
  await Promise.all(tabs.map((t) => setTabVolume(t.id, volume)));
}

// Frames get the content scripts as they load, except frames that were open before the
// extension was installed or updated, and empty about:blank frames, which Firefox only
// covers later. So check every frame and inject the scripts wherever they're missing; they
// then ask for the tab's volume themselves. Resolves to false if Firefox doesn't let
// extensions into the page (about: pages, the PDF viewer, addons.mozilla.org, ...).
// Repeated calls within a few seconds (a slider being dragged) share one check.
const coverageChecks = new Map(); // tab id -> { time, result }

function ensureContentScripts(tabId, { fresh = false } = {}) {
  const recent = coverageChecks.get(tabId);
  if (!fresh && recent && Date.now() - recent.time < 3000) return recent.result;
  const result = checkFrames(tabId);
  coverageChecks.set(tabId, { time: Date.now(), result });
  return result;
}

async function checkFrames(tabId) {
  let frames;
  try {
    frames = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.tabVolumeControlLoaded === true,
    });
  } catch {
    return false;
  }
  const missing = frames.filter((frame) => !frame.error && frame.result !== true).map((frame) => frame.frameId);
  if (missing.length) {
    const target = { tabId, frameIds: missing };
    try {
      await browser.scripting.executeScript({ target, files: ['content/page.js'], world: 'MAIN' });
      await browser.scripting.executeScript({ target, files: ['content/content.js'] });
    } catch {
      // A frame went away or can't be scripted.
    }
  }
  return frames.some((frame) => frame.frameId === 0 && !frame.error);
}

// Shows a changed volume as a badge on the toolbar button. Firefox clears per-tab badges
// whenever the tab navigates, so this is re-applied as pages load.
function showOnButton(tabId, volume) {
  const changed = volume !== DEFAULT_VOLUME;
  browser.action.setBadgeText({ tabId, text: changed ? String(volume) : '' }).catch(ignore);
  browser.action.setTitle({ tabId, title: changed ? `Tab volume: ${volume}%` : null }).catch(ignore);
  if (changed) {
    const color = volume > DEFAULT_VOLUME ? '#c24a00' : '#5b5b66';
    browser.action.setBadgeBackgroundColor({ tabId, color }).catch(ignore);
  }
}

async function createMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU_ROOT, title: 'Volume', contexts: ['tab'], icons: { 16: 'icons/icon.svg' } });
  browser.menus.create({ id: MENU_SLIDER, parentId: MENU_ROOT, title: 'Volume slider…', contexts: ['tab'] });
  browser.menus.create({ id: 'volume-separator', parentId: MENU_ROOT, type: 'separator', contexts: ['tab'] });
  for (const volume of MENU_PRESETS) {
    const title = volume === 0 ? '0% (silent)' : volume === DEFAULT_VOLUME ? '100% (normal)' : `${volume}%`;
    browser.menus.create({ id: presetMenuId(volume), parentId: MENU_ROOT, type: 'radio', title, contexts: ['tab'] });
  }
}

browser.runtime.onInstalled.addListener(createMenus);
browser.runtime.onStartup.addListener(createMenus);
browser.action.setBadgeTextColor({ color: '#ffffff' });

// Show the clicked tab's current volume in the menu.
browser.menus.onShown.addListener(async (info, tab) => {
  if (!tab || !info.menuIds.includes(MENU_ROOT)) return;
  const volume = await getTabVolume(tab.id);
  await Promise.all([
    browser.menus.update(MENU_ROOT, { title: `Volume (${volume}%)` }),
    ...MENU_PRESETS.map((preset) => browser.menus.update(presetMenuId(preset), { checked: preset === volume })),
  ]);
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU_SLIDER) {
    popupTarget = { tabId: tab.id, time: Date.now() };
    // Firefox only opens the popup while the click is being handled, so don't await anything first.
    browser.action.openPopup({ windowId: tab.windowId }).catch(ignore);
    return;
  }
  const preset = MENU_PRESETS.find((volume) => info.menuItemId === presetMenuId(volume));
  if (preset !== undefined) setVolumeOfSelection(tab, preset);
});

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case 'get-volume': // from a content script starting up in a frame
      if (!sender.tab) return undefined;
      return getTabVolume(sender.tab.id).then((volume) => {
        if (sender.frameId === 0 && volume !== DEFAULT_VOLUME) showOnButton(sender.tab.id, volume);
        return volume;
      });
    case 'set-volume': // from the popup
      return setTabVolume(message.tabId, message.volume);
    case 'probe': // from the popup: can this tab's volume be changed?
      return ensureContentScripts(message.tabId, { fresh: true });
    case 'take-popup-target': {
      const target = popupTarget;
      popupTarget = null;
      return Promise.resolve(target && Date.now() - target.time < 5000 ? target.tabId : null);
    }
    default:
      return undefined;
  }
});

browser.tabs.onUpdated.addListener(async (tabId) => {
  coverageChecks.delete(tabId); // a new page has new frames
  const volume = await getTabVolume(tabId);
  if (volume !== DEFAULT_VOLUME) showOnButton(tabId, volume);
}, { properties: ['status'] });

browser.tabs.onRemoved.addListener((tabId) => {
  coverageChecks.delete(tabId);
  browser.storage.session.remove(volumeKey(tabId));
});
