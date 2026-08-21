'use strict';

// Sync orchestration shared by every GitHub-synced tool (ADR-0005 pattern).
//
// Before this module, each synced tool (time-off-log.html #110, ibno-coder.html
// #173) carried its own inline copy of the same lifecycle: token/coords/sha
// bookkeeping in localStorage, a debounced write-through push, a pull-merge on
// load with optional push-back, and a status pill driven by a small state
// machine. The copies had drifted (secure-context handling, dirty tracking) and
// none of it was reachable from a Node test. This module owns the LIFECYCLE;
// what stays in the tool is only its vocabulary (status strings), its DOM
// wiring (one setStatus function), and its data semantics (an adapter built on
// lib/entries-sync.js or lib/ibno-sync.js, plus getLocal/setLocal closures that
// apply device-local projections like TimeOff.factsOnly reattachment).
//
// The token is read from the caller-supplied storage and passed straight to the
// adapter. Keeping it OUT of the written payload is the adapter's job (its
// project step — e.g. TimeOff.factsOnly, IbnoSync's historyPayload); this
// module never adds the token to any data it hands to setLocal or the adapter.
//
// Dual-loadable with no build step:
// - Browser: window.SyncController
// - Node: require('./lib/sync-controller')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Status states the controller can be in. Each maps to a [cssKind, text]
  // tuple (or a function returning one) in `messages`; tools override any of
  // them to keep their existing user-visible strings byte-identical.
  const DEFAULT_MESSAGES = {
    off:       ['off', 'sync off'],                              // token or coords missing
    idle:      ['ok', 'synced ✓'],                          // ready, nothing pending
    dirty:     ['dirty', 'unsynced — tap Sync now'],        // local changes not yet pushed
    syncing:   ['syncing', 'syncing…'],
    ok:        ['ok', 'synced ✓'],                          // after a successful push/pull
    auth:      ['error', 'token invalid — update in Settings'],
    coords:    ['error', 'add repo in Settings'],
    conflict:  ['error', 'sync conflict — tap Sync now'],
    pushError: ['error', 'offline — saved locally'],
    pullError: ['error', 'offline — working locally'],
  };

  function create(opts) {
    const o = opts || {};
    const storage = o.storage;
    const keys = o.keys || {};
    const adapter = o.adapter || {};
    const getLocal = o.getLocal;
    const setLocal = o.setLocal;
    const setStatus = typeof o.setStatus === 'function' ? o.setStatus : function () {};
    const messages = o.messages || {};
    const debounceMs = o.debounceMs == null ? 800 : o.debounceMs;
    if (!storage || !keys.token || !keys.coords || !keys.sha) throw new Error('SyncController.create: storage + keys.{token,coords,sha} required');
    if (typeof adapter.push !== 'function' || typeof adapter.fetch !== 'function' || typeof adapter.mergeLocal !== 'function') throw new Error('SyncController.create: adapter.{fetch,push,mergeLocal} required');
    if (typeof getLocal !== 'function' || typeof setLocal !== 'function') throw new Error('SyncController.create: getLocal + setLocal required');

    let knownSha = storage.get(keys.sha, null);
    let dirty = false;
    let syncing = false;
    let timer = null;

    function status(state, info) {
      let m = messages[state] || DEFAULT_MESSAGES[state] || DEFAULT_MESSAGES.off;
      if (typeof m === 'function') m = m(info);
      setStatus(m[0], m[1]);
    }

    function getToken()  { return storage.get(keys.token, ''); }
    function getCoords() { return storage.get(keys.coords, { owner: '', repo: '', branch: '' }); }
    function hasCoords() { const c = getCoords(); return !!(c && c.owner && c.repo && c.branch); }
    function syncReady() { return !!getToken() && hasCoords(); }

    function refreshStatus() {
      // Unconfigured wins over in-flight: clearing settings mid-sync should
      // read "sync off", not "syncing…" (matches the original time-off order).
      if (!getToken())  { status('offNoToken' in messages ? 'offNoToken' : 'off'); return; }
      if (!hasCoords()) { status('offNoCoords' in messages ? 'offNoCoords' : 'off'); return; }
      if (syncing) { status('syncing'); return; }
      if (dirty) { status('dirty'); return; }
      status('idle');
    }

    function rememberSha(sha) {
      knownSha = sha;
      storage.set(keys.sha, knownSha);
    }

    // Write-through after a local change: debounced GET-merge-PUT. Marks the
    // device dirty immediately (status honesty even while offline); stays a
    // no-op until token + coords are configured, so a tool remains purely
    // local until sync is set up.
    function scheduleSync() {
      dirty = true;
      refreshStatus();
      if (!syncReady()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; syncNow(); }, debounceMs);
    }

    function errorState(e) {
      if (e && e.code === 'auth') return 'auth';
      if (e && e.code === 'coords') return 'coords';
      if (e && e.code === 'conflict') return 'conflict';
      return null;
    }

    // GET-merge-PUT via the adapter. The adapter owns projection (what is
    // repo-safe) and merge semantics; setLocal owns re-attaching device-local
    // detail (it runs while the tool's previous local payload is still
    // readable, so the tool can snapshot from it).
    async function syncNow() {
      // Not configured: either the tool names a dedicated message ('notReady',
      // e.g. ibno's "sync off — add token + repo in Settings") or we fall back
      // to refreshStatus, which distinguishes missing token from missing repo.
      if (!syncReady()) { if ('notReady' in messages) status('notReady'); else refreshStatus(); return; }
      if (syncing) return;
      syncing = true;
      status('syncing');
      try {
        const result = await adapter.push(getToken(), getLocal(), knownSha, getCoords());
        // The remote committed, so its sha is truth even if the local save
        // below fails (e.g. localStorage quota) — in that case dirty stays
        // true and the next push re-merges.
        rememberSha(result.sha);
        setLocal(result.data, 'push');
        dirty = false;
        syncing = false;
        status('ok');
      } catch (e) {
        syncing = false;
        status(errorState(e) || 'pushError', e);
      }
    }

    // Pull + merge on load so a device starts with the cross-device picture.
    // Pull-only by default; when `pullPushBack(local, remoteData)` is supplied
    // and returns true (this device holds something the remote lacks), a push
    // follows so the remote catches up — the caller uses this to avoid an
    // empty commit on every load. Offline never throws into tool init.
    async function pullOnLoad() {
      if (!syncReady()) { refreshStatus(); return; }
      syncing = true;
      status('syncing');
      try {
        const remote = await adapter.fetch(getToken(), getCoords());
        const local = getLocal();
        const wantPushBack = typeof o.pullPushBack === 'function' && o.pullPushBack(local, remote.data);
        setLocal(adapter.mergeLocal(remote.data, local), 'pull');
        // Only after the merged data is saved — the remembered sha must never
        // claim knowledge of data the local cache doesn't hold (a quota
        // failure in setLocal keeps the old sha, so state stays consistent).
        rememberSha(remote.sha);
        syncing = false;                       // before push-back, or syncNow() would no-op
        // Push back when the device holds something the remote lacks, OR when
        // a local change landed mid-pull: its debounced push was dropped by
        // the re-entrancy guard above, and clearing dirty without pushing
        // would mask an unsynced change behind "synced ✓".
        if (wantPushBack || dirty) { await syncNow(); return; }
        status('ok');
      } catch (e) {
        syncing = false;
        status(errorState(e) === 'auth' ? 'auth' : 'pullError', e);
      }
    }

    // Settings are DOM-owned by the tool; it hands the parsed values here.
    // Empty token removes the key (equivalent read: getToken() falls back '').
    function saveSettings(s) {
      const v = s || {};
      const token = String(v.token == null ? '' : v.token).trim();
      if (token) storage.set(keys.token, token); else storage.remove(keys.token);
      storage.set(keys.coords, {
        owner: String(v.owner == null ? '' : v.owner).trim(),
        repo: String(v.repo == null ? '' : v.repo).trim(),
        branch: String(v.branch == null ? '' : v.branch).trim(),
      });
      refreshStatus();
    }

    function clearSettings() {
      storage.remove(keys.token);
      storage.set(keys.coords, { owner: '', repo: '', branch: '' });
      refreshStatus();
    }

    return {
      getToken: getToken,
      getCoords: getCoords,
      syncReady: syncReady,
      refreshStatus: refreshStatus,
      scheduleSync: scheduleSync,
      syncNow: syncNow,
      pullOnLoad: pullOnLoad,
      saveSettings: saveSettings,
      clearSettings: clearSettings,
      // introspection for tests and status logic
      isSyncing: function () { return syncing; },
      isDirty: function () { return dirty; },
      knownSha: function () { return knownSha; },
    };
  }

  return { create: create, DEFAULT_MESSAGES: DEFAULT_MESSAGES };
});
