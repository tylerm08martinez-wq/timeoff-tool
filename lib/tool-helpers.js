'use strict';

// Shared Station 849 dashboard helpers (issue #70).
//
// Dual-loadable with no build step:
// - Browser: window.ToolHelpers
// - Node: require('./lib/tool-helpers')
//
// Storage helper: createStorage(namespace). Keys are JSON encoded. A non-empty
// namespace prefixes keys as "namespace:key"; an empty namespace keeps keys
// unchanged for existing browser tools with established localStorage keys.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.ToolHelpers = api;
    root.normalizeCode = api.normalizeCode;
    root.isOff = api.isOff;
    root.areaClass = api.areaClass;
    root.todayIndex = api.todayIndex;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function storageKey(namespace, key) {
    const k = String(key);
    const ns = namespace == null ? '' : String(namespace);
    return ns ? ns + ':' + k : k;
  }

  function createStorage(namespace, store) {
    const target = store === undefined && root ? root.localStorage : store;
    return {
      get: function (key, fallback) {
        try {
          if (!target) return fallback;
          const raw = target.getItem(storageKey(namespace, key));
          if (raw == null) return fallback;
          return JSON.parse(raw);
        } catch (e) {
          return fallback;
        }
      },
      // Returns true on success, false if the write was dropped (no store, or a
      // throw — most commonly QuotaExceededError when localStorage is full).
      // Existing callers ignore the return, so this is purely additive; callers
      // that must know whether the write landed (e.g. session persistence under
      // quota pressure) can branch on it.
      set: function (key, value) {
        try {
          if (!target) return false;
          target.setItem(storageKey(namespace, key), JSON.stringify(value));
          return true;
        } catch (e) { return false; }
      },
      remove: function (key) {
        try {
          if (!target) return;
          target.removeItem(storageKey(namespace, key));
        } catch (e) {}
      },
    };
  }

  function createScheduleStore(store) {
    const target = store === undefined && root ? root.localStorage : store;
    const key = '849_schedule';
    const verKey = '849_schedule_ver'; // stamp tying a saved week to a schedule version
    return {
      key: key,
      verKey: verKey,
      get: function () {
        try {
          if (!target) return '';
          const raw = target.getItem(key);
          return raw == null ? '' : raw;
        } catch (e) {
          return '';
        }
      },
      set: function (raw) {
        try {
          if (!target) return;
          target.setItem(key, String(raw));
        } catch (e) {}
      },
      getVersion: function () {
        try {
          if (!target) return '';
          const v = target.getItem(verKey);
          return v == null ? '' : v;
        } catch (e) {
          return '';
        }
      },
      setVersion: function (ver) {
        try {
          if (!target) return;
          target.setItem(verKey, String(ver));
        } catch (e) {}
      },
      clear: function () {
        try {
          if (!target) return;
          target.removeItem(key);
          target.removeItem(verKey);
        } catch (e) {}
      },
    };
  }

  // Resolve which raw schedule text a page should render: a manually loaded
  // week in the store wins (an explicit override the user pasted/uploaded);
  // otherwise fall back to the repo-embedded schedule (lib/schedule-data.js) so
  // the dashboard auto-syncs to scheduling/current-schedule.md with no upload.
  // Pure + Node-testable. (schedule auto-sync)
  function effectiveScheduleRaw(saved, embedded) {
    if (saved != null && String(saved).trim()) return String(saved);
    if (embedded != null && String(embedded).trim()) return String(embedded);
    return '';
  }

  // Version-aware resolution (schedule auto-sync). A manually loaded week is
  // honored ONLY while its saved version stamp matches the current embedded
  // schedule's version; once the official schedule changes (or the saved copy
  // is unstamped legacy data), the embedded schedule supersedes it. This is what
  // keeps the dashboard synced: publishing a new schedule auto-overrides a stale
  // saved week with no manual Clear. Pure + Node-testable.
  //   opts: { saved, savedVer, embedded, embeddedVer }
  function resolveScheduleRaw(opts) {
    opts = opts || {};
    const saved = opts.saved;
    const embedded = opts.embedded;
    const hasSaved = saved != null && String(saved).trim();
    const hasEmbedded = embedded != null && String(embedded).trim();
    if (hasSaved && hasEmbedded) {
      const sv = opts.savedVer;
      const ev = opts.embeddedVer;
      // Honor the manual override only if its stamp matches the live schedule.
      if (sv && ev && String(sv) === String(ev)) return String(saved);
      return String(embedded); // stale or unstamped → official schedule wins
    }
    return effectiveScheduleRaw(saved, embedded);
  }

  function cleanTSVField(value) {
    return String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ');
  }

  function buildTSV(headers, rows) {
    const out = [];
    out.push((Array.isArray(headers) ? headers : []).map(cleanTSVField).join('\t'));
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      out.push((Array.isArray(row) ? row : []).map(cleanTSVField).join('\t'));
    });
    return out.join('\n');
  }

  function downloadTSV(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return h + ':' + m + ' ' + ampm;
  }

  function isoDate(d) {
    const date = d == null ? new Date() : new Date(d);
    if (isNaN(date.getTime())) return '';
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + m + '-' + day;
  }

  // ─── SCHEDULE VOCABULARY (single-source) ─────────────────────────────────
  // The PARSER and the coverage primitives moved to lib/schedule-coverage.js
  // (issue #328). What stays here is the cross-tool vocabulary those and the
  // other tools share: the weekday order, the Phoenix clock, and the area
  // CSS-class lookup. Nothing here is schedule-coverage specific.

  const SCHEDULE_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PHOENIX_TIME_ZONE = 'America/Phoenix';

  const AREA_CLASS_BY_CODE = {
    A: 'area-A',
    B: 'area-B',
    C: 'area-C',
    ME: 'area-ME',
    DMG: 'area-DMG',
    'C/DMG': 'area-CDMG',
    FLOAT: 'area-FLOAT',
  };

  function normalizeCode(code) {
    return (code || '').trim().toUpperCase();
  }

  function isOff(code) {
    const c = (code || '').trim();
    return c === '' || c === '—' || c === '-' || c === '–';
  }

  // CSS-class lookup for a raw schedule area cell.
  function areaClass(code) {
    const norm = normalizeCode(code);
    if (isOff(code)) return '';
    return AREA_CLASS_BY_CODE[norm] || 'area-other';
  }

  function todayIndex(date) {
    const d = date === undefined ? new Date() : new Date(date);
    if (isNaN(d.getTime())) return new Date().getDay();

    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: PHOENIX_TIME_ZONE,
      weekday: 'short',
    }).format(d);
    const idx = SCHEDULE_DAYS.indexOf(weekday);
    return idx === -1 ? new Date().getDay() : idx;
  }

  // ─── CLIPBOARD ────────────────────────────
  // Consolidates the three near-identical copyText() implementations that
  // used to live inline in dsw.html, masterlist-builder.html, and
  // ibno-coder.html. Prefers the async Clipboard API, but only when it's
  // actually available AND the page is a secure context (ibno-coder's check —
  // navigator.clipboard exists but silently no-ops or throws on http origins).
  // Falls back to the hidden-textarea + execCommand('copy') trick on any
  // rejection or when the API is unavailable. Browser-only.
  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function copyText(text) {
    if (root && root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText && root.isSecureContext) {
      return root.navigator.clipboard.writeText(text).catch(function () { return fallbackCopyText(text); });
    }
    return fallbackCopyText(text);
  }

  // ─── DATE DISPLAY ─────────────────────────
  // Human date badges. Display only — never feeds a classification. Ports the
  // identical inline formatter duplicated across dashboard.html,
  // qa-checklist.html, schedule.html, and masterlist-builder.html: full
  // weekday name + short month abbreviation + day number, e.g. "Monday Jun 30".
  // opts.year: true appends ", 2026" (masterlist-builder's variant). Any
  // "Today: " prefix stays in the calling tool, not here.
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatDateBadge(date, opts) {
    opts = opts || {};
    const d = date == null ? new Date() : new Date(date);
    if (isNaN(d.getTime())) return '';
    let out = WEEKDAY_NAMES[d.getDay()] + ' ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getDate();
    if (opts.year) out += ', ' + d.getFullYear();
    return out;
  }

  // daysAgoLabel(dateStr, today) — ported verbatim from ibno-coder.html's
  // Repeat History detail (read-only reference; ibno-coder.html itself is not
  // touched here). `today` is an optional Date, defaulting to `new Date()`,
  // so this is deterministic and unit-testable without mocking the clock.
  function daysAgoLabel(dateStr, today) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return dateStr;
    const base = today == null ? new Date() : new Date(today);
    base.setHours(0, 0, 0, 0);
    const days = Math.round((base - d) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  // ─── FILE READING ─────────────────────────
  // readTextFile(file, encoding) wraps FileReader.readAsText in a Promise.
  // Only schedule.html's file input reads text directly (dsw.html and
  // masterlist-builder.html read as ArrayBuffer so SpreadsheetLib can sniff
  // csv/xlsx/xls — genuinely different behavior, left in place). Browser-only.
  function readTextFile(file, encoding) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('could not read file')); };
      reader.readAsText(file, encoding || 'UTF-8');
    });
  }

  // Publish the page's purple <header> height as the CSS var --header-h on
  // :root, so the header can be `position: sticky; top: 0` while tools with
  // their OWN sticky sub-toolbars offset below it (top: var(--header-h)).
  // Re-measures on resize (the header wraps on narrow widths). Browser-only.
  function pinHeader() {
    if (!root || !root.document) return;
    const doc = root.document;
    const header = doc.querySelector('header');
    if (!header) return;
    function measure() {
      doc.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
    }
    measure();
    if (root.addEventListener) root.addEventListener('resize', measure);
    if (root.requestAnimationFrame) root.requestAnimationFrame(measure); // after layout settles
  }

  return {
    createStorage: createStorage,
    pinHeader: pinHeader,
    createScheduleStore: createScheduleStore,
    effectiveScheduleRaw: effectiveScheduleRaw,
    resolveScheduleRaw: resolveScheduleRaw,
    buildTSV: buildTSV,
    downloadTSV: downloadTSV,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    isoDate: isoDate,
    normalizeCode: normalizeCode,
    isOff: isOff,
    areaClass: areaClass,
    todayIndex: todayIndex,
    copyText: copyText,
    formatDateBadge: formatDateBadge,
    daysAgoLabel: daysAgoLabel,
    readTextFile: readTextFile,
    SCHEDULE_DAYS: SCHEDULE_DAYS,
  };
});
