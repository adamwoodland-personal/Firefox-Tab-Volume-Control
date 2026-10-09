'use strict';

// Shared by the background script and the popup.

const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 400;

function clampVolume(volume) {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(volume)));
}

function volumeKey(tabId) {
  return `volume:${tabId}`;
}

// Volumes live in session storage: they survive the background script being unloaded
// while idle, and are forgotten when Firefox restarts (tab ids change then anyway).
async function getTabVolume(tabId) {
  const key = volumeKey(tabId);
  const stored = await browser.storage.session.get(key);
  return stored[key] ?? DEFAULT_VOLUME;
}
