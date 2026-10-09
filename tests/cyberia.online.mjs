// A real site that makes all its sound with Web Audio, inside a sandboxed iframe. Needs the
// internet, so it only runs with `npm run test:online`.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNear, gainValues, isAudible, setTabVolume, startFirefox, waitFor } from './helpers.mjs';

describe('cyberia.love', { timeout: 180_000 }, () => {
  let firefox;
  let page;
  let player;

  before(async () => {
    firefox = await startFirefox();
    page = await firefox.browser.newPage();
    await page.goto('https://cyberia.love/', { waitUntil: 'load' });
    player = await waitFor(() => page.frames().find((f) => f.url().endsWith('/player')), Boolean, 10000);
    assert.ok(player, 'player frame');
    await player.click('#toggle');
    const started = await waitFor(
      () => player.evaluate(() => document.getElementById('toggle').getAttribute('aria-pressed')),
      (pressed) => pressed === 'true', 20000);
    assert.equal(started, 'true', 'player started');
  });

  after(async () => {
    await firefox?.close();
  });

  it("routes the player's sound through the extension's gain node", async () => {
    assert.equal(await waitFor(() => isAudible(page), Boolean, 20000), true, 'audible');
    await setTabVolume(page, 25);
    await waitFor(() => gainValues(player), (gains) => gains.length > 0 && Math.abs(gains[0] - 0.25) < 0.01, 2000);
    assertNear(await gainValues(player), 0.25, 'player gain');
  });

  it('goes silent at 0% and comes back at 100%', async () => {
    await setTabVolume(page, 0);
    // Firefox clears its "playing" flag about 5 seconds after Web Audio goes quiet.
    assert.equal(await waitFor(() => isAudible(page), (audible) => !audible), false, 'silent');
    await setTabVolume(page, 100);
    assert.equal(await waitFor(() => isAudible(page), Boolean), true, 'audible again');
  });
});
