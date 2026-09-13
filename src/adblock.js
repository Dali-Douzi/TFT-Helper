'use strict';

/**
 * Ad and tracker blocking for the embedded sites.
 *
 * This is Ghostery's engine (the one uBlock-style lists are written for) rather
 * than a hand-rolled blocklist. Hand-rolling gets you domain blocking in about
 * forty lines, which stops the requests but leaves the empty boxes behind and
 * misses everything served from the site's own hostname. Real filter lists also
 * carry cosmetic rules, which is what actually makes a page look clean, and
 * keeping up with them by hand is not a job worth having.
 *
 * The compiled engine is cached under userData, so the lists are fetched once
 * and every later launch loads from disk - including offline. If the first
 * fetch fails, blocking is simply off and the app is otherwise unaffected.
 *
 * Blocking is attached per session, and every site here has its own partition,
 * so `app.on('session-created')` is what covers them all.
 */

const path = require('path');
const { promises: fsp } = require('fs');
const { ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const CACHE_FILE = 'adblock-engine.bin';

let blocker = null;
let enabled = true;
const attached = new Set();     // sessions currently blocking
const known = new Set();        // every session we have seen
let blockedSinceLastDrain = 0;

/** Number of requests blocked since the last call. Read by diagnostics. */
function drainBlocked() {
  const n = blockedSinceLastDrain;
  blockedSinceLastDrain = 0;
  return n;
}

const isReady = () => blocker !== null;

function attach(ses) {
  if (!ses) return;
  known.add(ses);
  if (!blocker || !enabled || attached.has(ses)) return;
  try {
    // enableBlockingInSession registers two GLOBAL ipcMain handlers for its
    // cosmetic filtering, but is called once per session - so the second
    // session throws "second handler", and because that happens before the
    // per-session network filters are registered, blocking silently does
    // nothing for every site after the first. Clearing them first makes the
    // re-registration succeed; the handlers are bound to the one blocker
    // instance, so whichever registration wins behaves identically.
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
    blocker.enableBlockingInSession(ses);
    attached.add(ses);
  } catch (err) {
    console.warn('[TFT Helper] adblock attach failed:', err.message);
  }
}

function detach(ses) {
  if (!blocker || !attached.has(ses)) return;
  try {
    blocker.disableBlockingInSession(ses);
  } catch { /* session may already be gone */ }
  attached.delete(ses);
}

/** Turn blocking on or off across every session we know about. */
function setEnabled(on) {
  enabled = Boolean(on);
  if (!blocker) return enabled;
  if (enabled) for (const ses of known) attach(ses);
  else for (const ses of [...attached]) detach(ses);
  return enabled;
}

const isEnabled = () => enabled;

/**
 * Build the engine and start blocking. Resolves either way - a failure here
 * means no ad blocking, never a broken app.
 */
async function start(userDataDir, startEnabled = true) {
  enabled = Boolean(startEnabled);
  try {
    // fromCached is private; the public builders take the same caching object.
    // With it, the lists are downloaded and compiled once and every later
    // launch deserialises straight off disk, including with no network.
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(userDataDir, CACHE_FILE),
      read: fsp.readFile,
      write: fsp.writeFile,
    });

    // The engine emits these; used only for the diagnostics counter.
    try {
      blocker.on('request-blocked', () => { blockedSinceLastDrain++; });
      blocker.on('request-redirected', () => { blockedSinceLastDrain++; });
    } catch { /* older engines may not emit; the counter just stays at 0 */ }

    if (enabled) for (const ses of known) attach(ses);
    return true;
  } catch (err) {
    console.warn('[TFT Helper] ad blocking unavailable:', err.message);
    blocker = null;
    return false;
  }
}

module.exports = { start, attach, setEnabled, isEnabled, isReady, drainBlocked };
