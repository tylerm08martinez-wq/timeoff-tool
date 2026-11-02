'use strict';

// People list (#1117): the one list of admins and staff every tool reads.
//
// Device-local. The list lives in this browser's localStorage under ONE key,
// `people:list`. Every hosted tool is served from the same origin, so the
// Time-Off Log, Address Catcher and the People page all read the same list.
// Nothing here syncs, uploads or writes to the repo, and no network path may be
// added. This file carries no names: the code rosters (lib/admins.js,
// lib/employee-roster.js) stay the local-checkout fallback and never ship.
//
// Stored value: { version: 1, people: [Person] }
//   Person: { id, name, employeeId, role, mine, manager }
//     name        what the tools show (Time-Off uses it as the Admin value)
//     employeeId  digits, or '' when unknown (Address Catcher looks people up
//                 by it on the correction-history "Made by" line)
//     role        'admin' (QA admins: the Time-Off Admin field) or 'staff'
//     mine        true when the person is on Tyler's own team
//     manager     the person's manager when not on his team, else ''
//
// UNREADABLE IS NOT EMPTY (docs/agents/known-traps.md). A value that fails to
// parse, carries another version, or holds an invalid person reads as
// "unreadable": no people, every write refused, and the bytes are left for a
// person to look at. A storage that throws on read is unreadable too.
//
// CONSUMERS fall back to their code roster PER FIELD: the Time-Off Log when no
// person on the list is an admin, Address Catcher when no person has an
// employee ID, and both when the list is unreadable. One person of the other
// kind never switches a fallback off, so a fresh checkout behaves
// exactly as it did before this list existed.
//
// Dual-loadable with no build step:
// - Browser: window.People
// - Node:    require('./lib/people')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.People = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'people:list';
  const SCHEMA_VERSION = 1;
  const EXPORT_FORMAT = 'station-people';
  const EXPORT_VERSION = 1;
  const ROLES = ['admin', 'staff'];
  const MAX_NAME = 80;

  // Zero-width characters end a word: "Sam<ZWSP>Example" is two words, the same
  // person as "Sam Example". The other format characters (soft hyphen, Arabic
  // letter mark, direction marks, invisible operators) sit inside a word and
  // are removed. All written as \u escapes: literal invisible characters in a
  // source file cannot be seen, and made mutation anchors match nothing.
  const WORD_BREAK_CHARS = /[\u180e\u200b-\u200d\u2060\ufeff]/g;
  const FORMAT_CHARS = /[\u00ad\u061c\u200e\u200f\u202a-\u202e\u2061-\u2064\u2066-\u206f]/g;

  function cleanText(s) {
    let t = String(s == null ? '' : s);
    if (typeof t.normalize === 'function') t = t.normalize('NFKC');
    return t.replace(WORD_BREAK_CHARS, ' ').replace(FORMAT_CHARS, '').replace(/\s+/g, ' ').trim();
  }
  function nameKey(s) { return cleanText(s).toLowerCase(); }

  // validatePerson(input) -> { ok: true, person } | { ok: false, error }
  // The person carries every field (no id; the store adds it).
  function validatePerson(input) {
    const p = input || {};
    const name = cleanText(p.name);
    if (!name) return { ok: false, error: 'name-required' };
    if (name.length > MAX_NAME) return { ok: false, error: 'name-too-long' };
    const role = p.role == null || p.role === '' ? 'staff' : String(p.role);
    if (ROLES.indexOf(role) === -1) return { ok: false, error: 'bad-role' };
    const employeeId = cleanText(p.employeeId);
    if (employeeId && !/^[0-9]{1,12}$/.test(employeeId)) return { ok: false, error: 'bad-employee-id' };
    const manager = cleanText(p.manager);
    if (manager.length > MAX_NAME) return { ok: false, error: 'manager-too-long' };
    return { ok: true, person: { name: name, employeeId: employeeId, role: role, mine: p.mine === true, manager: manager } };
  }

  // A stored person must already be in its cleaned shape, with an id.
  function validStored(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return false;
    const v = validatePerson(p);
    if (!v.ok) return false;
    const c = v.person;
    return c.name === p.name && c.employeeId === (p.employeeId || '') && c.role === p.role &&
      c.mine === (p.mine === true) && c.manager === (p.manager || '');
  }

  // Duplicate rule for a whole list: one id, one name (folded), one employee ID.
  function findClash(people) {
    const ids = Object.create(null), names = Object.create(null), emps = Object.create(null);
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (ids[p.id]) return 'duplicate-id';
      ids[p.id] = true;
      const k = nameKey(p.name);
      if (names[k]) return 'duplicate-name';
      names[k] = true;
      if (p.employeeId) {
        if (emps[p.employeeId]) return 'duplicate-employee-id';
        emps[p.employeeId] = true;
      }
    }
    return null;
  }

  function byName(a, b) {
    const x = nameKey(a.name), y = nameKey(b.name);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function copyPerson(p) {
    return { id: p.id, name: p.name, employeeId: p.employeeId || '', role: p.role, mine: p.mine === true, manager: p.manager || '' };
  }

  // readState(storage) -> { state: 'empty'|'ok'|'unreadable', people }
  function readState(storage) {
    let raw = null;
    try { raw = storage ? storage.getItem(KEY) : null; } catch (e) { return { state: 'unreadable', people: [] }; }
    if (raw == null) return { state: 'empty', people: [] };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.people) ||
        !parsed.people.every(validStored) || findClash(parsed.people)) {
      return { state: 'unreadable', people: [] };
    }
    return { state: 'ok', people: parsed.people.map(copyPerson) };
  }

  function defaultNewId() {
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // exportFile(people) -> the backup file text for a list of stored people.
  function exportFile(people) {
    return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, people: people.map(copyPerson) }, null, 2) + '\n';
  }

  // checkFile(text) -> { ok, people } | { ok: false, error }. Strict: anything
  // it cannot fully check is refused, so a file never puts in what the page
  // could not.
  function checkFile(text) {
    let parsed = null;
    try { parsed = JSON.parse(String(text == null ? '' : text)); } catch (e) { return { ok: false, error: 'not-json' }; }
    if (!parsed || typeof parsed !== 'object' || parsed.format !== EXPORT_FORMAT) return { ok: false, error: 'not-a-people-file' };
    if (parsed.version !== EXPORT_VERSION) return { ok: false, error: 'unknown-version' };
    if (!Array.isArray(parsed.people)) return { ok: false, error: 'not-a-people-file' };
    if (!parsed.people.every(validStored)) return { ok: false, error: 'invalid-person' };
    const clash = findClash(parsed.people);
    if (clash) return { ok: false, error: clash };
    return { ok: true, people: parsed.people.map(copyPerson) };
  }

  function createStore(storage, opts) {
    const o = opts || {};
    const newId = typeof o.newId === 'function' ? o.newId : defaultNewId;

    function write(people) {
      try {
        storage.setItem(KEY, JSON.stringify({ version: SCHEMA_VERSION, people: people }));
        return true;
      } catch (e) { return false; }
    }

    // mutate(fn): fn(currentPeople) -> { people, result } | { error }.
    // Re-reads first, so a list another tab made unreadable is never written over.
    function mutate(fn) {
      const cur = readState(storage);
      if (cur.state === 'unreadable') return { ok: false, error: 'unreadable' };
      const out = fn(cur.people, cur.state);
      if (out.error) return { ok: false, error: out.error };
      const clash = findClash(out.people);
      if (clash) return { ok: false, error: clash };
      if (!write(out.people)) return { ok: false, error: 'storage' };
      return Object.assign({ ok: true }, out.result || {});
    }

    function status() { return readState(storage).state; }
    function list() { return readState(storage).people.sort(byName); }
    function admins() {
      return list().filter(function (p) { return p.role === 'admin'; }).map(function (p) { return p.name; });
    }

    function add(input) {
      const v = validatePerson(input);
      if (!v.ok) {
        // An unreadable list says so first: the person needs that, not a field error.
        return status() === 'unreadable' ? { ok: false, error: 'unreadable' } : v;
      }
      const person = Object.assign({ id: newId() }, v.person);
      return mutate(function (people) { return { people: people.concat([person]), result: { person: copyPerson(person) } }; });
    }

    function update(id, input) {
      return mutate(function (people) {
        const idx = people.findIndex(function (p) { return p.id === id; });
        if (idx === -1) return { error: 'not-found' };
        const v = validatePerson(input);
        if (!v.ok) return { error: v.error };
        const next = Object.assign({ id: id }, v.person);
        const copy = people.slice();
        copy[idx] = next;
        return { people: copy, result: { person: copyPerson(next) } };
      });
    }

    function remove(id) {
      return mutate(function (people) {
        const next = people.filter(function (p) { return p.id !== id; });
        if (next.length === people.length) return { error: 'not-found' };
        return { people: next };
      });
    }

    // seed(candidates): fill a list that holds nobody. Never touches a list
    // with people in it. Invalid and duplicate candidates are skipped.
    function seed(candidates) {
      return mutate(function (people) {
        if (people.length) return { error: 'not-empty' };
        const out = [];
        let skipped = 0;
        (candidates || []).forEach(function (c) {
          const v = validatePerson(c);
          if (!v.ok) { skipped++; return; }
          const trial = out.concat([Object.assign({ id: newId() }, v.person)]);
          if (findClash(trial)) { skipped++; return; }
          out.push(trial[trial.length - 1]);
        });
        return { people: out, result: { added: out.length, skipped: skipped } };
      });
    }

    // exportText() -> backup file text, or null when the list is unreadable.
    // The importer's own checks run on the file before it is handed over.
    function exportText() {
      const cur = readState(storage);
      if (cur.state === 'unreadable') return null;
      const text = exportFile(cur.people.sort(byName));
      return checkFile(text).ok ? text : null;
    }

    function inspectImport(text) { return checkFile(text); }

    // rawText() -> the stored text exactly as saved, or null when there is none
    // or storage will not read. Lets a person keep a copy of an unreadable list.
    function rawText() {
      try { return storage ? storage.getItem(KEY) : null; } catch (e) { return null; }
    }

    // recoverText(text): ONLY for an unreadable list. Replaces it with a backup
    // file's list, or writes nothing. Re-reads first, so a list that has become
    // readable in another tab is never written over.
    function recoverText(text) {
      if (readState(storage).state !== 'unreadable') return { ok: false, error: 'not-unreadable' };
      const chk = checkFile(text);
      if (!chk.ok) return { ok: false, error: chk.error };
      if (!write(chk.people)) return { ok: false, error: 'storage' };
      return { ok: true, count: chk.people.length };
    }

    // importText(text): REPLACES this device's list (no merge), or writes nothing.
    function importText(text) {
      return mutate(function () {
        const chk = checkFile(text);
        if (!chk.ok) return { error: chk.error };
        return { people: chk.people, result: { count: chk.people.length } };
      });
    }

    return {
      status: status, list: list, admins: admins,
      add: add, update: update, remove: remove, seed: seed,
      exportText: exportText, inspectImport: inspectImport, importText: importText,
      rawText: rawText, recoverText: recoverText,
    };
  }

  // seedCandidates(adminNames, rosterEntries) -> people to offer for a
  // one-click import on a local checkout. Admins become admin people; roster
  // entries become staff with their employee ID. Nobody is merged across the
  // two lists: a first name and a roster name are never guessed to be the same
  // person.
  function seedCandidates(adminNames, rosterEntries) {
    const out = [];
    (Array.isArray(adminNames) ? adminNames : []).forEach(function (n) {
      out.push({ name: cleanText(n), employeeId: '', role: 'admin', mine: false, manager: '' });
    });
    (Array.isArray(rosterEntries) ? rosterEntries : []).forEach(function (r) {
      if (!r) return;
      out.push({ name: cleanText(r.name), employeeId: cleanText(r.id), role: 'staff', mine: r.mine === true, manager: cleanText(r.manager) });
    });
    return out;
  }

  // adminNames(storage, fallback) -> { names, source, unreadable }
  // The Time-Off Admin field's list. The People list when it holds at least one
  // ADMIN; otherwise the code fallback exactly as given (null when none is
  // loaded). The fallback is per field: a list of staff only has no admins, so
  // it must not switch the admin fallback off.
  function adminNames(storage, fallback) {
    const cur = readState(storage);
    if (cur.state === 'ok' && cur.people.some(function (p) { return p.role === 'admin'; })) {
      return { names: createStore(storage).admins(), source: 'people', unreadable: false };
    }
    return { names: Array.isArray(fallback) ? fallback : null, source: 'fallback', unreadable: cur.state === 'unreadable' };
  }

  // lookupEmployee(storage, employeeId) -> { useFallback: true } when no person
  // on the list has an employee ID, or the list is unreadable, else { useFallback: false, person } where
  // person is { name, mine, manager } (manager null when blank, the shape
  // lib/employee-roster.js resolve() returns) or null for an ID not on it.
  function lookupEmployee(storage, employeeId) {
    const cur = readState(storage);
    if (cur.state !== 'ok' || !cur.people.some(function (p) { return p.employeeId; })) return { useFallback: true };
    const id = cleanText(employeeId);
    const hit = id ? cur.people.filter(function (p) { return p.employeeId === id; })[0] : null;
    return { useFallback: false, person: hit ? { name: hit.name, mine: hit.mine, manager: hit.manager || null } : null };
  }

  return {
    KEY: KEY, SCHEMA_VERSION: SCHEMA_VERSION, EXPORT_FORMAT: EXPORT_FORMAT, EXPORT_VERSION: EXPORT_VERSION, ROLES: ROLES,
    cleanText: cleanText, validatePerson: validatePerson, createStore: createStore,
    seedCandidates: seedCandidates, adminNames: adminNames, lookupEmployee: lookupEmployee, exportFile: exportFile,
  };
});
