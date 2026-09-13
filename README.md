# TFT Helper

A small Electron desktop app that keeps a fixed set of websites in one panel —
a 52px icon rail on the left, the live site on the right — that floats over everything
else so you can read it without alt-tabbing out of a game.

The panel is frameless, 80% of the screen and centred, summoned and dismissed
with a global hotkey or the floating button. It is **not** always-on-top: it is
raised over whatever app is in front when you summon it, then behaves like any
other window, so alt-tabbing elsewhere puts it behind rather than leaving it
hovering over everything.

Built for TFT tools, but there is nothing TFT-specific in the code: the site
list is data, and you can add or remove anything.

**Pinned by default**

| Site | URL |
| --- | --- |
| TFT Academy | https://tftacademy.com/tierlist/comps |
| MetaTFT | https://www.metatft.com/explorer |
| DataTFT | https://www.datatft.com/comp/rank |
| LittleBuddyBot | https://www.littlebuddybot.com/tft-augment-odds |

Two of these differ from what you guessed, so: `data.tactics.tools` returns 404
(the site you may have been thinking of is `tactics.tools`, a different tool —
add it with `+` if you want it). `littlebuddy.gg` does not resolve;
LittleBuddyBot lives at `littlebuddybot.com`. `datatft.com` is the site branded
"云顶大数据" — it is the Chinese-language TFT data site people call DataTFT. If
you meant `tactics.tools`, right-click the DataTFT entry and pick **Edit…**.

---

## Setup

```bash
npm install
```

Node 18+ and Windows 10/11. `npm install` pulls Electron 44 (~250 MB on first
run, cached afterwards).

## Run in development

```bash
npm run dev
```

`npm run dev` is `electron . --dev`, which additionally opens DevTools for the
dock UI in a detached window. `npm start` runs it without DevTools.

## Build a Windows .exe

```bash
npm run build
```

Produces `dist/TFTHelper-Setup-1.0.0.exe` — an NSIS installer that lets you pick
the install directory and creates Start Menu and desktop shortcuts.

### Portable single-file .exe

```bash
npm run build:portable
```

Produces `dist/TFTHelper-1.0.0-portable.exe`: one self-contained executable, no
installer, no registry entries. Double-click and it runs. Two things to know
about the portable target:

- It unpacks itself into a temp directory on every launch, so it starts a bit
  slower than the installed version.
- **Its icon does not render on a desktop shortcut.** The portable target is an
  NSIS self-extracting stub, and Explorer cannot pull a 48px icon out of it —
  a shortcut pointing at it shows the generic application icon, or a blank page
  if you point `IconLocation` at a loose `.ico` instead. `ExtractAssociatedIcon`
  and `IShellItemImageFactory` both return the right image, so this does not
  show up in any obvious check. If you want a desktop shortcut with the real
  icon, use the NSIS installer above; it installs to
  `%LOCALAPPDATA%\Programs\TFT Helper\` and creates a shortcut that works.
- Your sites and logins still live in `%APPDATA%\TFT Helper\`, **not** next to the
  exe. If you want a genuinely no-trace portable build, add
  `app.setPath('userData', path.join(path.dirname(app.getPath('exe')), 'data'))`
  as the first line inside `app.whenReady()` in `src/main.js`.

`npm run pack` builds an unpacked app directory in `dist/win-unpacked/` without
producing an installer — useful for checking a packaged build quickly.

---

## File structure

```
tft-helper/
├── package.json              scripts + the whole electron-builder config
├── build/
│   ├── icon.ico              app / shortcut icon (256px, 7-hex TFT board)
│   ├── icon.png              same icon as PNG
│   └── tray.ico              notification-area icon (16/20/24/32/48/64px)
└── src/
    ├── main.js               main process: windows, config file, IPC, shortcuts
    ├── adblock.js            ad/tracker blocking for the embedded sites
    ├── diagnostics.js        background network probe + request counters
    ├── win32.js              alt-tab exclusion + foreground window queries
    ├── preload.js            the only bridge between page code and Electron
    └── renderer/
        ├── index.html        dock UI markup
        ├── app.css           dock UI styles
        ├── app.js            icon rail, webviews, add/edit/remove, titlebar
        ├── launcher.html     the floating button (markup + its small stylesheet)
        └── launcher.js       pointer handling for the floating button
```

Only five files have logic in them. `src/main.js` and `src/renderer/app.js` are
where you'll spend your time.

---

## Where your data lives

One JSON file: `%APPDATA%\TFT Helper\tfthelper.config.json`

```json
{
  "sites": [{ "id": "metatft", "name": "MetaTFT", "url": "...", "icon": "..." }],
  "activeSiteId": "metatft",
  "launcherPos": { "x": 24, "y": 24 },
  "launcherVisible": true,
  "hotkeys": { "overlay": null, "clickThrough": null },
  "overlay": {
    "bounds": { "x": 192, "y": 104, "width": 1536, "height": 832 }
  }
}
```

Written with plain `fs` — no `electron-store` — in `src/main.js`
(`loadConfig` / `saveConfig` / `flushConfig`). Window moves are debounced so
they don't hammer the disk; site edits are written immediately; everything is
flushed on quit.

### It cannot silently lose your sites any more

It used to. On any read error `loadConfig` fell back to the defaults, and the
next save wrote those defaults straight over your file. In practice: a write cut
off at shutdown left a truncated config, the next launch failed to parse it, and
one second later two added sites and the launcher position were gone for good.

Now three things stop that:

- **Atomic writes.** New content goes to `tfthelper.config.json.tmp`, which is
  then renamed over the real file. A plain `writeFileSync` truncates first and
  fills in after, so being killed in between leaves a broken file; a rename
  either happens or it doesn't.
- **A backup.** The same content is kept in `tfthelper.config.json.bak`, and
  `loadConfig` falls back to it if the main file won't parse.
- **Nothing is overwritten blindly.** A config that exists but won't parse is
  copied to `tfthelper.config.corrupt-<timestamp>.json` before anything else
  happens. Defaults are only used when there is genuinely nothing to recover.

Tested by truncating the config mid-file, the way an interrupted write would,
and relaunching: the corrupt copy was kept and the config came back from the
backup.

If sites ever do go missing, their partition folders under `Partitions\` survive
independently, and the HTTP cache inside them still holds the URLs they loaded —
which is how the two lost sites were recovered.

Site *sessions* (cookies, localStorage, logins) are stored separately by
Electron under `%APPDATA%\TFT Helper\Partitions\site-<id>\`. Removing a site from
the sidebar leaves its partition on disk on purpose, so re-adding the site keeps
you logged in. Delete the folder by hand if you want a clean slate.

---

## Ad blocking

On by default. Tray menu → **Block ads and trackers** toggles it, and the choice
is remembered (`adblock` in the config).

This uses Ghostery's engine (`@ghostery/adblocker-electron`) with the prebuilt
ads-and-tracking lists, not a hand-rolled blocklist. Hand-rolling gets you
domain blocking in about forty lines, but that stops the requests while leaving
the empty ad boxes behind, and misses anything served from the site's own
hostname. Real filter lists carry cosmetic rules too, which is what actually
makes the page look clean.

The compiled engine is cached at `%APPDATA%\TFT Helper\adblock-engine.bin`
(~6.5 MB). Lists are fetched and compiled once (~1.1 s), and every later launch
deserialises from disk in ~16 ms, including with no network. If that first fetch
fails, blocking is simply off — it never blocks startup.

Measured on a single site over 30 seconds:

| | requests | distinct hostnames |
| --- | --- | --- |
| before | 251 | 37 |
| after | 192 | **8** |

The hostname drop matters beyond the ads: fewer distinct hosts means far fewer
DNS lookups and outbound connections, which is the churn the diagnostics log was
added to investigate in the first place.

### One bug worth knowing about if you touch this

`enableBlockingInSession()` is called once per session, but internally it
registers two **global** `ipcMain` handlers for cosmetic filtering — and it does
that *before* registering the per-session network filters. So the second session
throws `Attempted to register a second handler`, and because the throw happens
first, network blocking silently never gets registered for any site after the
first one. It fails quietly: no error in the UI, ads still load.

`adblock.js` clears both handlers immediately before each call so the
re-registration succeeds. They are bound to the single blocker instance, so
whichever registration wins behaves identically.

---

## Diagnostics log

The app runs a background probe for as long as it is open and appends one JSON
object per line to `%APPDATA%\TFT Helper\logs\diagnostics.log`. Tray menu →
**Open diagnostics logs** opens the folder.

It exists to answer one question: when the machine loses internet while this app
is open, what failed first, and was the app doing anything unusual at the time?

Every 30 seconds it records two independent probes:

| Probe | What it proves |
| --- | --- |
| `dns` | a real DNS query via c-ares, straight to the configured servers — it bypasses the Windows DNS cache, so a failure means the resolver path is genuinely down |
| `tcp` | a raw TCP connect to `1.1.1.1:443`, which uses no DNS at all |

Together they split the diagnosis three ways: **tcp OK + dns dead** is the
resolver or DNS path, **both dead** is routing or NAT, and **neither ever fails
while the network is visibly broken** means the problem is somewhere the app
cannot see.

Alongside them it counts what the app itself is doing — `req` (requests since
the last sample), `hosts` (distinct hostnames), `netErrors` (per Chromium error
code), and `sockets` (`ours` is this app's own, which is the number that matters
if the theory is NAT-table exhaustion).

A sample line:

```json
{"t":"2026-09-08T14:42:44.019Z","up":30,"dns":{"ok":true,"ms":25,"n":8},
 "tcp":{"ok":true,"ms":20},"req":211,"hosts":41,"procs":6,
 "ip":{"Ethernet":"192.168.1.20"},"netErrors":{"net::ERR_CACHE_MISS":4}}
```

That one is worth reading closely: **211 requests across 41 distinct hostnames
in 30 seconds, from a single loaded site.** Multiply by four always-loaded sites
and the churn is substantial — which is exactly why background sites are now
unloaded when the panel is hidden. The very next sample after hiding reads
`"req":0,"hosts":0`.

On the first failing sample — and only the first, since an outage lasts many
samples — it also dumps `ipconfig /all`, `netstat -ano`, `route print` and
`nslookup` to `diagnostics-detail.log`, and marks the line `"detail":"dumped"`.
Recovery is marked `"recovered":true`.

Writes use `appendFileSync`: small, infrequent, and already on disk if the
machine is force-restarted, which a buffered stream would not be. The log
rotates at 5 MB keeping one old file.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous site |
| `Ctrl+1` … `Ctrl+9` | jump to the Nth site |
| `Ctrl+R` or `F5` | reload the current site |
| `Alt+←` / `Alt+→` | back / forward inside the current site |
| `Ctrl+F` | find in the current site |
| `Enter` / `Shift+Enter`, or `F3` / `Shift+F3` | next / previous match |
| `Esc` | close the find bar |
| `F12` or `Ctrl+Shift+I` | DevTools for the current site |
| `Ctrl+W` | hide the panel (launcher brings it back) |
| `Ctrl+Q` | quit TFT Helper completely |

---

## Ways to reach the app

| | |
| --- | --- |
| **Tray icon** | bottom-right notification area next to the clock, like Discord or the volume icon. Left-click toggles the window, right-click opens a menu |
| **Floating button** | the always-on-top circle, default position tucked a third past the **left edge** at `x -20, y 821`. Drag it anywhere |
| **Global hotkey** | `Ctrl+Alt+T` from anywhere, including mid-game |

The titlebar has a single close button, and it **hides** the panel — the app
keeps running behind the tray icon and the floating button. There is no minimise
or maximise; the panel is a companion window, not an app you manage. `Ctrl+Q`,
the tray menu, or the floating button's right-click menu quits for real.

### Launch on startup

Tray menu → **Launch on startup**. It registers a Windows login item with a
`--hidden` argument, so at sign-in the app comes up in the tray and as the
floating button rather than throwing the panel over your desktop.

The checkbox reads its state from Windows (`app.getLoginItemSettings`), not the
config file, so it stays correct if you remove the entry from Task Manager's
Startup tab. One gotcha if you touch this: the query only reports the item as
enabled when it is passed the **same args** it was registered with — without
them it reads `false` even while the entry exists. Verified on Electron 44. The
option is greyed out in development, where the registered exe would be
`electron.exe` rather than the app.

The tray menu has a **Floating button** checkbox, so you can turn the circle off
and drive everything from the tray if it gets in the way mid-game. That choice
is remembered (`launcherVisible` in the config).

There is no menu bar (`Menu.setApplicationMenu(null)`) and no OS titlebar — the
window is frameless and `#titlebar` in `index.html` replaces it. Every shortcut
in the table above is handled in `src/main.js` via
`webContents.on('before-input-event')` — see "Why the shortcuts are wired that
way" below.

---

## The overlay panel

The panel is frameless and opens at `x 189, y 119, 1536×832` — where it was
settled on a 1920×1040 work area — as long as that rectangle fits entirely on a
current monitor; otherwise it falls back to 80% of the work area, centred, so a
different screen can never strand it partly off-screen. Move or resize it and
your geometry is saved to `overlay.bounds`; the tray menu's **Reset panel size
and position** puts it back to that default.

**It follows the app you summoned it over.** It is shown on top of that app,
hidden the moment you alt-tab to anything else, and brought back when you return
— matched by process id, not window handle, because games and browsers swap
their windows around. It is topmost only while that app is in front, since a
borderless-fullscreen game re-asserts itself above any ordinary window. It is
excluded from Alt-Tab and the taskbar (`WS_EX_TOOLWINDOW`). Only the floating
launcher button stays topmost all the time, because it has to be reachable to
summon the panel in the first place.

| Hotkey | Action |
| --- | --- |
| `Ctrl+Alt+T` | show / hide the panel |
| `Ctrl+Alt+A` | toggle click-through |

These are `globalShortcut` registrations, so unlike everything in the shortcut
table they fire **while the game has focus** — that is the entire point of the
mode. The in-app shortcuts use `before-input-event`, which only sees keys when a
TFT Helper window is focused.

**The hotkeys are not fixed.** A `globalShortcut` fails silently when another
program already owns the combo (`Ctrl+Alt+Space`, the original first choice, is
taken on this machine), so each action has a fallback list in `KEY_FALLBACKS`
and the app takes the first combo that registers. Whichever one won is printed
to the console at startup and shown in the titlebar while overlay mode is on.
To force a specific combo, set it in the config file:

```json
"hotkeys": { "overlay": "Alt+Shift+G", "clickThrough": "Alt+Shift+H" }
```

**Click-through** (`setIgnoreMouseEvents(true, { forward: true })`) keeps the
panel visible while the mouse passes straight through to the game. The titlebar
turns purple so you can tell at a glance. `forward: true` keeps mousemove
flowing to the renderer, so hover states still work when you switch back.

Because the window is frameless (`frame: false` — required for a borderless
panel, and it cannot be changed after the window is created), `#titlebar` in
`index.html` replaces the OS titlebar. The bar is the drag region; the caption
buttons are inline SVG rather than font glyphs, which render at whatever weight
the font feels like and look ragged at 10px.

### The anti-cheat question

This is a plain window that gets raised on demand. No injection, no DirectX
hooking, no reading game memory. That distinction is the whole thing: Riot's Vanguard
targets injected code and cheat drivers, not separate windows, and TFT Helper
only renders web pages — it never reads game state, so it also stays clear of
the feature rules (no enemy ult timers, no in-overlay ads).

The cost of staying on that side of the line is real, though: **an *exclusive*
fullscreen game will cover the overlay.** Windows hands the display to the game
and no window-manager trick gets around it — only an injected overlay would, and
that is exactly what we are not doing. **Borderless windowed works**, and it is
the League/TFT default, so in practice this rarely comes up. If the panel goes
invisible over a game, change that game to borderless windowed.

---

## Design decisions, and why

### `<webview>` instead of `BrowserView` / `WebContentsView`

`<webview>` wins here, clearly:

- **Layout.** A `<webview>` is a DOM element, so CSS positions it. A
  `BrowserView`/`WebContentsView` is a native child view with pixel bounds you
  must recompute yourself on every window resize, sidebar change, and DPI
  change. That is a pile of geometry code for zero benefit.
- **Z-order.** A native view always paints *on top of* the whole HTML page.
  Your add-site dialog, right-click menu and error overlay would all be hidden
  behind the site. With `<webview>` they're just siblings in the DOM.
- **Session persistence is identical.** Both take a `partition`. `<webview>`
  takes it as an attribute (`partition="persist:site-metatft"`), which is one
  line; the native view needs a `session.fromPartition()` call. Neither one
  reloads when you switch away — a `WebContents` stays alive as long as you
  keep it, in both cases.

What `<webview>` costs you: it's a heavier abstraction (out-of-process iframe
plumbing), Electron's docs discourage it for new apps, and its API is only
usable after the guest attaches (hence the `try/catch` around the command
handler in `app.js`). For a container app that never hits those limits, the
tradeoff is worth it. If Electron ever drops the tag, the migration is:
`WebContentsView` per site, one `setBounds()` call driven by a
`ResizeObserver` on the content area, and moving the dialog/menu into native
`Menu`/`BrowserWindow` popups.

### Sites don't reload when you switch away

Each site's `<webview>` is created on first use and then **never removed from
the DOM**. Switching only toggles a class:

```css
.view-wrap        { position: absolute; inset: 0; visibility: hidden; }
.view-wrap.active { visibility: visible; }
```

`visibility: hidden` rather than `display: none` on purpose — a `display: none`
webview has no layout box, so it forgets its size and has to re-lay-out (and
sometimes re-render badly) when you switch back. Hidden-but-laid-out costs
nothing to paint and keeps the size correct.

**Every site loads at startup**, so the first click on any of them is instant.
The site you were last on gets a head start: the rest wait until it has finished
loading, or 8 seconds, whichever comes first. On a slow connection four
simultaneous page loads would all crawl — including the one on screen.

**Once loaded, a site is never unloaded.** Switching sites, hiding the panel and
alt-tabbing away all leave every page exactly as it was — nothing reloads behind
your back. This is a deliberate choice: coming back to the panel mid-game and
waiting on a page load is worse than the cost of keeping the pages resident.

That cost is real, though. A single loaded site was measured at ~200 requests
across ~40 distinct hostnames per 30 seconds, and four resident sites keep doing
that while the panel is hidden. If the machine ever loses network while the app
is open, the diagnostics log below is what tells you whether that churn was
involved.

### Why the shortcuts are wired that way

When a `<webview>` has focus, keystrokes go to the *guest* page, so a `keydown`
listener in `app.js` never sees them. `globalShortcut` would work but is far too
rude — it would steal `Ctrl+Tab` from every other program on your machine.

The middle ground is `webContents.on('before-input-event')`, registered from
`app.on('web-contents-created')` so it covers the dock UI *and* every webview
guest. Keys are intercepted before the page sees them, only while a TFT Helper
window has focus. A menu accelerator would also mostly work, but then the same
key fires twice (once from the menu, once here), so the menu is gone entirely.

### Embed-failure fallback

Worth being straight with you about what this actually catches. An `<iframe>`
gets blocked by `X-Frame-Options` and CSP `frame-ancestors`; a `<webview>`
usually **doesn't**, because it's a top-level browsing context in its own
process — it behaves like a browser tab, not like a frame. So the classic
"refused to connect" iframe failure mostly won't happen here.

What does happen, and what `wireViewEvents()` in `app.js` handles:

| Signal | Meaning |
| --- | --- |
| `did-fail-load` (main frame, `errorCode !== -3`) | DNS/TLS/network failure, HTTP-level block |
| `did-finish-load` landing on `about:blank` | site rendered nothing |
| `render-process-gone` | the site's renderer crashed |
| 25s watchdog after `did-start-loading` | load hung |

Any of those shows an overlay with the reason, an **Open in browser** button
(`shell.openExternal`), and **Retry**. `errorCode -3` (`ERR_ABORTED`) is
ignored because a page replacing its own navigation fires it constantly and it
is not an error.

One more thing in the same area: each webview gets a `useragent` attribute with
`Electron/x` and `TFT Helper/x` stripped out, so sites see plain Chrome. Some
sites serve a degraded page or refuse login to unrecognised user agents, and
this heads that off before you ever see a fallback screen.

### Floating launcher: click vs. drag

The obvious approach is `-webkit-app-region: drag` on the button plus a small
non-draggable hit zone for clicks. It's a bad experience on a 56px circle: the
OS swallows the whole gesture inside a drag region, so you never get a reliable
click, and the "safe" click zone ends up tiny.

So the button is one pointer target with no drag region at all:

1. `pointerdown` in `launcher.js` calls `setPointerCapture` (so `pointerup`
   still arrives after the cursor leaves the 64px window) and sends
   `launcher:drag-start`.
2. `src/main.js` snapshots the cursor, then polls
   `screen.getCursorScreenPoint()` every 16ms and calls
   `launcherWindow.setPosition()`. Polling the OS cursor rather than reacting to
   the button's own `mousemove` avoids the feedback loop you get when a window
   moves in response to events measured relative to itself.
3. On `pointerup`, if the cursor travelled **less than 5px** it was a click, so
   toggle the dock. Otherwise it was a drag, so just save the new position.

It starts at `x -20, y 821`, deliberately about a third off the left edge, as
long as at least 24 px of it is on a screen in both directions; otherwise it
falls back to the bottom-left of the work area. The same 24 px rule decides
whether a *saved* position is still usable, so partly off-screen is kept but a
sliver too thin to click is not. Drop it anywhere; the position is written
to `launcherPos` and restored next launch. If that monitor is gone at startup, `validLauncherPos()` checks the
saved point against every current display and falls back to bottom-right of the
primary one, so the button can't strand itself off-screen.

**Right-click the launcher** for a native menu: open/hide, reset position, quit.

### Click behaviour: I picked three-state, not two

| Dock state when you click | What happens |
| --- | --- |
| hidden | show and focus |
| visible, in the background | **raise to front** |
| visible and focused | hide |

Plain show/hide is worse in the case that matters — dock open but buried behind
the game — where "hide" does nothing visible and you have to click twice. One
wrinkle worth knowing about, since you'll hit it if you touch this code:
clicking the launcher focuses the *launcher* window first, so by the time the
IPC message arrives `mainWindow.isFocused()` is already `false`. `toggleMain()`
works around it by tracking the last `blur` timestamp and treating "lost focus
in the last 400ms" as "was focused".

Closing the dock with the X button **hides** it rather than quitting, so the
launcher stays as your way back in. Quit with `Ctrl+Q` or the launcher's
right-click menu.

---

## Known limitations on Windows

You asked me to flag these, and there are three real ones.

1. **`alwaysOnTop` levels are a macOS concept.** The floating launcher button
   calls `setAlwaysOnTop(true, 'screen-saver')`, the highest sensible level, but
   on Windows Electron effectively maps every level onto the same
   `HWND_TOPMOST`. The button floats above normal and maximised windows and
   above borderless-windowed games. It will **not** show above a game running in
   *exclusive* fullscreen — Windows gives that mode the display outright, and no
   Electron flag changes it. TFT and the League client run borderless by
   default, so in practice this is fine; if a game hides the button, switch that
   game to borderless windowed. (The panel itself is not topmost at all — see
   "The overlay panel" above.)

2. **`setVisibleOnAllWorkspaces` is a no-op on Windows.** It's implemented for
   macOS Spaces and some Linux window managers. The call is in
   `createLauncherWindow()` and is harmless, but if you use Windows virtual
   desktops (Win+Ctrl+←/→) the launcher stays on the desktop it was created on.
   There is no supported Electron API for pinning a window across Windows
   virtual desktops; it needs the undocumented `IVirtualDesktopManager` COM
   interface via a native module, which is not worth it here.

3. **Transparent topmost windows and DPI changes.** Dragging the launcher
   button between monitors with different scaling can leave it a few pixels off.
   Right-click → *Reset position* fixes it.

Also worth knowing: the launcher window is focusable, so clicking it takes focus
from whatever is in front. If you'd rather it never steal focus, set
`focusable: false` in `createLauncherWindow()` — the click and drag still work,
but you lose the right-click menu, so keep `Ctrl+Q` in mind for quitting.

---

## Extending it

You're a MERN dev, so the mental model that helps most: **`main.js` is your
Express server, the renderer is your React app, `preload.js` is the API
contract between them.** Renderers can't `require()` anything; they can only
call what `preload.js` puts on `window.tftHelper`. Adding a capability is always
three edits — an `ipcMain` handler in `main.js`, a method in `preload.js`, a
call site in the renderer.

Some obvious next steps and where they'd go:

- **Per-site zoom** — `webview.setZoomFactor()` in `app.js`, store the value on
  the site object; it persists for free via `saveSites`.
- **Unread badges** — listen for `ipc-message` from a guest, or poll the page
  title in the `page-title-updated` handler that's already there.
- **A real navigation bar** — the back/forward/reload plumbing already exists in
  the command handler at the bottom of `app.js`; it just needs buttons.
- **Custom icons instead of favicons** — `site.icon` is any image URL or `data:`
  URI. Set it by hand in the JSON and `renderSidebar()` will use it.

### Icons

`build/icon.ico` (app + desktop shortcut) and `build/tray.ico` (notification
area) are original generated artwork — a TFT hex-board cell cluster in gold on
dark navy, with a blue "your unit" cell in the middle. No Riot assets are
bundled, so there is nothing to worry about if you share the build.

Replace `build/icon.ico` (256×256 minimum) and `build/tray.ico` (needs small
sizes to stay crisp at 16px) and rebuild to change them. The floating button's
glyph is inline SVG at the bottom of `src/renderer/launcher.html`, using the same
three shapes.

## License

MIT.
