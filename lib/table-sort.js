'use strict';

// Shared, dual-loadable table-sort core (issue #308).
//
// Every tool that has an HTML <table> should sort by header through THIS one
// module instead of copy-pasting an inline implementation. It was extracted
// from the IBNO Coder's mature inline sort (ibno-coder.html: sortState /
// data-sort / th.sortable, the cmpText + compareBySort + tri-state toggle) and
// generalized so masterlist-builder, time-off-log, schedule and dsw can all
// import the same behavior.
//
// The module is deliberately split in two:
//
//   * A PURE CORE (cmpText, compareValues, nextSortState, sortIndices) with no
//     DOM references. This is what tests/table-sort.test.js exercises under
//     plain Node — the comparison and state-cycle logic that must be correct.
//
//   * A THIN DOM helper (attachTableSort) that wires clickable <th> headers to
//     re-order the <tr> rows of a tbody using the pure core. It is a no-op when
//     there is no `document` (Node), so requiring the module never touches the
//     DOM.
//
// Display-only: attachTableSort re-orders existing DOM rows. It never mutates a
// tool's data model or any lib/*.js classification. (time-off-log is the
// attendance/discipline tool — sorting there is presentation, not policy.)
//
// Dual-loadable with no build step (browser global + Node require), matching
// lib/csv.js, lib/scan-codes.js and the other lib modules.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.TableSort = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ─── PURE CORE ────────────────────────────────────────────────────────────

  // Numeric-aware, case-insensitive text compare — the same rule IBNO's cmpText
  // uses so '0143' < '0359' and 'Area 2' < 'Area 10' order the human way.
  function cmpText(a, b) {
    return String(a == null ? '' : a)
      .localeCompare(String(b == null ? '' : b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function toNumber(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  // Compare two raw cell values for a sort of direction `dir` (1 asc, -1 desc).
  // A value may declare itself numeric by being a finite number, or by a
  // `type: 'number'` hint from the caller; otherwise it compares as text. This
  // mirrors dsw's numeric-aware localeCompare while allowing true-numeric keys.
  function compareValues(a, b, dir, type) {
    const d = dir === -1 ? -1 : 1;
    let n;
    if (type === 'number') {
      n = toNumber(a) - toNumber(b);
    } else if (type === 'text') {
      n = cmpText(a, b);
    } else if (isFiniteNumber(a) && isFiniteNumber(b)) {
      n = Number(a) - Number(b);
    } else {
      n = cmpText(a, b);
    }
    if (!n || Number.isNaN(n)) return 0; // normalize (avoids -0 when dir === -1)
    return n * d;
  }

  // Tri-state header cycle, matching dsw's cycleSort: click a new key → asc;
  // click the active key → flip asc↔desc; click a third time on a desc column →
  // back to the natural / original order (key: null). Callers that prefer a
  // two-state toggle (like IBNO) can pass { cycle: false } to skip the reset.
  //
  // `firstDir` lets a column open descending on first click (IBNO does this for
  // time / count / date columns where "most" is the useful default).
  function nextSortState(state, key, opts) {
    const s = state || { key: null, dir: 1 };
    const o = opts || {};
    const firstDir = o.firstDir === -1 ? -1 : 1;
    const cycle = o.cycle !== false;
    if (s.key !== key) return { key: key, dir: firstDir };
    if (s.dir === firstDir) return { key: key, dir: firstDir === 1 ? -1 : 1 };
    // The second-click direction is currently showing; a third click either
    // clears (tri-state) or flips back to the first direction (two-state).
    return cycle ? { key: null, dir: 1 } : { key: key, dir: firstDir };
  }

  // Given an array of raw values (one per row) plus the sort state, return the
  // array of ORIGINAL indices in sorted order. A null key returns identity
  // order (stable). Ties keep original order (stable via index tiebreak).
  function sortIndices(values, state, type) {
    const idx = values.map(function (_, i) { return i; });
    if (!state || state.key == null) return idx;
    const dir = state.dir === -1 ? -1 : 1;
    idx.sort(function (i, j) {
      const n = compareValues(values[i], values[j], dir, type);
      return n || (i - j); // stable: preserve original order on ties
    });
    return idx;
  }

  // ─── DOM HELPER ───────────────────────────────────────────────────────────
  //
  // attachTableSort(table, opts) makes the header cells of `table` sort its rows.
  //
  //   opts.getValue(row, key)  required. Returns the raw comparison value for a
  //                            row element under column `key`. Callers usually
  //                            read a cell's textContent or a data-* attribute.
  //   opts.headerSelector      CSS for clickable headers (default 'th[data-sort]').
  //   opts.keyAttr             attribute holding the column key (default 'data-sort').
  //   opts.tbody               the <tbody> to sort (default first tbody in table).
  //   opts.rowSelector         which rows are sortable (default: direct <tr> kids).
  //   opts.isDataRow(row)      optional filter to exclude non-data rows.
  //   opts.attachedRows(row)   optional. Return an array of extra rows (e.g. an
  //                            expandable detail row) that must travel WITH `row`
  //                            so they aren't orphaned when order changes.
  //   opts.typeFor(key)        optional. 'number' | 'text' to force a compare type.
  //   opts.cycle               tri-state clear on third click (default true).
  //   opts.firstDirFor(key)    optional. Return -1 to open a column descending.
  //   opts.initial             optional initial { key, dir } state.
  //   opts.onSort(state)       optional callback after each sort.
  //
  // Returns { getState, setState, refresh } for programmatic control, or null
  // when there is no DOM / no tbody.
  function attachTableSort(table, opts) {
    if (typeof document === 'undefined' || !table) return null;
    const o = opts || {};
    if (typeof o.getValue !== 'function') {
      throw new Error('attachTableSort: opts.getValue(row, key) is required');
    }
    const headerSelector = o.headerSelector || 'th[data-sort]';
    const keyAttr = o.keyAttr || 'data-sort';
    // Resolve the tbody LIVE each time: tools that rebuild a table via
    // innerHTML replace the tbody element, so a pinned reference would go stale.
    // A pinned tbody (opts.tbody) is honored as-is for tables that keep it.
    function resolveTbody() {
      return o.tbody || table.querySelector('tbody');
    }
    if (!resolveTbody()) return null;

    let state = o.initial || { key: null, dir: 1 };

    function currentRows(tbody) {
      let rows;
      if (o.rowSelector) {
        rows = Array.prototype.slice.call(tbody.querySelectorAll(o.rowSelector));
      } else {
        rows = Array.prototype.filter.call(tbody.children, function (el) {
          return el.tagName === 'TR';
        });
      }
      if (typeof o.isDataRow === 'function') rows = rows.filter(o.isDataRow);
      return rows;
    }

    function apply() {
      const tbody = resolveTbody();
      if (!tbody) { paintHeaders(); return; }
      const rows = currentRows(tbody);
      if (!rows.length) { paintHeaders(); return; }
      const values = rows.map(function (r) { return o.getValue(r, state.key); });
      const type = typeof o.typeFor === 'function' && state.key != null ? o.typeFor(state.key) : undefined;
      const order = sortIndices(values, state, type);
      const frag = document.createDocumentFragment();
      order.forEach(function (i) {
        const r = rows[i];
        frag.appendChild(r);
        if (typeof o.attachedRows === 'function') {
          (o.attachedRows(r) || []).forEach(function (extra) { if (extra) frag.appendChild(extra); });
        }
      });
      tbody.appendChild(frag);
      paintHeaders();
      if (typeof o.onSort === 'function') o.onSort(getState());
    }

    function paintHeaders() {
      const heads = table.querySelectorAll(headerSelector);
      Array.prototype.forEach.call(heads, function (th) {
        const key = th.getAttribute(keyAttr);
        const active = state.key != null && key === state.key;
        th.classList.toggle('sort-active', !!active);
        th.classList.toggle('sort-desc', !!active && state.dir === -1);
        th.setAttribute('aria-sort', active ? (state.dir === -1 ? 'descending' : 'ascending') : 'none');
      });
    }

    function onHeaderClick(ev) {
      const th = ev.target.closest ? ev.target.closest(headerSelector) : null;
      if (!th || !table.contains(th)) return;
      const key = th.getAttribute(keyAttr);
      if (key == null) return;
      const firstDir = typeof o.firstDirFor === 'function' ? o.firstDirFor(key) : 1;
      state = nextSortState(state, key, { firstDir: firstDir, cycle: o.cycle !== false });
      apply();
    }

    // One delegated listener on the table so re-rendered headers keep working.
    table.addEventListener('click', onHeaderClick);
    // Keyboard access: Enter / Space on a focused header sorts it.
    table.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const th = ev.target.closest ? ev.target.closest(headerSelector) : null;
      if (!th) return;
      ev.preventDefault();
      onHeaderClick(ev);
    });
    // Mark headers as interactive up front so the .sortable CSS/cursor applies.
    Array.prototype.forEach.call(table.querySelectorAll(headerSelector), function (th) {
      th.classList.add('sortable');
      if (!th.hasAttribute('tabindex')) th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
    });

    paintHeaders();

    function getState() { return { key: state.key, dir: state.dir }; }

    return {
      getState: getState,
      setState: function (next) { state = next || { key: null, dir: 1 }; apply(); },
      refresh: apply,
    };
  }

  return {
    cmpText: cmpText,
    compareValues: compareValues,
    nextSortState: nextSortState,
    sortIndices: sortIndices,
    attachTableSort: attachTableSort,
  };
});
