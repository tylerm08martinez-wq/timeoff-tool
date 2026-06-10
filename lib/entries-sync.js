'use strict';

// Cross-device sync for the Time-Off log (issue #110, ADR 0005).
//
// Two parts:
//   1. PURE merge/tombstone helpers — unit-tested, no DOM, no network.
//   2. A thin GitHub contents-API adapter (browser only) — GET-merge-PUT with
//      409 retry against a dedicated data branch (coordinates are settings-
//      driven, #116). Not unit-tested (system boundary); kept deliberately small.
//
// Dual-loadable with no build step:
// - Browser: window.EntriesSync
// - Node: require('./lib/entries-sync')  (pure helpers only)

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EntriesSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // ─── PURE: merge + tombstones ─────────────────────────────────────────────

  // Newer wins; missing updatedAt sorts oldest. Deterministic on ties.
  function isNewer(a, b) {
    const ax = a && a.updatedAt ? a.updatedAt : '';
    const bx = b && b.updatedAt ? b.updatedAt : '';
    return ax >= bx; // a wins ties — caller passes incoming as `a` to prefer it
  }

  // Union two entry lists by id; for a shared id the record with the higher
  // updatedAt wins (tombstones included, so deletions propagate). Pure; input
  // arrays are not mutated. Returns a fresh array.
  function merge(listA, listB) {
    const byId = {};
    function absorb(list, preferOnTie) {
      (Array.isArray(list) ? list : []).forEach(function (entry) {
        if (!entry || entry.id == null) return;
        const existing = byId[entry.id];
        if (!existing) { byId[entry.id] = entry; return; }
        // Keep whichever is newer; on a tie keep the preferred side.
        const incomingWins = preferOnTie
          ? isNewer(entry, existing)
          : !isNewer(existing, entry);
        if (incomingWins) byId[entry.id] = entry;
      });
    }
    absorb(listA, false);
    absorb(listB, true); // listB (remote/incoming) preferred on exact ties
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  function isTombstone(entry) {
    return !!(entry && entry.deleted);
  }

  // Live (non-deleted) entries, for display and counting.
  function activeEntries(list) {
    return (Array.isArray(list) ? list : []).filter(function (e) { return !isTombstone(e); });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // Stamp an entry as updated now (create or edit). Returns a new object.
  function touch(entry, now) {
    const out = {};
    for (const k in entry) if (Object.prototype.hasOwnProperty.call(entry, k)) out[k] = entry[k];
    out.updatedAt = now || nowIso();
    return out;
  }

  // Turn an entry into a tombstone: keep id, mark deleted, bump updatedAt.
  function tombstone(entry, now) {
    const out = touch(entry, now);
    out.deleted = true;
    return out;
  }

  // Ensure every entry has an updatedAt. Records lacking one (pre-sync local
  // data) are backfilled from their date so a genuine future edit always wins.
  function backfillUpdatedAt(list) {
    return (Array.isArray(list) ? list : []).map(function (entry) {
      if (entry && entry.updatedAt) return entry;
      const base = entry && entry.date ? entry.date + 'T00:00:00.000Z' : '1970-01-01T00:00:00.000Z';
      return touch(entry, base);
    });
  }

  // Does `local` hold anything the `remote` list doesn't already have at the
  // same updatedAt? Used to skip a redundant PUT (and empty commit) on load
  // when the device has nothing new to contribute. Pure.
  function hasLocalChanges(local, remote) {
    const remoteById = {};
    (Array.isArray(remote) ? remote : []).forEach(function (e) {
      if (e && e.id != null) remoteById[e.id] = e.updatedAt || '';
    });
    return (Array.isArray(local) ? local : []).some(function (e) {
      if (!e || e.id == null) return false;
      const r = remoteById[e.id];
      return r === undefined || (e.updatedAt || '') > r;
    });
  }

  // ─── IMPURE: GitHub contents API adapter (browser only) ───────────────────
  // Reads/writes one JSON file on a dedicated branch. The token is supplied by
  // the caller (from localStorage); never stored here.

  // Repo coordinates are SETTINGS-DRIVEN, never hard-coded (ADR 0005 hosting
  // amendment, issue #116). The public GitHub-Pages build must reveal nothing
  // about where the private data lives, so owner/repo/branch come from the
  // user's settings at runtime; only the in-repo file path has a default.
  const DEFAULT_PATH = 'time-off/entries.json';

  // Resolve + validate user-supplied coordinates into a complete coords object.
  // Throws code 'coords' if any of owner/repo/branch is missing, so a
  // misconfigured device fails loudly instead of writing to the wrong place.
  function repoCoords(input) {
    const c = input || {};
    const owner = String(c.owner == null ? '' : c.owner).trim();
    const repo = String(c.repo == null ? '' : c.repo).trim();
    const branch = String(c.branch == null ? '' : c.branch).trim();
    if (!owner || !repo || !branch) {
      const e = new Error('missing repo coordinates'); e.code = 'coords'; throw e;
    }
    const path = String(c.path == null || c.path === '' ? DEFAULT_PATH : c.path).trim();
    return { owner: owner, repo: repo, branch: branch, path: path };
  }

  function apiUrl(coords) {
    return 'https://api.github.com/repos/' + coords.owner + '/' + coords.repo + '/contents/' + coords.path;
  }

  function b64encode(str) {
    // UTF-8 safe base64 encode.
    return root.btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64) {
    return decodeURIComponent(escape(root.atob((b64 || '').replace(/\n/g, ''))));
  }

  // GET current file → { entries, sha }. sha is null when the file does not
  // exist yet (first write creates it).
  async function fetchRemote(token, coords) {
    const repo = repoCoords(coords);
    const res = await root.fetch(apiUrl(repo) + '?ref=' + repo.branch + '&t=' + Date.now(), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { entries: [], sha: null };
    if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.code = 'auth'; throw e; }
    if (!res.ok) { const e = new Error('http ' + res.status); e.code = 'http'; throw e; }
    const json = await res.json();
    let entries = [];
    try { entries = JSON.parse(b64decode(json.content)) || []; } catch (_) { entries = []; }
    return { entries: Array.isArray(entries) ? entries : [], sha: json.sha };
  }

  // PUT merged content with an expected sha. Returns the new sha. Throws with
  // code 'conflict' on a 409 (stale sha) so the caller can re-fetch and retry.
  // `project` maps each entry to its repo-safe shape (e.g. TimeOff.factsOnly,
  // which strips device-local fields like disposition). Defaults to identity.
  async function putRemote(token, entries, sha, project, coords) {
    const repo = repoCoords(coords);
    const proj = project || function (e) { return e; };
    const payload = (Array.isArray(entries) ? entries : []).map(proj);
    const body = {
      message: 'time-off sync ' + nowIso(),
      content: b64encode(JSON.stringify(payload, null, 2) + '\n'),
      branch: repo.branch,
    };
    if (sha) body.sha = sha;
    const res = await root.fetch(apiUrl(repo), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) { const e = new Error('conflict'); e.code = 'conflict'; throw e; }
    if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.code = 'auth'; throw e; }
    if (!res.ok) { const e = new Error('http ' + res.status); e.code = 'http'; throw e; }
    const json = await res.json();
    return json.content ? json.content.sha : null;
  }

  // GET-merge-PUT with bounded 409 retry. `local` is the device's current
  // entries; returns the merged result + new sha so the caller can update its
  // cache and remembered sha.
  async function pushMerge(token, local, knownSha, maxRetries, project, coords) {
    const repo = repoCoords(coords); // validate once before the retry loop
    let attempts = (maxRetries == null ? 3 : maxRetries) + 1;
    let lastErr;
    while (attempts-- > 0) {
      const remote = await fetchRemote(token, repo);
      const merged = merge(remote.entries, local);
      try {
        // merged keeps full local detail for the caller's cache; only the
        // repo payload is projected (facts only).
        const newSha = await putRemote(token, merged, remote.sha, project, repo);
        return { entries: merged, sha: newSha };
      } catch (e) {
        lastErr = e;
        if (e.code !== 'conflict') throw e;
        // else loop: re-fetch (sha advanced) and retry
      }
    }
    throw lastErr || new Error('conflict');
  }

  return {
    // pure
    merge: merge,
    isTombstone: isTombstone,
    activeEntries: activeEntries,
    touch: touch,
    tombstone: tombstone,
    backfillUpdatedAt: backfillUpdatedAt,
    hasLocalChanges: hasLocalChanges,
    nowIso: nowIso,
    // config + adapter
    repoCoords: repoCoords,
    apiUrl: apiUrl,
    fetchRemote: fetchRemote,
    putRemote: putRemote,
    pushMerge: pushMerge,
  };
});
