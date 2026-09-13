'use strict';

/**
 * Floating launcher button.
 *
 * Deliberately NOT using `-webkit-app-region: drag`: on Windows the OS takes
 * over the whole gesture inside a drag region, so you get a movable button that
 * never reports a clean click, and the usual workaround (a tiny non-draggable
 * hit zone) makes a 56px target painful to use.
 *
 * Instead the whole button is one pointer target. This file only says "pointer
 * went down" and "pointer came up"; the main process follows the real cursor
 * while the pointer is down, moves the window, and decides click-vs-drag from
 * how far the cursor travelled (see launcher:drag-start in src/main.js).
 */

const btn = document.getElementById('btn');
const launcher = window.tftHelper.launcher;

let pointerId = null;

btn.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;           // left button only; right opens the menu
  pointerId = e.pointerId;
  // Capture so we still get pointerup after the cursor leaves this 56px window.
  btn.setPointerCapture(pointerId);
  btn.classList.add('dragging');
  launcher.dragStart();
});

btn.addEventListener('pointerup', (e) => {
  if (e.pointerId !== pointerId) return;
  end(launcher.dragEnd);
});

btn.addEventListener('pointercancel', (e) => {
  if (e.pointerId !== pointerId) return;
  end(launcher.dragCancel);
});

function end(fn) {
  try { btn.releasePointerCapture(pointerId); } catch { /* already released */ }
  pointerId = null;
  btn.classList.remove('dragging');
  fn();
}

btn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  launcher.contextMenu();
});

// Safety net: if the window loses focus mid-gesture we would otherwise leave
// the main process polling the cursor forever.
window.addEventListener('blur', () => {
  if (pointerId !== null) end(launcher.dragCancel);
});

// The button is the whole UI - nothing here should be selectable or draggable.
document.addEventListener('dragstart', (e) => e.preventDefault());
