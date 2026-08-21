'use strict';

// Generic GitHub contents-API JSON transport.
//
// Dual-loadable with no build step:
// - Browser: window.GithubJsonSync
// - Node: require('./lib/github-json-sync')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GithubJsonSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  const DEFAULT_PATH = 'data.json';

  function nowIso() { return new Date().toISOString(); }

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
  function b64encode(str) { return root.btoa(unescape(encodeURIComponent(str))); }
  function b64decode(b64) { return decodeURIComponent(escape(root.atob((b64 || '').replace(/\n/g, '')))); }

  // GET current file -> { data, sha }. sha is null when the file does not yet
  // exist (first write creates it). A missing or invalid payload reads as [].
  async function fetchRemote(token, coords) {
    const repo = repoCoords(coords);
    const res = await root.fetch(apiUrl(repo) + '?ref=' + repo.branch + '&t=' + Date.now(), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { data: [], sha: null };
    if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.code = 'auth'; throw e; }
    if (!res.ok) { const e = new Error('http ' + res.status); e.code = 'http'; throw e; }
    const json = await res.json();
    let data = [];
    try { data = JSON.parse(b64decode(json.content)) || []; } catch (_) { data = []; }
    return { data: data, sha: json.sha };
  }

  // PUT merged content with an expected sha. Returns the new sha. Throws with
  // code 'conflict' on a 409 (stale sha) so the caller can re-fetch and retry.
  async function putRemote(token, data, sha, coords, options) {
    const repo = repoCoords(coords);
    const opts = options || {};
    const project = opts.project || function (value) { return value; };
    const payload = project(data);
    const body = {
      message: (opts.messagePrefix || 'github json sync') + ' ' + nowIso(),
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
  // JSON payload; `merge` combines remote+local, `prune` optionally trims the
  // merged data, and `project` maps the repo-safe payload before PUT.
  async function pushMerge(token, local, options) {
    const opts = options || {};
    const repo = repoCoords(opts.coords); // validate once before the retry loop
    const merge = typeof opts.merge === 'function' ? opts.merge : function (_remote, current) { return current; };
    const pr = typeof opts.prune === 'function' ? opts.prune : function (m) { return m; };
    let attempts = (opts.maxRetries == null ? 3 : opts.maxRetries) + 1;
    let lastErr;
    while (attempts-- > 0) {
      const remote = await fetchRemote(token, repo);
      const merged = pr(merge(remote.data, local));
      try {
        const newSha = await putRemote(token, merged, remote.sha, repo, { project: opts.project, messagePrefix: opts.messagePrefix });
        return { data: merged, sha: newSha };
      } catch (e) {
        lastErr = e;
        if (e.code !== 'conflict') throw e;
        // else loop: re-fetch (sha advanced) and retry
      }
    }
    throw lastErr || new Error('conflict');
  }

  return {
    repoCoords: repoCoords,
    apiUrl: apiUrl,
    b64encode: b64encode,
    b64decode: b64decode,
    fetchRemote: fetchRemote,
    putRemote: putRemote,
    pushMerge: pushMerge,
  };
});
