'use strict';

/**
 * Shared preload for both renderers. This is the only bridge between page code
 * and Node/Electron - everything else in the renderer is plain browser JS.
 *
 * The launcher only uses window.tftHelper.launcher.*; the dock UI uses the rest.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tftHelper', {
  /* --- dock UI ---------------------------------------------------------- */

  /** -> { sites: [{id, name, url, icon}], activeSiteId } */
  getState: () => ipcRenderer.invoke('state:get'),

  /** Persist the whole site list (add / remove / reorder / rename / favicon). */
  saveSites: (sites) => ipcRenderer.invoke('state:save-sites', sites),

  /** Remember which site to show on next launch. */
  setActive: (id) => ipcRenderer.send('state:set-active', id),

  /** Open a URL in the system default browser. */
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),

  /** Keyboard commands and mode changes forwarded from the main process. */
  onCommand: (cb) => ipcRenderer.on('command', (_e, msg) => cb(msg)),

  /* --- window controls (the window is frameless; see #titlebar) ---------- */

  win: {
    /** -> { clickThrough, keys, version, build } */
    state: () => ipcRenderer.invoke('win:state'),
    hide: () => ipcRenderer.send('win:hide'),
  },

  /* --- floating launcher ------------------------------------------------ */

  launcher: {
    dragStart: () => ipcRenderer.send('launcher:drag-start'),
    dragEnd: () => ipcRenderer.send('launcher:drag-end'),
    dragCancel: () => ipcRenderer.send('launcher:drag-cancel'),
    contextMenu: () => ipcRenderer.send('launcher:menu'),
  },

  quit: () => ipcRenderer.send('app:quit'),
});
