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
      set: function (key, value) {
        try {
          if (!target) return;
          target.setItem(storageKey(namespace, key), JSON.stringify(value));
        } catch (e) {}
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
    return {
      key: key,
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
      clear: function () {
        try {
          if (!target) return;
          target.removeItem(key);
        } catch (e) {}
      },
    };
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

  // ─── SCHEDULE PARSING (single-source; issue #78) ─────────────────────────
  // Moved verbatim out of schedule.html so the Schedule Viewer and the
  // dashboard hub parse identically. Interface unchanged: raw text in,
  // { days, areas, shifts, counts } out.

  const SCHEDULE_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PHOENIX_TIME_ZONE = 'America/Phoenix';

  // Canonical sort areas + the cannot-skip High VAL cage (issue #79). Sourced
  // from the dashboard/coverage conventions in DASHBOARD.md / CONTEXT.md.
  const SORT_AREAS = ['A', 'B', 'C', 'ME', 'DMG'];
  const CANNOT_SKIP_AREA = 'A'; // Cage A = High VAL; never leave uncovered.
  const AREA_CLASS_BY_CODE = {
    A: 'area-A',
    B: 'area-B',
    C: 'area-C',
    ME: 'area-ME',
    DMG: 'area-DMG',
    'C/DMG': 'area-CDMG',
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

  function splitScheduleRow(line) {
    if (line.indexOf('|') !== -1) {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(function (c) { return c.trim(); });
    }
    if (line.indexOf('\t') !== -1) {
      return line.split('\t').map(function (c) { return c.trim(); });
    }
    // No delimiter — treat the whole line as a single field (won't pass >=2 check).
    return [line.trim()];
  }

  function parseScheduleInput(raw) {
    const result = { days: SCHEDULE_DAYS.slice(), areas: [], shifts: [], counts: [] };
    if (!raw || typeof raw !== 'string') return result;

    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    let section = null; // 'areas' | 'shifts' | 'counts'

    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      // Section heading? Strip markdown heading markers and emphasis.
      const headingText = trimmed
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/[:_]+$/, '')
        .trim()
        .toLowerCase();

      if (/^area assignments?$/.test(headingText)) { section = 'areas';  continue; }
      if (/^shift times?$/.test(headingText))      { section = 'shifts'; continue; }
      if (/^staffing counts?$/.test(headingText) ||
          /^counts?$/.test(headingText))           { section = 'counts'; continue; }
      // Ignore other headings (e.g. "Schedule Key") without consuming rows under them.
      if (/^#/.test(trimmed) || /^schedule key$/.test(headingText)) { section = null; continue; }

      if (!section) continue;

      const cells = splitScheduleRow(line);
      if (cells.length < 2) continue;

      // Skip markdown separator rows like |---|---|
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === ''; })) continue;

      const label = cells[0].trim();
      if (label === '') continue;

      // Skip header rows.
      const labelLower = label.toLowerCase();
      if (labelLower === 'employee' || labelLower === 'count' || labelLower === 'code' || labelLower === 'name') {
        continue;
      }

      // Take the next 7 fields as day cells; pad short rows with ''.
      const dayCells = [];
      for (let i = 0; i < 7; i++) {
        dayCells.push((cells[i + 1] !== undefined ? cells[i + 1] : '').trim());
      }

      if (section === 'counts') {
        result.counts.push({ label: label, cells: dayCells });
      } else if (section === 'shifts') {
        result.shifts.push({ employee: label, cells: dayCells });
      } else {
        result.areas.push({ employee: label, cells: dayCells });
      }
    }

    return result;
  }

  // ─── TODAY SELECTOR + COVERAGE (pure; issue #79) ─────────────────────────

  // An off cell: blank or a dash (em/en/hyphen). Anything else = working.
  function isOffCell(cell) {
    const c = String(cell == null ? '' : cell).trim();
    return c === '' || /^[—–-]+$/.test(c);
  }

  // Split a combo assignment ("C/DMG") into its constituent area codes,
  // uppercased and trimmed. A plain cell yields a single-element list.
  function splitAreaCell(cell) {
    return String(cell == null ? '' : cell)
      .split('/')
      .map(function (p) { return p.trim().toUpperCase(); })
      .filter(function (p) { return p !== ''; });
  }

  // selectDay(parsed, weekdayIndex) — 0=Sun..6=Sat. Pure: caller passes the
  // weekday (no internal clock) so tests are deterministic. Returns today's
  // view: people working with their area + shift, today's counts keyed by
  // label, and the set of constituent area codes assigned today.
  function selectDay(parsed, weekdayIndex) {
    const empty = { weekday: null, weekdayIndex: weekdayIndex, people: [], counts: {}, assignedAreas: [] };
    if (!parsed || typeof parsed !== 'object') return empty;
    const idx = Number(weekdayIndex);
    if (!(idx >= 0 && idx <= 6)) return empty;

    const days = Array.isArray(parsed.days) ? parsed.days : SCHEDULE_DAYS;
    const weekday = days[idx] != null ? days[idx] : SCHEDULE_DAYS[idx];

    // Build a shift lookup by employee for today.
    const shiftByEmployee = {};
    (Array.isArray(parsed.shifts) ? parsed.shifts : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      shiftByEmployee[row.employee] = isOffCell(cell) ? '' : String(cell).trim();
    });

    const people = [];
    const assigned = {};
    (Array.isArray(parsed.areas) ? parsed.areas : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      if (isOffCell(cell)) return; // off today — excluded from people-working
      const area = String(cell).trim();
      people.push({
        name: row.employee,
        area: area, // combo preserved intact for display
        shift: shiftByEmployee[row.employee] || '',
      });
      splitAreaCell(area).forEach(function (code) { assigned[code] = true; });
    });

    const counts = {};
    (Array.isArray(parsed.counts) ? parsed.counts : []).forEach(function (row) {
      const cell = row && Array.isArray(row.cells) ? row.cells[idx] : '';
      counts[row.label] = String(cell == null ? '' : cell).trim();
    });

    return {
      weekday: weekday,
      weekdayIndex: idx,
      people: people,
      counts: counts,
      assignedAreas: Object.keys(assigned),
    };
  }

  // deriveCoverage(assignedAreas, sortAreas) — given the constituent area
  // codes covered today and the canonical sort-area set, return which areas
  // are covered/uncovered and flag the High VAL cage (cage A) as cannot-skip
  // when it is uncovered. Pure.
  function deriveCoverage(assignedAreas, sortAreas) {
    const areas = Array.isArray(sortAreas) && sortAreas.length ? sortAreas : SORT_AREAS;
    const have = {};
    (Array.isArray(assignedAreas) ? assignedAreas : []).forEach(function (a) {
      have[String(a).trim().toUpperCase()] = true;
    });
    const covered = [];
    const uncovered = [];
    areas.forEach(function (a) {
      if (have[String(a).toUpperCase()]) covered.push(a);
      else uncovered.push(a);
    });
    const cannotSkip = uncovered.filter(function (a) {
      return String(a).toUpperCase() === CANNOT_SKIP_AREA;
    });
    return { covered: covered, uncovered: uncovered, cannotSkip: cannotSkip };
  }

  return {
    createStorage: createStorage,
    createScheduleStore: createScheduleStore,
    buildTSV: buildTSV,
    downloadTSV: downloadTSV,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    isoDate: isoDate,
    parseScheduleInput: parseScheduleInput,
    selectDay: selectDay,
    deriveCoverage: deriveCoverage,
    normalizeCode: normalizeCode,
    isOff: isOff,
    areaClass: areaClass,
    todayIndex: todayIndex,
    SCHEDULE_DAYS: SCHEDULE_DAYS,
    SORT_AREAS: SORT_AREAS,
    CANNOT_SKIP_AREA: CANNOT_SKIP_AREA,
  };
});
