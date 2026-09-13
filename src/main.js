'use strict';

/**
 * TFT Helper - main process.
 *
 * Two windows:
 *   1. mainWindow     - the panel (icon rail + <webview> content area). Not
 *                       always-on-top: it is raised over whatever is in front
 *                       when summoned, then behaves like any other window.
 *   2. launcherWindow - the small frameless always-on-top floating button
 *
 * Everything the renderers are allowed to do goes through the IPC handlers near
 * the bottom of this file and is exposed in src/preload.js. Renderers have no
 * Node access (contextIsolation on, nodeIntegration off).
 */

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const diagnostics = require('./diagnostics');
const win32 = require('./win32');
const adblock = require('./adblock');

const IS_DEV = process.argv.includes('--dev');

// Passed by the login item. Launching at sign-in should put the app in the
// tray and the floating button, not throw an 80%-of-the-screen panel over the
// desktop every time the machine boots.
const LOGIN_ARGS = ['--hidden'];
const STARTED_HIDDEN = process.argv.includes('--hidden');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.ico');

const LAUNCHER_SIZE = 64;   // window box; the visible circle inside it is 56px
const DRAG_THRESHOLD = 5;   // px of movement below which a drag counts as a click

// Global hotkeys. These are globalShortcuts, i.e. they fire while the
// game has focus, which is the whole point - the in-app shortcuts in
// before-input-event only work when a TFT Helper window is focused.
//
// A globalShortcut fails silently if another program already owns the combo,
// so each action gets a list and we take the first one that registers. Set
// "hotkeys" in the config file to force a specific combo.
const KEY_FALLBACKS = {
  overlay: [
    'CommandOrControl+Alt+Space',
    'CommandOrControl+Alt+T',
    'Alt+Shift+T',
    'CommandOrControl+Alt+O',
  ],
  clickThrough: [
    'CommandOrControl+Alt+A',
    'CommandOrControl+Alt+C',
    'Alt+Shift+A',
  ],
};
const activeKeys = { overlay: null, clickThrough: null };

let mainWindow = null;
let launcherWindow = null;
let tray = null;            // must stay referenced or it gets garbage collected
let clickThrough = false;
let mainBlurredAt = 0;      // used to tell "hide" from "raise" (see togglePanel)
let drag = null;            // active launcher drag state
let dragTimer = null;
let lastForeignWindow = 0;  // last foreground window that was not one of ours
let attachedHwnd = 0;       // window the panel was summoned over
let attachedPid = 0;        // its process - what we actually match on
let panelWanted = false;    // user has summoned the panel and not dismissed it
let foregroundTimer = null;

/* ------------------------------------------------------------------------ */
/* Config: one JSON file in %APPDATA%/TFT Helper/tfthelper.config.json          */
/* ------------------------------------------------------------------------ */

const DEFAULT_SITES = [
  { id: 'tftacademy', name: 'TFT Academy', url: 'https://tftacademy.com/tierlist/comps', icon: null },
  { id: 'metatft', name: 'MetaTFT', url: 'https://www.metatft.com/explorer', icon: null },
  { id: 'datatft', name: 'DataTFT', url: 'https://www.datatft.com/comp/rank', icon: null },
  { id: 'littlebuddy', name: 'LittleBuddyBot', url: 'https://www.littlebuddybot.com/tft-augment-odds', icon: null },
];

const DEFAULT_CONFIG = {
  sites: DEFAULT_SITES,
  activeSiteId: 'tftacademy',
  launcherPos: { x: null, y: null },
  launcherVisible: true,
  // Force a specific global hotkey, e.g. "Alt+Shift+G". Leave null to let the
  // app pick the first free combo from KEY_FALLBACKS.
  hotkeys: { overlay: null, clickThrough: null },
  adblock: true,
  // null bounds means "use defaultOverlayBounds()" - the preferred position if
  // it fits the current monitors. Move or resize the panel and it is saved here.
  overlay: {
    bounds: { x: null, y: null, width: null, height: null },
  },
};

let configPath = null;
let config = null;
let saveTimer = null;

/**
 * JSON.parse chokes on a UTF-8 byte-order mark, and anything that edits this
 * file on Windows adds one - Notepad and PowerShell's Set-Content both do.
 */
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * When this build was produced, taken from the app bundle's own mtime - in a
 * packaged app that is app.asar, i.e. the moment electron-builder wrote it.
 * Shown in the titlebar so "am I running the new one?" is answerable at a
 * glance instead of by digging through install paths.
 */
function buildStamp() {
  try {
    const when = fs.statSync(app.getAppPath()).mtime;
    const date = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Load the config, and never lose it.
 *
 * This used to fall back to DEFAULT_CONFIG on any read error - and the next
 * debounced save then wrote those defaults straight over the user's file. On
 * 2026-09-13 that silently wiped two added sites and the launcher position:
 * the previous shutdown's write was cut off, the truncated file failed to
 * parse, and one second after launch the defaults replaced it for good.
 *
 * Now: a file that exists but will not parse is copied aside (never
 * overwritten), the last good backup is tried next, and defaults are only used
 * when there is genuinely nothing to recover.
 */
function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'tfthelper.config.json');
  const readJson = (file) => JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));

  let disk = null;
  try {
    disk = readJson(configPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const aside = configPath.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      try { fs.copyFileSync(configPath, aside); } catch { /* unreadable too */ }
      console.error('[TFT Helper] config unreadable (' + err.message + '), kept a copy at', aside);
    }
    try {
      disk = readJson(configPath + '.bak');
      console.warn('[TFT Helper] restored config from backup');
    } catch {
      disk = null;
    }
  }

  if (!disk) {
    config = structuredClone(DEFAULT_CONFIG); // first run, nothing to recover
    return;
  }

  config = { ...structuredClone(DEFAULT_CONFIG), ...disk };
  // Shallow merge above would drop new sub-keys from an older config file.
  config.overlay = { ...structuredClone(DEFAULT_CONFIG.overlay), ...(disk.overlay || {}) };
  config.hotkeys = { ...structuredClone(DEFAULT_CONFIG.hotkeys), ...(disk.hotkeys || {}) };
  if (!Array.isArray(config.sites) || config.sites.length === 0) {
    config.sites = structuredClone(DEFAULT_SITES);
  }
}

/** Debounced write - this gets called a lot (resize, favicon updates, ...). */
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushConfig, 250);
}

/**
 * Atomic write: the new content goes to a temp file which is then renamed over
 * the real one. A plain writeFileSync truncates the file first and fills it
 * after, so being killed in between - Windows ending the process at shutdown,
 * a force-quit - leaves an empty or half-written config. A rename either
 * happens or it does not.
 *
 * The same content is kept in .bak, which loadConfig falls back to if the main
 * file is ever unreadable for any other reason (a bad hand edit, say).
 */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function flushConfig() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!configPath || !config) return;
  try {
    const text = JSON.stringify(config, null, 2);
    writeAtomic(configPath, text);
    writeAtomic(configPath + '.bak', text);
  } catch (err) {
    console.error('[TFT Helper] could not write config:', err.message);
  }
}

/* ------------------------------------------------------------------------ */
/* Main window                                                               */
/* ------------------------------------------------------------------------ */

function createMainWindow() {
  const b = onScreen(config.overlay.bounds) ? config.overlay.bounds : defaultOverlayBounds();
  mainWindow = new BrowserWindow({
    ...b,
    minWidth: 380,
    minHeight: 400,
    show: false,
    // Frameless: the panel is borderless, and `frame` cannot be changed after
    // the window is created. #titlebar in index.html replaces it.
    frame: false,
    backgroundColor: '#12151d',
    icon: ICON,
    title: 'TFT Helper',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,     // required for the <webview> tags in the renderer
      spellcheck: false,
    },
  });

  // Deliberately NOT alwaysOnTop. Instead the panel follows the app you
  // summoned it over (see watchForeground): it shows on top of that app, hides
  // when you alt-tab to something else, and comes back when you return. Only
  // the floating launcher button stays topmost, because it has to be reachable
  // to summon this in the first place.
  //
  // It is also taken out of the Alt-Tab list: this is a companion to whatever
  // you are doing, not an app you tab to in its own right.
  win32.hideFromAltTab(win32.hwndOf(mainWindow));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!STARTED_HIDDEN) mainWindow.show();
  });

  const rememberBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const { x, y, width, height } = mainWindow.getNormalBounds();
    config.overlay.bounds = { x, y, width, height };
    saveConfig();
  };
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  mainWindow.on('blur', () => { mainBlurredAt = Date.now(); });

  // Sites stay loaded while the panel is hidden - by request, so coming back
  // to it mid-game never costs a page load. That means they keep polling in the
  // background, which is why the diagnostics log records visibility: if the
  // network dies again, we need to know whether the panel was open at the time.
  const markHidden = () => diagnostics.logEvent('panel-hidden');
  mainWindow.on('hide', markHidden);
  mainWindow.on('minimize', () => {
    // However it got minimised, stop following - otherwise we undo it.
    panelWanted = false;
    attachedHwnd = 0;
    attachedPid = 0;
    markHidden();
  });

  mainWindow.on('show', () => diagnostics.logEvent('panel-shown'));

  // The X button hides the panel instead of quitting - the hotkey, tray icon
  // and floating button are how you get it back. Ctrl+Q quits.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    rememberBounds();
    mainWindow.hide();
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/**
 * Show/hide the panel. Used by the hotkey, the tray icon and the launcher.
 *
 * Three states, because the panel is no longer topmost: if it is already in
 * front, hide it; if it is open but buried behind the app you alt-tabbed to,
 * raise it; otherwise show it. Raising has to take focus - that is the only
 * way a non-topmost window gets above the current foreground app.
 */
function togglePanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow();

  // Clicking the launcher moves focus to the launcher window first, so by the
  // time this runs isFocused() is already false. Treat "lost focus within the
  // last 400ms" as "was in front".
  const wasInFront = mainWindow.isFocused() || Date.now() - mainBlurredAt < 400;

  if (mainWindow.isVisible() && !mainWindow.isMinimized() && wasInFront) {
    panelWanted = false;
    attachedHwnd = 0;
    attachedPid = 0;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.hide();
    return;
  }
  raisePanel();
}

/** Bring the panel above whatever is currently in front. */
function raisePanel() {
  panelWanted = true;
  attachToForeground();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // A brief topmost flip is the reliable way to jump the foreground window on
  // Windows; without it show() can leave the panel behind the active app.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.focus();
}

/**
 * Attach the panel to the app you were last in.
 *
 * The launcher button takes focus the moment you press it, so by the time we
 * get here the game is no longer the foreground window - which is why
 * lastForeignWindow is tracked continuously rather than sampled now.
 *
 * Note this does NOT use Win32 window ownership (GWLP_HWNDPARENT). Ownership
 * gives the right z-order for free, but it also ties our window's lifetime and
 * visibility to a foreign one: Windows hides owned windows with their owner and
 * destroys them with it. Testing against a browser showed exactly that - the
 * panel got hidden seconds after attaching, because the app it was owned by
 * swapped the window underneath us. Following the foreground window instead
 * costs a poll but keeps our window entirely our own.
 */
function attachToForeground() {
  attachedHwnd = win32.isWindow(lastForeignWindow) ? lastForeignWindow : 0;
  attachedPid = win32.windowPid(attachedHwnd);
  diagnostics.logEvent('panel-attach', { target: attachedHwnd || null, pid: attachedPid || null });
}

/**
 * Follow the app the panel is attached to: visible while that app is in front,
 * hidden while you are in something else, and back again when you return. The
 * panel is only ever shown here with showInactive + moveTop, so returning to
 * the game does not steal the game's keyboard focus.
 */
function watchForeground() {
  foregroundTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const ours = new Set([win32.hwndOf(mainWindow)]);
    if (launcherWindow && !launcherWindow.isDestroyed()) ours.add(win32.hwndOf(launcherWindow));

    const fg = win32.foregroundWindow();
    const isOurs = ours.has(fg);
    if (fg && !isOurs && win32.isVisible(fg)) lastForeignWindow = fg;

    // Only follow when the user has actually summoned the panel, and only
    // while the app it was summoned over still exists.
    if (!panelWanted || !attachedPid) return;
    if (attachedHwnd && !win32.isWindow(attachedHwnd)) {
      attachedHwnd = 0;
      diagnostics.logEvent('panel-detach', { reason: 'target-window-gone' });
      return;
    }

    // Match on process, not window handle. Games and browsers swap their
    // top-level windows around (loading screen to game, tab to tab), and a
    // handle captured at summon time goes stale; the process does not.
    const shouldShow = isOurs || win32.windowPid(fg) === attachedPid;
    const visible = mainWindow.isVisible() && !mainWindow.isMinimized();

    if (shouldShow) {
      if (!visible) mainWindow.showInactive();
      // Topmost ONLY while the app we are attached to is in front. showInactive
      // alone leaves the panel underneath a borderless-fullscreen game, which
      // re-asserts itself over any ordinary window. Because this is dropped the
      // moment you switch to anything else, it never floats over other apps.
      if (!mainWindow.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.moveTop();
    } else if (visible) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.hide();
    }
  }, 300);
  if (foregroundTimer.unref) foregroundTimer.unref();
}

/* ------------------------------------------------------------------------ */
/* Overlay geometry and click-through                                        */
/* ------------------------------------------------------------------------ */

/**
 * The panel is always an overlay: a translucent always-on-top window, 80% of
 * the screen and centred, driven by global hotkeys so it works while the game
 * has focus.
 *
 * This is deliberately a plain topmost window - no injection, no hooking, no
 * reading game memory. That is the category Riot's anti-cheat targets; an
 * ordinary window that renders web pages is not. The cost of staying on the
 * safe side is that an *exclusive* fullscreen game will cover it. Borderless
 * windowed (League and TFT's default) works.
 */

function onScreen(b) {
  if (!b || !Number.isInteger(b.x) || !Number.isInteger(b.y)) return false;
  return screen.getAllDisplays().some(({ bounds }) =>
    b.x + b.width > bounds.x && b.x < bounds.x + bounds.width &&
    b.y + b.height > bounds.y && b.y < bounds.y + bounds.height);
}

// Where the user settled the panel on 2026-09-13, on a 1920x1040 work area.
const PREFERRED_PANEL = { x: 189, y: 119, width: 1536, height: 832 };

/** True if some display's work area fully contains the rectangle. */
function fitsOnScreen(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x >= w.x && b.y >= w.y &&
    b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height);
}

/**
 * The preferred position if it fits on the current monitors, otherwise 80% of
 * the primary work area, centred. The fallback matters: fixed pixel coordinates
 * from one screen would strand the panel partly off a smaller one.
 */
function defaultOverlayBounds() {
  if (fitsOnScreen(PREFERRED_PANEL)) return { ...PREFERRED_PANEL };
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.round(workArea.width * 0.8);
  const height = Math.round(workArea.height * 0.8);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/** Put the panel back at its default position - for when you lose it off-screen. */
function resetPanelBounds() {
  const b = defaultOverlayBounds();
  config.overlay.bounds = b;
  saveConfig();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds(b);
}

/**
 * Click-through: the panel stays visible but the mouse passes straight to the
 * game underneath. `forward: true` keeps mousemove flowing to the renderer so
 * hover states still work if you turn it back off.
 */
function setClickThrough(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clickThrough = Boolean(on);
  mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  mainWindow.webContents.send('command', { type: 'click-through', payload: clickThrough });
}

function registerGlobalShortcuts() {
  const handlers = {
    overlay: togglePanel,
    clickThrough: () => setClickThrough(!clickThrough),
  };

  for (const name of Object.keys(handlers)) {
    const preferred = config.hotkeys && config.hotkeys[name];
    const candidates = preferred ? [preferred, ...KEY_FALLBACKS[name]] : KEY_FALLBACKS[name];
    activeKeys[name] = null;

    for (const key of candidates) {
      let ok = false;
      try { ok = globalShortcut.register(key, handlers[name]); } catch { ok = false; }
      if (ok) { activeKeys[name] = key; break; }
    }

    if (!activeKeys[name]) {
      console.warn(`[TFT Helper] every candidate hotkey for "${name}" is taken by ` +
        'another app - set "hotkeys" in the config file to something free');
    }
  }
  console.log('[TFT Helper] hotkeys:', activeKeys);
}

/* ------------------------------------------------------------------------ */
/* Floating launcher window                                                  */
/* ------------------------------------------------------------------------ */

// Where the user parked the button on 2026-09-13, deliberately tucked about a
// third past the left edge of a 1920x1080 screen.
const PREFERRED_LAUNCHER = { x: -20, y: 821 };

// How much of the button must be on some screen, in both directions, for a
// position to count as usable. Partly off-screen is fine and intended; a
// one-pixel sliver is not something you can click.
const LAUNCHER_MIN_VISIBLE = 24;

function launcherReachable(p) {
  if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return false;
  return screen.getAllDisplays().some(({ bounds: b }) => {
    const visibleW = Math.min(p.x + LAUNCHER_SIZE, b.x + b.width) - Math.max(p.x, b.x);
    const visibleH = Math.min(p.y + LAUNCHER_SIZE, b.y + b.height) - Math.max(p.y, b.y);
    return visibleW >= LAUNCHER_MIN_VISIBLE && visibleH >= LAUNCHER_MIN_VISIBLE;
  });
}

/**
 * The preferred spot if it is reachable on the current monitors, otherwise the
 * bottom-left of the work area - so a different screen setup can never leave
 * the button stranded where nothing of it can be clicked.
 */
function defaultLauncherPos() {
  if (launcherReachable(PREFERRED_LAUNCHER)) return { ...PREFERRED_LAUNCHER };
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + 24,
    y: workArea.y + workArea.height - LAUNCHER_SIZE - 24,
  };
}

/** A saved position is useless if that monitor is gone - fall back if so. */
function validLauncherPos() {
  const p = config.launcherPos;
  return launcherReachable(p) ? p : defaultLauncherPos();
}

function createLauncherWindow() {
  const { x, y } = validLauncherPos();

  launcherWindow = new BrowserWindow({
    width: LAUNCHER_SIZE,
    height: LAUNCHER_SIZE,
    x,
    y,
    show: config.launcherVisible !== false, // can be turned off from the tray menu
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,      // no taskbar entry of its own
    alwaysOnTop: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' is the highest practical level. On Windows the level string
  // is mostly a macOS concept and is largely ignored - see the README for what
  // this does and does not cover.
  launcherWindow.setAlwaysOnTop(true, 'screen-saver');
  launcherWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win32.hideFromAltTab(win32.hwndOf(launcherWindow));
  launcherWindow.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
}

/** Show or hide the floating button (toggled from the tray menu). */
function setLauncherVisible(visible) {
  config.launcherVisible = visible;
  saveConfig();
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  // showInactive, not show: revealing the button should not steal focus from
  // whatever you were doing.
  if (visible) launcherWindow.showInactive();
  else launcherWindow.hide();
}

function resetLauncherPos() {
  const p = defaultLauncherPos();
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.setPosition(p.x, p.y);
  config.launcherPos = p;
  saveConfig();
}

/* ------------------------------------------------------------------------ */
/* Tray icon (Windows notification area, next to the clock)                  */
/* ------------------------------------------------------------------------ */

function trayMenu() {
  // Rebuilt on every right-click so the checkbox reflects the current state.
  return Menu.buildFromTemplate([
    { label: 'Open TFT Helper', click: showMain },
    { label: 'Reset panel size and position', click: resetPanelBounds },
    {
      label: 'Block ads and trackers',
      type: 'checkbox',
      checked: adblock.isEnabled(),
      enabled: adblock.isReady(),
      click: (item) => {
        config.adblock = adblock.setEnabled(item.checked);
        saveConfig();
        diagnostics.logEvent('adblock-toggled', { enabled: config.adblock });
      },
    },
    {
      label: 'Launch on startup',
      type: 'checkbox',
      // Windows is the source of truth, not the config file - the entry can be
      // removed from Task Manager's Startup tab behind our back. The args must
      // match what was registered or Windows reports it as not set.
      checked: app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
      // In development the registered exe would be electron.exe, not this app.
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS });
        diagnostics.logEvent('launch-on-startup', { enabled: item.checked });
      },
    },
    { label: 'Open diagnostics logs', click: () => shell.openPath(diagnostics.logDir()) },
    { type: 'separator' },
    {
      label: 'Floating button',
      type: 'checkbox',
      checked: config.launcherVisible !== false,
      click: (item) => setLauncherVisible(item.checked),
    },
    { label: 'Reset floating button position', click: resetLauncherPos },
    { type: 'separator' },
    { label: 'Quit TFT Helper', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(TRAY_ICON);
  tray.setToolTip('TFT Helper');
  // Left click behaves like the floating button; right click opens the menu.
  tray.on('click', togglePanel);
  tray.on('double-click', showMain);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow();
  raisePanel();
}

function stopDrag(commit) {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!drag) return;
  const wasClick = drag.moved < DRAG_THRESHOLD;
  drag = null;
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  const [x, y] = launcherWindow.getPosition();
  config.launcherPos = { x, y };
  saveConfig();
  if (commit && wasClick) togglePanel();
}

/* ------------------------------------------------------------------------ */
/* IPC                                                                       */
/* ------------------------------------------------------------------------ */

ipcMain.handle('state:get', () => ({
  sites: config.sites,
  activeSiteId: config.activeSiteId,
}));

ipcMain.handle('state:save-sites', (_e, sites) => {
  if (!Array.isArray(sites)) return false;
  config.sites = sites;
  // Written straight away, not debounced: site edits are rare and they are
  // the one thing in the config a user cannot recreate by dragging a window.
  flushConfig();
  return true;
});

ipcMain.on('state:set-active', (_e, id) => {
  config.activeSiteId = id;
  saveConfig();
});

ipcMain.on('shell:open-external', (_e, url) => openExternal(url));

/* Custom titlebar (the window is frameless, so these replace the OS buttons) */
ipcMain.on('win:hide', () => {
  panelWanted = false;
  attachedHwnd = 0;
  attachedPid = 0;
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.hide();
  }
});
ipcMain.handle('win:state', () => ({
  clickThrough,
  keys: activeKeys,
  version: app.getVersion(),
  build: buildStamp(),
}));

ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });

// Launcher drag. The renderer only reports "pointer down" / "pointer up"; the
// window position is driven from here by polling the real cursor. Moving a
// window from its own mouse events creates a coordinate feedback loop, this
// avoids it entirely and makes click-vs-drag a simple distance check.
ipcMain.on('launcher:drag-start', () => {
  if (!launcherWindow || dragTimer) return;
  const start = screen.getCursorScreenPoint();
  const [wx, wy] = launcherWindow.getPosition();
  drag = { offX: wx - start.x, offY: wy - start.y, start, moved: 0 };
  dragTimer = setInterval(() => {
    if (!drag || !launcherWindow || launcherWindow.isDestroyed()) return stopDrag(false);
    const c = screen.getCursorScreenPoint();
    drag.moved = Math.max(drag.moved, Math.hypot(c.x - drag.start.x, c.y - drag.start.y));
    if (drag.moved >= DRAG_THRESHOLD) launcherWindow.setPosition(c.x + drag.offX, c.y + drag.offY);
  }, 16);
});

ipcMain.on('launcher:drag-end', () => stopDrag(true));
ipcMain.on('launcher:drag-cancel', () => stopDrag(false));

ipcMain.on('launcher:menu', () => {
  Menu.buildFromTemplate([
    { label: 'Open / hide TFT Helper', click: togglePanel },
    { type: 'separator' },
    { label: 'Reset position', click: resetLauncherPos },
    { label: 'Hide this button', click: () => setLauncherVisible(false) },
    { type: 'separator' },
    { label: 'Quit TFT Helper', click: () => { app.isQuitting = true; app.quit(); } },
  ]).popup({ window: launcherWindow });
});

/* ------------------------------------------------------------------------ */
/* Navigation hardening + keyboard shortcuts                                 */
/* ------------------------------------------------------------------------ */

function openExternal(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
}

function sendCommand(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('command', { type, payload });
  }
}

app.on('session-created', (ses) => adblock.attach(ses));

app.on('web-contents-created', (_e, contents) => {
  // Popups and target=_blank links from any site go to the real browser rather
  // than to a stray Electron window.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // The shell itself (index.html / launcher.html) must never navigate away.
  if (contents.getType() !== 'webview') {
    contents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) return;
      event.preventDefault();
      openExternal(url);
    });
  }

  // Shortcuts live here rather than in a Menu accelerator or globalShortcut: a
  // focused <webview> swallows renderer keydowns, and globalShortcut would
  // steal Ctrl+Tab from every other app on the machine.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (launcherWindow && !launcherWindow.isDestroyed() &&
        contents === launcherWindow.webContents) return;

    const ctrl = input.control || input.meta;
    const key = input.key;
    const run = (fn) => { event.preventDefault(); fn(); };

    if (ctrl && key.toLowerCase() === 'f') return run(() => sendCommand('find'));
    if (key === 'F3') return run(() => sendCommand('find-step', input.shift ? -1 : 1));
    // Forwarded but NOT swallowed: Escape still reaches the site, which may be
    // using it to close its own dialog. The renderer only acts if the find bar
    // is open.
    if (key === 'Escape') sendCommand('find-escape');
    if (ctrl && key === 'Tab') return run(() => sendCommand('cycle', input.shift ? -1 : 1));
    if (ctrl && /^[1-9]$/.test(key)) return run(() => sendCommand('select-index', Number(key) - 1));
    if ((ctrl && key.toLowerCase() === 'r') || key === 'F5') return run(() => sendCommand('reload'));
    if (input.alt && key === 'ArrowLeft') return run(() => sendCommand('back'));
    if (input.alt && key === 'ArrowRight') return run(() => sendCommand('forward'));
    if (key === 'F12' || (ctrl && input.shift && key.toLowerCase() === 'i')) return run(() => sendCommand('devtools'));
    if (ctrl && key.toLowerCase() === 'w') return run(() => mainWindow && mainWindow.hide());
    if (ctrl && key.toLowerCase() === 'q') return run(() => { app.isQuitting = true; app.quit(); });
  });
});

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

// A second launch reveals the running instance instead of starting a copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(() => {
    loadConfig();
    Menu.setApplicationMenu(null);  // no menu bar; shortcuts are handled above
    createMainWindow();
    createLauncherWindow();
    createTray();
    registerGlobalShortcuts();
    watchForeground();
    diagnostics.start();
    adblock.attach(require('electron').session.defaultSession);
    adblock.start(app.getPath('userData'), config.adblock !== false);
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  clearInterval(foregroundTimer);
  // Windows only reaps a tray icon when its owner exits cleanly; without this
  // a ghost icon sits there until you hover over it.
  if (tray && !tray.isDestroyed()) tray.destroy();
  diagnostics.stop('quit');
  flushConfig();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
