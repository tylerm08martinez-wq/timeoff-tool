'use strict';

// Shared pure time-off / attendance helpers (issue #92).
//
// Dual-loadable with no build step:
// - Browser: window.TimeOff plus legacy globals used by time-off-log.html
// - Node: require('./lib/time-off')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.TimeOff = api;
    root.normalizeType = api.normalizeType;
    root.weekBounds = api.weekBounds;
    root.parseLocalDate = api.parseLocalDate;
    root.isThisWeek = api.isThisWeek;
    root.pillClass = api.pillClass;
    root.summarize = api.summarize;
    root.buildTSV = api.buildTSV;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // Policy-aligned event taxonomy (issue #106). "Call-off" is canonical;
  // "Callout" is a legacy alias kept only for migrating old stored entries.
  const TYPES = ['Scheduled Absence', 'Call-off', 'Late', 'NCNS', 'Left Early', 'Other'];
  const TSV_HEADERS = ['Date', 'Employee', 'Type', 'Status', 'Requested / Reported Time', 'Coverage Impact', 'Notes'];

  // Legacy → policy-aligned event names, so entries logged under the old
  // taxonomy keep displaying after the #106 rename.
  const LEGACY_TYPE_MAP = { Request: 'Scheduled Absence', Callout: 'Call-off' };

  function normalizeType(type) {
    return LEGACY_TYPE_MAP[type] || type;
  }

  // ─── FACTS BOUNDARY (issue #109, ADR 0005) ───────────────────────────────
  // The canonical "facts only" shape that may be synced to the repo. Anything
  // not in this allow-list (e.g. `disposition`) is device-local and is excluded
  // by construction — discipline-level details stay in Workday, never the repo.
  const FACT_FIELDS = ['id', 'date', 'employee', 'type', 'status',
    'notification', 'protectedSick', 'time', 'impact', 'note',
    'updatedAt', 'deleted'];

  function factsOnly(entry) {
    const out = {};
    if (!entry) return out;
    FACT_FIELDS.forEach(function (key) {
      if (entry[key] !== undefined) out[key] = entry[key];
    });
    return out;
  }

  // ─── CLASSIFICATION (issue #107) ──────────────────────────────────────────
  // Only these events feed the habitual-attendance tally. Scheduled Absence,
  // Left Early, and Other are never discipline occurrences.
  const COUNTABLE_EVENTS = ['Late', 'Call-off', 'NCNS'];

  function isProtectedSick(entry) {
    return !!(entry && entry.protectedSick);
  }

  // Policy splits a notified-before-start absence (Call-off) from one with no
  // timely notice (NCNS). Notification status is the discriminator.
  function deriveAbsenceType(notification) {
    return notification === 'Before start' ? 'Call-off' : 'NCNS';
  }

  // True when the picked event disagrees with what the notification implies —
  // e.g. logged "Call-off" but notice came after start (really an NCNS).
  function notificationMismatch(entry) {
    if (!entry) return false;
    const type = normalizeType(entry.type);
    if (type !== 'Call-off' && type !== 'NCNS') return false;
    return deriveAbsenceType(entry.notification) !== type;
  }

  // Whether an event counts toward the discipline tally. Excludes protected
  // sick time and approved scheduled absences; a notified, non-sick Call-off
  // still counts. Derived, never stored.
  function countsTowardTally(entry) {
    if (!entry) return false;
    if (isProtectedSick(entry)) return false;
    const type = normalizeType(entry.type);
    if (type === 'Scheduled Absence') return false; // request, not an occurrence
    return COUNTABLE_EVENTS.indexOf(type) !== -1;
  }

  // isFloorAbsence(entry) — the COVERAGE presence predicate (ADR-0008), distinct
  // from countsTowardTally (the discipline predicate). True when the admin is
  // physically off the floor for the whole day: Call-off, NCNS, Scheduled Absence,
  // or Protected Sick Time. A Late is NOT a Floor Absence (present, just delayed),
  // and neither is Left Early / Other. An approved PTO day opens the same coverage
  // hole as a call-off even though it never counts toward discipline.
  const FLOOR_ABSENCE_EVENTS = ['Call-off', 'NCNS', 'Scheduled Absence'];

  function isFloorAbsence(entry) {
    if (!entry) return false;
    if (isProtectedSick(entry)) return true;
    return FLOOR_ABSENCE_EVENTS.indexOf(normalizeType(entry.type)) !== -1;
  }

  function toolBuildTSV() {
    if (root && root.ToolHelpers && typeof root.ToolHelpers.buildTSV === 'function') {
      return root.ToolHelpers.buildTSV;
    }
    if (typeof require === 'function') {
      return require('./tool-helpers').buildTSV;
    }
    throw new Error('ToolHelpers.buildTSV is required');
  }

  // ─── WEEK MATH (current calendar week, Sunday → Saturday) ─────────────────
  function weekBounds(ref) {
    const d = ref ? new Date(ref) : new Date();
    d.setHours(0, 0, 0, 0);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start: start, end: end };
  }

  // Parse a YYYY-MM-DD string as a LOCAL date (avoids UTC off-by-one).
  function parseLocalDate(str) {
    if (!str) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (!m) { const d = new Date(str); return isNaN(d) ? null : d; }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function isThisWeek(dateStr, ref) {
    const d = parseLocalDate(dateStr);
    if (!d) return false;
    const bounds = weekBounds(ref);
    return d >= bounds.start && d < bounds.end;
  }

  function pillClass(prefix, value) {
    return prefix + '-' + String(value).toLowerCase().replace(/[^a-z]/g, '');
  }

  function summarize(entries, ref) {
    const byType = {};
    TYPES.forEach(function (type) { byType[type] = 0; });

    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      if (!entry || !isThisWeek(entry.date, ref)) return;
      // Normalize through the legacy→canonical seam before tallying, so an entry
      // logged under the old taxonomy (Callout/Request) lands in its current
      // bucket — the same enforcement point countsTowardTally/evaluate use.
      const type = normalizeType(String(entry.type || ''));
      byType[type] = (byType[type] || 0) + 1;
    });

    const total = Object.keys(byType).reduce(function (sum, type) {
      return sum + byType[type];
    }, 0);

    return {
      byType: byType,
      total: total,
    };
  }

  // ─── log.md GENERATED MIRROR (issue #111, ADR 0005) ──────────────────────
  // log.md is demoted to a read-only mirror of entries.json. Pure:
  // entries[] → markdown table string. Tombstones are dropped, rows are sorted
  // date-ascending (stable on equal dates), and legacy event names are
  // normalized so the mirror always speaks the canonical taxonomy.
  const LOG_MD_TITLE = '# Time-Off Log';
  const LOG_MD_NOTE = '<!-- Generated from entries.json — do not edit by hand (issue #111, ADR 0005). -->';

  function mdCell(value) {
    return String(value == null ? '' : value)
      .replace(/[\r\n\t]+/g, ' ')   // no line breaks inside a table cell
      .replace(/\|/g, '\\|')         // escape the column delimiter
      .trim();
  }

  function buildLogMarkdown(list) {
    const active = (Array.isArray(list) ? list : []).filter(function (e) {
      return e && !e.deleted;
    });
    const rows = active
      .map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) {
        const ad = String(a.e.date || ''), bd = String(b.e.date || '');
        if (ad < bd) return -1;
        if (ad > bd) return 1;
        return a.i - b.i; // explicit stable tiebreak on equal dates
      })
      .map(function (x) {
        const e = x.e;
        return '| ' + [
          mdCell(e.date),
          mdCell(e.employee),
          mdCell(normalizeType(e.type)),
          mdCell(e.status),
          mdCell(e.time),
          mdCell(e.impact),
          mdCell(e.note),
        ].join(' | ') + ' |';
      });
    const header = '| ' + TSV_HEADERS.join(' | ') + ' |';
    const sep = '| ' + TSV_HEADERS.map(function () { return '---'; }).join(' | ') + ' |';
    return [LOG_MD_TITLE, '', LOG_MD_NOTE, '', header, sep].concat(rows).join('\n') + '\n';
  }

  // Time-off export accepts entry objects, sorts by date, trims fields, and keeps
  // the historical trailing newline; ToolHelpers.buildTSV only handles headers/rows.
  function buildTSV(list) {
    const rows = (Array.isArray(list) ? list : []).slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .map(function (entry) {
        return [
          entry.date,
          entry.employee,
          entry.type,
          entry.status,
          entry.time || '',
          entry.impact,
          entry.note || '',
        ].map(function (cell) {
          return String(cell == null ? '' : cell).replace(/[\t\r\n]+/g, ' ').trim();
        });
      });
    return toolBuildTSV()(TSV_HEADERS, rows) + '\n';
  }

  return {
    TYPES: TYPES,
    COUNTABLE_EVENTS: COUNTABLE_EVENTS,
    FACT_FIELDS: FACT_FIELDS,
    factsOnly: factsOnly,
    normalizeType: normalizeType,
    isProtectedSick: isProtectedSick,
    deriveAbsenceType: deriveAbsenceType,
    notificationMismatch: notificationMismatch,
    countsTowardTally: countsTowardTally,
    isFloorAbsence: isFloorAbsence,
    weekBounds: weekBounds,
    parseLocalDate: parseLocalDate,
    isThisWeek: isThisWeek,
    pillClass: pillClass,
    summarize: summarize,
    buildTSV: buildTSV,
    buildLogMarkdown: buildLogMarkdown,
  };
});
