'use strict';

// House-standard attendance flag engine (issue #108, ADR 0004).
//
// Admins are non-package handlers, so the package-handler thresholds (HMR-057)
// do NOT apply. This engine evaluates Tyler's *consistent house standard*
// against an admin's events and returns which flags fire — as decision support,
// never an automatic writeup. Protected sick time and approved scheduled
// absences are excluded (see lib/time-off countsTowardTally).
//
// Dual-loadable with no build step:
// - Browser: window.AttendanceRules (depends on window.TimeOff)
// - Node: require('./lib/attendance-rules')

(function (root, factory) {
  const TimeOff = (root && root.TimeOff)
    || (typeof require === 'function' ? require('./time-off') : null);
  const api = factory(TimeOff);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AttendanceRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TimeOff) {
  if (!TimeOff) throw new Error('AttendanceRules requires lib/time-off');

  // Tyler's house standard. Thresholds are config, not hard-coded policy —
  // mirrored from HMR-057 only to stay consistent with the building. A flag
  // fires when an admin's count of *counted* events meets the threshold within
  // the rolling window (in days, counting back from the reference date).
  const DEFAULT_THRESHOLDS = {
    'Late':        { count: 3, windowDays: 30 },
    'Call-off':    { count: 3, windowDays: 30 },
    'NCNS':        { count: 1, windowDays: 30 },
    'combination': { count: 4, windowDays: 30 },
  };

  function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  }

  // Whole-day difference between two dates (ref - event), local time.
  function daysBetween(eventDate, refDate) {
    const ms = startOfDay(refDate) - startOfDay(eventDate);
    return Math.floor(ms / 86400000);
  }

  // An event is in the rolling window if it falls within [ref - windowDays + 1, ref].
  // i.e. a 30-day window includes today and the prior 29 days; future-dated
  // events and anything older are excluded.
  function inWindow(eventDate, refDate, windowDays) {
    const diff = daysBetween(eventDate, refDate);
    return diff >= 0 && diff < windowDays;
  }

  // Evaluate ONE admin's events against the house standard.
  // `events` is that admin's entries; returns counts + fired flags.
  function evaluate(events, thresholds, refDate) {
    const t = thresholds || DEFAULT_THRESHOLDS;
    const ref = refDate ? new Date(refDate) : new Date();
    const list = Array.isArray(events) ? events : [];

    const counts = { 'Late': 0, 'Call-off': 0, 'NCNS': 0, 'combination': 0 };

    list.forEach(function (entry) {
      if (!TimeOff.countsTowardTally(entry)) return;
      const date = TimeOff.parseLocalDate(entry.date);
      if (!date) return;
      const type = TimeOff.normalizeType(entry.type);

      // Per-type tally within that type's own window.
      const typeRule = t[type];
      if (typeRule && inWindow(date, ref, typeRule.windowDays)) {
        counts[type] = (counts[type] || 0) + 1;
      }
      // Combination tally within the combination window (any counted event).
      if (t.combination && inWindow(date, ref, t.combination.windowDays)) {
        counts.combination += 1;
      }
    });

    const flags = [];
    const headsups = [];
    ['Late', 'Call-off', 'NCNS', 'combination'].forEach(function (kind) {
      const rule = t[kind];
      if (!rule) return;
      if (counts[kind] >= rule.count) {
        flags.push({
          kind: kind,
          count: counts[kind],
          threshold: rule.count,
          windowDays: rule.windowDays,
          message: flagMessage(kind, counts[kind], rule),
        });
        return; // at/over the limit it is a Flag, never also a heads-up
      }
      // Heads-up (#144): exactly one countable event below the limit, AND at
      // least one of that kind actually present. The `>= 1` guard means a
      // limit-of-1 threshold (NCNS) never yields a heads-up — its first event
      // is already a Flag, so there is no non-zero "one away" state below it.
      // Inherits protected/scheduled exclusion via countsTowardTally above.
      if (counts[kind] >= 1 && counts[kind] === rule.count - 1) {
        headsups.push({
          kind: kind,
          count: counts[kind],
          threshold: rule.count,
          windowDays: rule.windowDays,
          message: headsupMessage(kind, counts[kind], rule),
        });
      }
    });

    return { counts: counts, flags: flags, headsups: headsups };
  }

  function flagMessage(kind, count, rule) {
    if (kind === 'combination') {
      return count + ' counted events in ' + rule.windowDays
        + ' days (limit ' + rule.count + ') — consider a documented conversation.';
    }
    const label = kind === 'NCNS' ? 'NCNS' : kind + 's';
    return count + ' unexcused ' + label + ' in ' + rule.windowDays
      + ' days (limit ' + rule.count + ') — consider a documented conversation.';
  }

  // Facts-only heads-up text (#144) — neutral awareness, NO discipline language.
  function headsupMessage(kind, count, rule) {
    const noun = kind === 'combination' ? 'counted events'
      : (kind === 'NCNS' ? 'NCNS' : (count === 1 ? kind : kind + 's'));
    return count + ' ' + noun + ' in ' + rule.windowDays
      + ' days — 1 away from the limit of ' + rule.count + '.';
  }

  // Group all entries by admin and evaluate each. Returns an array of
  // { admin, counts, flags, headsups } sorted by admin name.
  function evaluateByAdmin(entries, thresholds, refDate) {
    const byAdmin = {};
    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      const admin = (entry && entry.employee) || '';
      (byAdmin[admin] = byAdmin[admin] || []).push(entry);
    });
    return Object.keys(byAdmin).sort().map(function (admin) {
      const result = evaluate(byAdmin[admin], thresholds, refDate);
      return { admin: admin, counts: result.counts, flags: result.flags, headsups: result.headsups };
    });
  }

  // Rolling counts over an arbitrary window for one admin (e.g. 30/90-day
  // summary display), regardless of thresholds.
  function rollingCounts(events, windowDays, refDate) {
    const ref = refDate ? new Date(refDate) : new Date();
    const counts = { 'Late': 0, 'Call-off': 0, 'NCNS': 0, total: 0 };
    (Array.isArray(events) ? events : []).forEach(function (entry) {
      if (!TimeOff.countsTowardTally(entry)) return;
      const date = TimeOff.parseLocalDate(entry.date);
      if (!date || !inWindow(date, ref, windowDays)) return;
      const type = TimeOff.normalizeType(entry.type);
      if (counts[type] !== undefined) counts[type] += 1;
      counts.total += 1;
    });
    return counts;
  }

  return {
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    inWindow: inWindow,
    daysBetween: daysBetween,
    evaluate: evaluate,
    evaluateByAdmin: evaluateByAdmin,
    rollingCounts: rollingCounts,
  };
});
