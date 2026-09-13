'use strict';

/**
 * TFT Helper - dock UI renderer.
 *
 * One <webview> per site. All of them load at startup (active site first, see
 * preloadRemaining) and stay alive for the lifetime of the app - switching
 * sites, hiding the panel and alt-tabbing away all leave every page exactly as
 * it was. Nothing is ever reloaded behind your
 * back, which matters when you come back to the panel mid-game and cannot
 * afford to wait for a page load.
 *
 * Each webview gets its own persistent partition ("persist:site-<id>"), which
 * keeps cookies/localStorage separate per site and alive across restarts.
 */

const api = window.tftHelper;

const tabsEl = document.getElementById('tabs');
const viewsEl = document.getElementById('views');
const emptyEl = document.getElementById('empty');
const progressEl = document.getElementById('progress');
const addBtn = document.getElementById('add-btn');
const dialog = document.getElementById('site-dialog');
const ctxEl = document.getElementById('ctx');
const findBar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');

/**
 * Present as plain Chrome. Electron's default UA carries "Electron/x" and the
 * app name, and a few sites use that to serve a degraded page or block login.
 */
const USER_AGENT = navigator.userAgent.replace(/\s*(TFT Helper|Electron)\/\S+/g, '');

const LOAD_TIMEOUT = 25000; // ms before a stuck load is treated as a failure

let sites = [];
let activeId = null;
const views = new Map(); // id -> { wrap, webview, fallback, timer, loading }

const persist = () => api.saveSites(sites);

/* ------------------------------------------------------------------------ */
/* Sidebar                                                                   */
/* ------------------------------------------------------------------------ */

/** Stable pastel colour per site, used by the letter placeholder. */
function hueOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function renderSidebar() {
  tabsEl.textContent = '';
  emptyEl.hidden = sites.length > 0;

  sites.forEach((site) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (site.id === activeId ? ' active' : '');
    tab.draggable = true;
    tab.dataset.id = site.id;
    // The rail shows icons only, so the tooltip carries the name.
    tab.title = site.name + '\n' + site.url;

    // Favicon if we have one, otherwise a coloured initial.
    if (site.icon) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = site.icon;
      img.onerror = () => img.replaceWith(letterFor(site));
      tab.append(img);
    } else {
      tab.append(letterFor(site));
    }

    tab.onclick = () => activate(site.id);
    tab.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e, site); };
    wireDragReorder(tab);

    tabsEl.append(tab);
  });
}

function letterFor(site) {
  const el = document.createElement('span');
  el.className = 'letter';
  el.textContent = (site.name[0] || '?').toUpperCase();
  el.style.background = `hsl(${hueOf(site.id)} 60% 65%)`;
  return el;
}

/* ------------------------------------------------------------------------ */
/* Drag to reorder                                                           */
/* ------------------------------------------------------------------------ */

let dragId = null;

function wireDragReorder(tab) {
  tab.addEventListener('dragstart', (e) => {
    dragId = tab.dataset.id;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId); // Firefox-style requirement
  });

  tab.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.remove('dragging', 'drop-before', 'drop-after'));
  });

  tab.addEventListener('dragover', (e) => {
    if (!dragId || dragId === tab.dataset.id) return;
    e.preventDefault();
    const after = e.offsetY > tab.offsetHeight / 2;
    tab.classList.toggle('drop-before', !after);
    tab.classList.toggle('drop-after', after);
  });

  tab.addEventListener('dragleave', () =>
    tab.classList.remove('drop-before', 'drop-after'));

  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === tab.dataset.id) return;
    const after = e.offsetY > tab.offsetHeight / 2;
    const from = sites.findIndex((s) => s.id === dragId);
    const [moved] = sites.splice(from, 1);
    let to = sites.findIndex((s) => s.id === tab.dataset.id);
    sites.splice(after ? to + 1 : to, 0, moved);
    persist();
    renderSidebar();
  });
}

/* ------------------------------------------------------------------------ */
/* Webviews                                                                  */
/* ------------------------------------------------------------------------ */

function ensureView(site) {
  let v = views.get(site.id);
  if (v) return v;

  const wrap = document.createElement('div');
  wrap.className = 'view-wrap';

  const webview = document.createElement('webview');
  webview.setAttribute('src', site.url);
  webview.setAttribute('partition', 'persist:site-' + site.id); // per-site cookies/storage
  webview.setAttribute('useragent', USER_AGENT);
  webview.setAttribute('allowpopups', '');

  const fallback = buildFallback(site);
  wrap.append(webview, fallback);
  viewsEl.append(wrap);

  v = { wrap, webview, fallback, timer: null, loading: false, site };
  views.set(site.id, v);
  wireViewEvents(v);
  return v;
}

function buildFallback(site) {
  const box = document.createElement('div');
  box.className = 'fallback';

  const h = document.createElement('h3');
  h.textContent = site.name + " didn't load";

  const p = document.createElement('p');
  p.textContent = 'The site could not be shown inside TFT Helper. ' +
    'This is usually a network problem, or a site that refuses to run in an ' +
    'embedded browser. You can open it in your normal browser instead.';

  const code = document.createElement('code');

  const row = document.createElement('div');
  row.className = 'row';

  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = 'Open in browser';
  open.onclick = () => api.openExternal(site.url);

  const retry = document.createElement('button');
  retry.className = 'ghost';
  retry.textContent = 'Retry';
  retry.onclick = () => {
    const v = views.get(site.id);
    v.wrap.classList.remove('failed');
    try { v.webview.loadURL(site.url); } catch { v.webview.reload(); }
  };

  row.append(open, retry);
  box.append(h, p, code, row);
  box.dataset.role = 'fallback';
  return box;
}

/**
 * Failure detection.
 *
 * A <webview> is a top-level browsing context, not a frame in our page, so
 * X-Frame-Options and CSP frame-ancestors generally do NOT block it the way
 * they block an <iframe>. What actually goes wrong in practice is: DNS/TLS/
 * network errors, a site that hard-blocks non-standard browsers, a renderer
 * crash, or a load that never finishes. All four are covered below.
 */
function wireViewEvents(v) {
  const { webview, site } = v;

  const fail = (reason) => {
    clearTimeout(v.timer);
    v.loading = false;
    updateProgress();
    v.fallback.querySelector('code').textContent = reason;
    v.wrap.classList.add('failed');
  };

  const ok = () => {
    clearTimeout(v.timer);
    v.wrap.classList.remove('failed');
  };

  webview.addEventListener('did-start-loading', () => {
    v.loading = true;
    updateProgress();
    clearTimeout(v.timer);
    v.timer = setTimeout(() => fail('Timed out after ' + LOAD_TIMEOUT / 1000 + 's'), LOAD_TIMEOUT);
  });

  webview.addEventListener('did-stop-loading', () => {
    v.loading = false;
    updateProgress();
    clearTimeout(v.timer);
  });

  webview.addEventListener('did-finish-load', () => {
    // A site that refuses to render can still "finish" on about:blank.
    if (webview.getURL() === 'about:blank') fail('Site returned a blank page');
    else ok();
  });

  webview.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;      // a failed image/script is not a failed page
    if (e.errorCode === -3) return;  // ERR_ABORTED: a navigation the page itself replaced
    fail(e.errorDescription + ' (' + e.errorCode + ')');
  });

  webview.addEventListener('render-process-gone', (e) =>
    fail('Renderer stopped: ' + (e.reason || 'unknown')));

  webview.addEventListener('page-favicon-updated', (e) => {
    const icon = (e.favicons || [])[0];
    if (!icon || icon === site.icon) return;
    site.icon = icon;
    persist();
    renderSidebar();
  });

  webview.addEventListener('page-title-updated', (e) => {
    if (site.id === activeId) document.title = e.title + ' - TFT Helper';
  });

  // Results for Ctrl+F arrive here, not as a return value from findInPage.
  webview.addEventListener('found-in-page', (e) => {
    if (site.id !== findSiteId || findBar.hidden) return;
    const { activeMatchOrdinal, matches } = e.result;
    findCount.textContent = matches ? activeMatchOrdinal + '/' + matches : 'No results';
    findBar.classList.toggle('no-results', matches === 0);
  });
}

/**
 * Drop a site's <webview> entirely. Removing it from the DOM destroys the
 * guest WebContents, which is what actually releases its sockets, timers and
 * DNS lookups - hiding it does not. Cookies and localStorage live in the
 * persistent partition on disk, so reloading later keeps you logged in.
 */
function unloadView(id) {
  const v = views.get(id);
  if (!v) return;
  clearTimeout(v.timer);
  v.wrap.remove();
  views.delete(id);
}

function updateProgress() {
  const v = views.get(activeId);
  progressEl.hidden = !(v && v.loading);
}

/* ------------------------------------------------------------------------ */
/* Navigation between sites                                                  */
/* ------------------------------------------------------------------------ */

function activate(id) {
  const site = sites.find((s) => s.id === id);
  if (!site) return;

  activeId = id;
  ensureView(site);
  for (const [sid, v] of views) v.wrap.classList.toggle('active', sid === id);

  renderSidebar();
  updateProgress();
  document.title = site.name + ' - TFT Helper';
  api.setActive(id);

  if (!findBar.hidden && findInput.value) runFind(findInput.value, true);
}

function cycle(delta) {
  if (sites.length < 2) return;
  const i = sites.findIndex((s) => s.id === activeId);
  activate(sites[(i + delta + sites.length) % sites.length].id);
}

/* ------------------------------------------------------------------------ */
/* Add / edit / remove                                                       */
/* ------------------------------------------------------------------------ */

let editingId = null;

/** Accepts "metatft.com" as well as a full URL. */
function normalizeUrl(raw) {
  const text = raw.trim();
  const withScheme = /^https?:\/\//i.test(text) ? text : 'https://' + text;
  const url = new URL(withScheme); // throws on nonsense, caught by the caller
  if (!url.hostname.includes('.')) throw new Error('bad host');
  return url.toString();
}

function openDialog(site) {
  editingId = site ? site.id : null;
  document.getElementById('dialog-title').textContent = site ? 'Edit site' : 'Add site';
  document.getElementById('f-name').value = site ? site.name : '';
  document.getElementById('f-url').value = site ? site.url : '';
  document.getElementById('f-error').hidden = true;
  dialog.showModal();
}

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'ok') return;

  const name = document.getElementById('f-name').value.trim();
  let url;
  try {
    url = normalizeUrl(document.getElementById('f-url').value);
  } catch {
    const err = document.getElementById('f-error');
    err.textContent = "That doesn't look like a URL.";
    err.hidden = false;
    setTimeout(() => dialog.showModal()); // cannot re-open synchronously from close
    return;
  }

  if (editingId) {
    const site = sites.find((s) => s.id === editingId);
    const urlChanged = site.url !== url;
    site.name = name;
    site.url = url;
    // Changing the URL means the live webview points at the old address.
    if (urlChanged && views.has(site.id)) {
      views.get(site.id).webview.loadURL(url);
      site.icon = null;
    }
  } else {
    const id = 'site-' + Date.now().toString(36);
    sites.push({ id, name, url, icon: null });
    persist();
    renderSidebar();
    activate(id);
    return;
  }

  persist();
  renderSidebar();
});

function removeSite(id) {
  const site = sites.find((s) => s.id === id);
  if (!site) return;
  // Note: this leaves the site's session partition on disk, so re-adding the
  // same site keeps you logged in.
  if (!confirm('Remove ' + site.name + ' from TFT Helper?')) return;

  sites = sites.filter((s) => s.id !== id);
  unloadView(id);
  persist();

  if (activeId === id) {
    activeId = null;
    if (sites.length) activate(sites[0].id);
    else { renderSidebar(); document.title = 'TFT Helper'; }
  } else {
    renderSidebar();
  }
}

function move(id, delta) {
  const i = sites.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sites.length) return;
  [sites[i], sites[j]] = [sites[j], sites[i]];
  persist();
  renderSidebar();
}

addBtn.onclick = () => openDialog(null);

/* ------------------------------------------------------------------------ */
/* Right-click menu on a sidebar item                                        */
/* ------------------------------------------------------------------------ */

function showContextMenu(event, site) {
  ctxEl.textContent = '';

  const items = [
    ['Reload', () => views.get(site.id) && views.get(site.id).webview.reload()],
    ['Open in default browser', () => api.openExternal(site.url)],
    null,
    ['Move up', () => move(site.id, -1)],
    ['Move down', () => move(site.id, 1)],
    null,
    ['Edit...', () => openDialog(site)],
    ['Remove', () => removeSite(site.id)],
  ];

  for (const item of items) {
    if (!item) { ctxEl.append(document.createElement('hr')); continue; }
    const [label, fn] = item;
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { hideContextMenu(); fn(); };
    ctxEl.append(b);
  }

  ctxEl.hidden = false;
  // Keep the menu inside the window.
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(event.clientX, innerWidth - r.width - 8) + 'px';
  ctxEl.style.top = Math.min(event.clientY, innerHeight - r.height - 8) + 'px';
}

const hideContextMenu = () => { ctxEl.hidden = true; };
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

/* ------------------------------------------------------------------------ */
/* Commands from the main process (keyboard shortcuts)                       */
/* ------------------------------------------------------------------------ */

api.onCommand(({ type, payload }) => {
  const v = views.get(activeId);
  try {
    switch (type) {
      case 'click-through': return setClickThroughUI(payload);
      case 'find': return openFind();
      case 'find-step': return findBar.hidden ? openFind() : runFind(findInput.value, false, payload > 0);
      case 'find-escape': return closeFind();
      case 'cycle': return cycle(payload);
      case 'select-index': return sites[payload] && activate(sites[payload].id);
      case 'reload': return v && v.webview.reload();
      case 'back': return v && v.webview.canGoBack() && v.webview.goBack();
      case 'forward': return v && v.webview.canGoForward() && v.webview.goForward();
      case 'devtools':
        if (!v) return;
        return v.webview.isDevToolsOpened() ? v.webview.closeDevTools() : v.webview.openDevTools();
    }
  } catch (err) {
    // The webview API only exists once the guest is attached; ignore early keys.
    console.warn('[TFT Helper] command failed:', type, err.message);
  }
});

/* ------------------------------------------------------------------------ */
/* Titlebar + overlay mode                                                   */
/* ------------------------------------------------------------------------ */

const hintEl = document.getElementById('tb-hint');
let hotkeys = { overlay: '', clickThrough: '' };

/** Turn a "CommandOrControl+Alt+T" accelerator into "Ctrl+Alt+T". */
const prettyKey = (k) => (k || '').replace('CommandOrControl', 'Ctrl');

function setClickThroughUI(on) {
  document.body.classList.toggle('click-through', on);
  hintEl.textContent = on
    ? `click-through — ${prettyKey(hotkeys.clickThrough)} to grab it back`
    : `${prettyKey(hotkeys.overlay)} to hide · ${prettyKey(hotkeys.clickThrough)} for click-through`;
}

document.getElementById('tb-close').onclick = () => api.win.hide();

/* ------------------------------------------------------------------------ */
/* Find in page (Ctrl+F)                                                     */
/* ------------------------------------------------------------------------ */

let findText = '';       // text of the running search session
let findSiteId = null;   // which site that session belongs to

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind(findInput.value, true);
}

function stopFind() {
  const v = views.get(findSiteId);
  if (v) {
    try { v.webview.stopFindInPage('clearSelection'); } catch { /* guest not attached */ }
  }
  findSiteId = null;
  findText = '';
}

function closeFind() {
  if (findBar.hidden) return;
  stopFind();
  findBar.hidden = true;
  findBar.classList.remove('no-results');
  findCount.textContent = '';
}

/**
 * `fresh` starts a new search; otherwise step to the next/previous match.
 *
 * Note the inverted-looking flag: in Electron 44 findInPage's `findNext: true`
 * means BEGIN a new session and `false` means a follow-up step - the opposite
 * of what the name suggests. Checked against the shipped electron.d.ts.
 */
function runFind(text, fresh, forward = true) {
  const v = views.get(activeId);
  if (!v) return;
  if (!text) {
    stopFind();
    findCount.textContent = '';
    findBar.classList.remove('no-results');
    return;
  }
  if (findSiteId && findSiteId !== activeId) stopFind();

  const newSession = fresh || text !== findText || findSiteId !== activeId;
  const hadFocus = document.activeElement === findInput;
  findText = text;
  findSiteId = activeId;
  try {
    v.webview.findInPage(text, { findNext: newSession, forward });
  } catch { /* guest not attached yet */ }
  // Searching can pull focus into the guest page, which would swallow the next
  // keystroke typed into the box.
  if (hadFocus) findInput.focus();
}

findInput.addEventListener('input', () => runFind(findInput.value, true));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runFind(findInput.value, false, !e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
document.getElementById('find-next').onclick = () => runFind(findInput.value, false, true);
document.getElementById('find-prev').onclick = () => runFind(findInput.value, false, false);
document.getElementById('find-close').onclick = closeFind;

/* ------------------------------------------------------------------------ */
/* Boot                                                                      */
/* ------------------------------------------------------------------------ */

(async function init() {
  const win = await api.win.state();
  hotkeys = win.keys;
  document.getElementById('tb-build').textContent = `v${win.version} · built ${win.build}`;
  setClickThroughUI(win.clickThrough);

  const state = await api.getState();
  sites = state.sites;
  renderSidebar();

  const wanted = sites.some((s) => s.id === state.activeSiteId)
    ? state.activeSiteId
    : sites[0] && sites[0].id;
  if (wanted) activate(wanted);
  preloadRemaining(wanted);
})();

/**
 * Load every other site so switching is instant from the first click.
 *
 * The site you are looking at gets a head start: the rest wait until it has
 * finished loading, or 8 seconds, whichever comes first. On a slow connection
 * four simultaneous page loads would all crawl, including the one on screen.
 */
function preloadRemaining(firstId) {
  const loadRest = () => sites.forEach((s) => ensureView(s));
  const first = views.get(firstId);
  if (!first) return loadRest();

  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    loadRest();
  };
  first.webview.addEventListener('did-stop-loading', go, { once: true });
  setTimeout(go, 8000);
}
