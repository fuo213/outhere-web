#!/usr/bin/env node
// Unit tests for osm-report.js (note text, duplicate check, createNote, reported-spots store).
//   node design/tools/test-osm-report.mjs
// No network: fetch is mocked. Nothing here talks to OpenStreetMap.
import assert from "node:assert/strict";
const R = await import("../../osm-report.js");
const C = await import("../../config.js");

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("ok  ", name); };
const res = (status, json, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => json });

await test("api base: production by default, sandbox only on dev hosts", () => {
  assert.equal(R.resolveOsmApiBase("outhere-web.pages.dev", "?osmapi=sandbox"), R.PRODUCTION_API);
  assert.equal(R.resolveOsmApiBase("booot.org", "?osmapi=sandbox"), R.PRODUCTION_API);
  assert.equal(R.resolveOsmApiBase("evil-outhere-web.pages.dev", "?osmapi=sandbox"), R.PRODUCTION_API);
  assert.equal(R.resolveOsmApiBase("localhost", ""), R.PRODUCTION_API);
  assert.equal(R.resolveOsmApiBase("localhost", "?osmapi=sandbox"), R.SANDBOX_API);
  assert.equal(R.resolveOsmApiBase("feat-fix-the-map.outhere-web.pages.dev", "?osmapi=sandbox"), R.SANDBOX_API);
  assert.equal(R.resolveOsmApiBase("localhost", "?osmapi=https://evil.example"), R.PRODUCTION_API);
  assert.equal(C.OSM_API_BASE, R.PRODUCTION_API); // node: no location
});

await test("iD url: zoom 19 centred, way selected when known", () => {
  assert.equal(R.osmEditUrl({ lat: 37.2, lon: -112.9 }), "https://www.openstreetmap.org/edit?editor=id#map=19/37.200000/-112.900000");
  assert.equal(R.osmEditUrl({ lat: 37.2, lon: -112.9, wayId: 123 }), "https://www.openstreetmap.org/edit?editor=id#id=w123&map=19/37.200000/-112.900000");
  assert.ok(!R.osmEditUrl({ lat: 1, lon: 2, wayId: "1&x=2" }).includes("x=2"));
});

await test("gap note text names both ways, lengths, signature last", () => {
  const t = R.gapNoteText({ ways: [{ osmId: 1, name: "Hop Valley Trail", highway: "path" }, { osmId: 2, name: "", highway: "path" }], gapM: 4.2, legM: 520 });
  assert.match(t, /1\. "Hop Valley Trail" \(https:\/\/www\.openstreetmap\.org\/way\/1\)/);
  assert.match(t, /2\. unnamed path \(https:\/\/www\.openstreetmap\.org\/way\/2\)/);
  assert.match(t, /about 4 m/);
  assert.match(t, /straight 520 m line/);
  assert.match(t, /planning a hiking route/);
  assert.ok(t.trim().endsWith(R.SIGNATURE));
  assert.match(R.gapNoteText({}), /Two trails near here/);
  assert.ok(R.gapNoteText({ ways: [{ osmId: 5, name: "A", highway: "path" }] }).includes("ends without connecting"));
});

await test("problem note text per kind, with nearest trail", () => {
  const t = R.problemNoteText({ kind: "name", nearby: { osmId: 9, name: "", highway: "path" } });
  assert.match(t, /name of the trail/);
  assert.match(t, /unnamed path \(https:\/\/www\.openstreetmap\.org\/way\/9\)/);
  assert.ok(t.trim().endsWith(R.SIGNATURE));
  assert.ok(R.isUntouched(t, "name", { osmId: 9, name: "", highway: "path" }));
  assert.ok(!R.hasUserContent(R.SIGNATURE));
});

await test("nearby notes: url, parse keeps open + near, nearest first", () => {
  const u = R.nearbyNotesUrl(R.PRODUCTION_API, 37.2, -112.9);
  assert.match(u, /^https:\/\/api\.openstreetmap\.org\/api\/0\.6\/notes\.json\?bbox=-112\.\d+,37\.\d+,-112\.\d+,37\.\d+&closed=0&limit=20$/);
  const mk = (id, lon, lat, status = "open", text = "x") => ({ type: "Feature", geometry: { coordinates: [lon, lat] }, properties: { id, status, date_created: "2026-01-02 03:04:05 UTC", comments: [{ text }] } });
  const out = R.parseNotes({ features: [mk(1, -112.9003, 37.2), mk(2, -112.9001, 37.2, "open", "<img onerror=x>"), mk(3, -112.9, 37.2, "closed"), mk(4, -112.95, 37.2)] }, { lat: 37.2, lon: -112.9 });
  assert.deepEqual(out.map((x) => x.id), [2, 1]);
  assert.equal(out[0].text, "<img onerror=x>"); // raw text; UI uses textContent
  assert.equal(out[0].created, "2026-01-02");
  assert.deepEqual(R.parseNotes(null, { lat: 0, lon: 0 }), []);
});

await test("createNote posts JSON to notes.json and returns the note link", async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return res(200, { type: "Feature", properties: { id: 77 } }); };
  const out = await R.createNote(f, R.SANDBOX_API, { lat: 37.2, lon: -112.9, text: "  hi  " });
  assert.equal(seen.url, "https://master.apis.dev.openstreetmap.org/api/0.6/notes.json");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { lat: 37.2, lon: -112.9, text: "hi" });
  assert.equal(seen.init.headers.Authorization, undefined); // anonymous
  assert.equal(out.url, "https://master.apis.dev.openstreetmap.org/note/77");
  await R.createNote(f, R.PRODUCTION_API, { lat: 1, lon: 2, text: "a" }, { authHeaders: { Authorization: "Bearer t" } });
  assert.equal(seen.init.headers.Authorization, "Bearer t");
  assert.equal((await R.createNote(f, R.PRODUCTION_API, { lat: 1, lon: 2, text: "a" })).url, "https://www.openstreetmap.org/note/77");
});

await test("createNote failure kinds", async () => {
  const kind = async (f) => { try { await R.createNote(f, R.PRODUCTION_API, { lat: 1, lon: 2, text: "a" }); } catch (e) { return e; } };
  assert.equal((await kind(async () => { throw new TypeError("Failed to fetch"); })).kind, "offline");
  const rl = await kind(async () => res(429, {}, { "retry-after": "60" }));
  assert.equal(rl.kind, "rate_limited"); assert.equal(rl.retryAfter, 60);
  assert.equal((await kind(async () => res(403, {}))).kind, "blocked");
  assert.equal((await kind(async () => res(400, {}))).kind, "invalid");
  assert.equal((await kind(async () => res(500, {}))).kind, "api");
  assert.equal((await kind(async () => res(200, { nope: 1 }))).kind, "api");
  await assert.rejects(R.createNote(async () => assert.fail("no request for empty text"), R.PRODUCTION_API, { lat: 1, lon: 2, text: "  " }), { kind: "invalid" });
  for (const k of ["offline", "rate_limited", "blocked", "invalid", "api"]) assert.ok(R.ERROR_COPY[k]);
});

await test("reported spots store: find by distance and api base, survives bad storage", () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const rs = new R.ReportedSpots(st);
  assert.equal(rs.find(37.2, -112.9, R.PRODUCTION_API), null);
  rs.add({ lat: 37.2, lon: -112.9, noteId: 5, api: R.PRODUCTION_API, date: "2026-11-11T10:00:00Z" });
  const hit = rs.find(37.20005, -112.9, R.PRODUCTION_API);
  assert.equal(hit.noteId, 5);
  assert.equal(hit.url, "https://www.openstreetmap.org/note/5");
  assert.equal(rs.find(37.2, -112.9, R.SANDBOX_API), null);       // sandbox/prod are separate
  assert.equal(rs.find(37.21, -112.9, R.PRODUCTION_API), null);   // 1 km away
  mem.set(R.REPORTS_KEY, "not json");
  assert.equal(rs.find(37.2, -112.9, R.PRODUCTION_API), null);
  new R.ReportedSpots(null).add({ lat: 1, lon: 2, noteId: 1, api: "x" }); // no storage: no throw
  assert.match(R.formatReportDate("2026-11-11T10:00:00Z"), /Nov 1[01], 2026/);
});

console.log(`${n} tests passed`);
