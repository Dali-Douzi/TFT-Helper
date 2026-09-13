'use strict';

/**
 * The two things Electron cannot express, done directly against user32.
 *
 * 1. Hiding a window from Alt-Tab.
 *    Electron's `skipTaskbar: true` removes the taskbar button (it calls
 *    ITaskbarList::DeleteTab) but leaves the window in the Alt-Tab list. The
 *    Alt-Tab list is driven by extended window styles, so the fix is
 *    WS_EX_TOOLWINDOW.
 *
 * 2. Making the panel *owned* by another application's window.
 *    An owned window sits directly above its owner in the z-order and travels
 *    with it: activate the owner and the owned window comes forward too;
 *    activate something else and both go behind together. That is exactly the
 *    "stick to the game window" behaviour - and as a bonus, owned windows are
 *    excluded from Alt-Tab.
 *
 * Note what this does NOT do: it never opens a handle to another process, never
 * reads its memory and never injects anything. GWLP_HWNDPARENT is set on *our
 * own* window; the other application's window is only named as the owner. All
 * it needs is that window's handle, which EnumWindows/GetForegroundWindow hand
 * out to anyone.
 *
 * Everything here is best-effort. If a call fails we carry on with ordinary
 * window behaviour rather than taking the app down.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;

// HWNDs are declared as intptr rather than void*, which koffi hands back as
// plain JS numbers - easy to compare and store. Window handles are small
// integers in practice, nowhere near the 2^53 limit.
const GetForegroundWindow = user32.func('intptr GetForegroundWindow()');
const IsWindow = user32.func('bool IsWindow(intptr hWnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr hWnd)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)');
const GetWindowLongPtr = user32.func('intptr GetWindowLongPtrW(intptr hWnd, int nIndex)');
const SetWindowLongPtr = user32.func('intptr SetWindowLongPtrW(intptr hWnd, int nIndex, intptr dwNewLong)');

/** BrowserWindow -> HWND as a number, matching what koffi returns. */
function hwndOf(win) {
  try {
    return Number(win.getNativeWindowHandle().readBigUInt64LE());
  } catch {
    return 0;
  }
}

/** Take a window out of the Alt-Tab list. */
function hideFromAltTab(hwnd) {
  try {
    if (!hwnd) return false;
    const ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
    // WS_EX_APPWINDOW forces a window back into Alt-Tab, so it has to go.
    // Extended styles are 32 bits, so plain JS bitwise ops are correct here.
    const next = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `hwnd` an owned window of `ownerHwnd`. Pass 0 to detach.
 *
 * Caution: Windows destroys a window when its owner is destroyed, so callers
 * must detach as soon as the owner goes away - see the isWindow() polling in
 * main.js.
 */
function setOwner(hwnd, ownerHwnd) {
  try {
    if (!hwnd) return false;
    SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, ownerHwnd || 0);
    return true;
  } catch {
    return false;
  }
}

const foregroundWindow = () => {
  try { return GetForegroundWindow(); } catch { return 0; }
};

const isWindow = (hwnd) => {
  try { return Boolean(hwnd) && IsWindow(hwnd); } catch { return false; }
};

/** Process that owns a window, or 0. Used to follow an app across its windows. */
const windowPid = (hwnd) => {
  try {
    if (!hwnd) return 0;
    const out = [0];
    GetWindowThreadProcessId(hwnd, out);
    return out[0] || 0;
  } catch {
    return 0;
  }
};

const isVisible = (hwnd) => {
  try { return Boolean(hwnd) && IsWindowVisible(hwnd); } catch { return false; }
};

module.exports = { hwndOf, hideFromAltTab, setOwner, foregroundWindow, windowPid, isWindow, isVisible };
