# Tab Volume Control (Firefox)

Set the volume of each Firefox tab separately, from silent up to a 400% boost. It works on
`<audio>`/`<video>` and on sound made with the Web Audio API (games, music apps, sites like
cyberia.love).

- **Right-click any tab → Volume** to pick a preset (0–400%) or open **Volume slider…** for that tab.
  If several tabs are selected, a preset applies to all of them.
- **Toolbar button** (or **Alt+Shift+V**) opens the slider for the current tab, plus a list of
  other tabs that are playing sound or have a changed volume, each with its own slider.
- A badge on the toolbar button shows the current tab's volume when it isn't 100%.
- The volume sticks to the tab across reloads and navigation until the tab is closed.

Slider controls: drag, scroll the mouse wheel (±5%), use the arrow keys or Page Up/Down,
click the big number to type a value, or double-click the slider to reset to 100%. The
mute button uses Firefox's own tab mute.

## Install

**For a quick try (removed when Firefox restarts):**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.

**To keep it installed:** release Firefox only installs signed add-ons. Sign it for
yourself (unlisted, so it isn't published on addons.mozilla.org):

1. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Run `npx web-ext sign --channel=unlisted --api-key=<key> --api-secret=<secret>` in this folder.
3. Open the `.xpi` file it writes to `web-ext-artifacts/` in Firefox.

If you sign it, change the `id` in `manifest.json` to something unique to you first.

Tabs that were already open when you installed the extension get `<audio>`/`<video>`
control the first time you open the slider or use the menu on them. Web Audio they had
already set up is only controlled after you reload them.

Disabling, removing or updating the extension while a page is open puts that page's sound
back to normal within about two seconds.

## How it works

- `background.js` stores each tab's volume, runs the tab context menu, keeps the badge up
  to date and passes changes on to the tab. It also checks every frame in the tab and
  injects the content scripts into any frame that's missing them.
- `content/content.js` runs in every frame, in the isolated content-script world, and does
  the actual volume control. It makes every change through Firefox's Xray wrappers, which
  always reach the browser's own code, so a page can't intercept them. Below 100% it lowers
  each `<audio>`/`<video>` element's real volume. Above 100% it routes the element through
  Web Audio, the only way to amplify it. It also checks regularly that nothing has undone
  its changes.
- `content/page.js` runs inside the page's own JavaScript, because some things can only be
  done from there:
  - it keeps the site seeing the volume *it* set, so the site's own volume slider keeps
    working and is multiplied by the tab volume;
  - it puts a gain node in front of every Web Audio context's output
    (`AudioContext.destination`), which `content.js` sets to the tab volume;
  - it points `content.js` to media and shadow roots it couldn't find on its own.

  The page can see and change anything in there, so `content.js` treats what it reports as
  untrusted and never takes commands from it. The two talk through events named with a
  secret that `content.js` hands over before any page script runs. If `content.js` stops
  answering, `page.js` restores every volume it changed.
- `popup/` is the slider panel.

## Tests

The tests run the extension in your installed Firefox (headless) against pages served
from a local web server, and check real volumes and the actual audio signal. They need
Node.js 22 or later.

```sh
npm install          # once
npm test             # all tests, about 45 seconds
npm run test:online  # also checks a live site (cyberia.love); needs the internet
npm run lint         # Mozilla's add-on linter
npm run build        # packages the extension into web-ext-artifacts/
```

Set `FIREFOX_PATH` if Firefox isn't in its usual place, and `HEADFUL=1` to watch the tests
run. The tests install a temporary copy of the extension with a few test-only hooks added
(see `tests/helpers.mjs`), so the extension itself contains no test code. `tests/`,
`package.json` and `node_modules/` are left out of the packaged extension.

| File | What it covers |
| --- | --- |
| `volume.test.mjs` | `<audio>`/`<video>`: turning down, boosting, the page's own volume, reloads |
| `web-audio.test.mjs` | Web Audio gain nodes, media the page routes through Web Audio, measured output |
| `page-interference.test.mjs` | A page trying to get around the tab volume |
| `frames.test.mjs` | data:, blob:, about:blank and srcdoc frames; tabs open before installing |
| `shadow-dom.test.mjs` | Media in open, closed and declarative shadow roots |
| `boost-check.test.mjs` | Deciding whether same-site media can be boosted |
| `removal.test.mjs` | Removing the extension restores every volume |
| `popup.test.mjs` | The popup, with the extension APIs mocked |
| `cyberia.online.mjs` | A live Web Audio site (`npm run test:online`) |

The tab context menu and the real toolbar popup can't be driven by Firefox's automation,
so try those by hand after changing them.

## Limitations

- Extensions can't add controls to the tab strip itself, so "click the tab" is a right-click
  menu plus the toolbar popup.
- Boosting an `<audio>`/`<video>` element above 100% isn't possible when Web Audio isn't
  allowed to read it: DRM-protected streams (Netflix, Spotify, Disney+, …) and media loaded
  from another site without CORS. That media only goes up to its own full volume. Turning
  it down works everywhere, and sound a page makes with Web Audio can always be boosted.
  For same-site media the extension makes a one-byte request to confirm the file isn't
  redirected to another site, and retries it if it fails. If the site's Content Security
  Policy blocks that request, the media can't be boosted. Firefox logs a "Security Error"
  in the page console when the media turns out to come from another site. This is expected.
- The tab volume always applies to `<audio>` and `<video>` elements. Its effect on Web
  Audio depends on code running inside the page, so a page that deliberately works around
  it can play its Web Audio sound at full volume. 0% is the extension turning the sound
  down; Firefox's own mute button is the guaranteed way to silence a tab.
- Firefox's "playing" speaker icon on a tab can stay on at 0% if the page feeds an
  `<audio>`/`<video>` element through Web Audio. The tab is still silent: Firefox counts
  the playing element itself, not what comes out.
- Firefox doesn't let extensions into some pages (`about:` pages, the PDF viewer, Reader
  View, addons.mozilla.org). The popup says so, and muting still works there.
- Volumes reset when Firefox restarts.

## License

[MIT](LICENSE) © Adam Woodland
