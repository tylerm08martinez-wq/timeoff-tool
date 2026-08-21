'use strict';

// Shared light/dark theme switch for every Station 849 dashboard tab.
//
// - Persists the choice in localStorage ('dashboard_theme': 'dark' | 'light').
// - Applies it by setting data-theme on <html>; theme.css does the rest.
// - Mounts a floating toggle button (bottom-right) so every tab gets it without
//   touching each header's markup.
//
// To avoid a flash of light before this script runs, each tab also sets the
// attribute inline in <head> (see the small bootstrap snippet there). This file
// is the source of truth for the toggle + key.

(function (root) {
  if (!root || !root.document) return;
  var doc = root.document;
  var KEY = 'dashboard_theme';

  function saved() {
    try { return root.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(theme) {
    if (theme === 'dark') doc.documentElement.setAttribute('data-theme', 'dark');
    else doc.documentElement.removeAttribute('data-theme');
  }
  function current() {
    return doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function set(theme) {
    apply(theme);
    try { root.localStorage.setItem(KEY, theme); } catch (e) { /* private mode */ }
    updateButton();
  }
  function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }

  var btn = null;
  function updateButton() {
    if (!btn) return;
    var dark = current() === 'dark';
    btn.textContent = dark ? '☀' : '☾';        // ☀ in dark, ☾ in light
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }
  function mountToggle() {
    if (doc.querySelector('.theme-toggle')) return;
    btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', toggle);
    doc.body.appendChild(btn);
    updateButton();
  }

  // Apply persisted theme immediately (the inline head snippet usually already
  // did this; harmless to repeat), then mount the toggle when the DOM is ready.
  apply(saved() === 'dark' ? 'dark' : 'light');
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', mountToggle);
  } else {
    mountToggle();
  }

  root.Theme = { toggle: toggle, set: set, current: current };
})(typeof globalThis !== 'undefined' ? globalThis : this);
