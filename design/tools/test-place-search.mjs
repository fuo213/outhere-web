#!/usr/bin/env node
// Unit tests for place-search.js (pure matching over booot-place-index v1).
//
//   node design/tools/test-place-search.mjs
//   (optional) PLACE_INDEX=<zion.place-index.json> adds a real-data test
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import {
  normalize, normalizeWithMap, decodeIndex, mergeEntries, search, highlightRanges,
  describeEntry, describeText, zoomFor, indexesForRegion, parseDevPlaces, loadPlaceIndex,
} from "../../place-search.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  ", name); };
const atest = async (name, fn) => { await fn(); n++; console.log("ok  ", name); };

const doc = {
  format: "booot-place-index", v: 1, region: "zion", state: "utah", scale: 100000,
  kinds: ["park", "peak", "trail", "stream", "town"],
  areas: ["Zion National Park", "Maze District"],
  entries: [
    ["Zion National Park", 0, -11302000, 3730000, -1],
    ["Angels Landing", 1, -11295000, 3727000, 0, "ele=1765"],
    ["West Rim Trail", 2, -11300000, 3733000, 0, "km=22.9"],
    ["Dry Creek", 3, -11290000, 3720000, 0, "km=3.0"],
    ["Dry Creek", 3, -10990000, 3820000, 1, "km=8.5"],
    ["Dry Creek Trail", 2, -11290000, 3721000, 0],
    ["Springdale", 4, -11299900, 3718900, -1],
    ["The Narrows", 2, -11296000, 3733000, 0, "km=14.0"],
    ["Cañón Café", 1, -11000000, 3800000, 1],
    ["Hidden Canyon", 3, -11294000, 3724000, 0],
    ["Upper Dry Creek Falls", 1, -11291000, 3722000, 0],
    ["Zion Canyon Scenic Drive", 2, -11297000, 3729000, 0],
    ["Zion Lodge", 1, -11296500, 3728500, 0],
  ],
};
const E = decodeIndex(doc, { regionId: "zion", regionName: "Zion National Park" });
const names = (r) => r.map((e) => e.name);

test("normalize is case, diacritic and punctuation insensitive", () => {
  assert.equal(normalize("Cañón  Café!"), "canon cafe");
  assert.equal(normalize("Pa'rus   Trail"), "pa rus trail");
  assert.equal(normalize("  ÅNGELS—Landing "), "angels landing");
  assert.equal(normalize(null), "");
});

test("normalizeWithMap maps back to original indexes", () => {
  const { norm, map } = normalizeWithMap("Pa'rus Trail");
  assert.equal(norm, "pa rus trail");
  assert.equal(map.length, norm.length);
  assert.equal(map[2], 3); // the collapsed apostrophe maps to the next letter
  assert.equal(map[3], 3);
});

test("decode: coordinates, kinds, area, extras", () => {
  const al = E.find((e) => e.name === "Angels Landing");
  assert.equal(al.kind, "peak");
  assert.ok(Math.abs(al.lon + 112.95) < 1e-9 && Math.abs(al.lat - 37.27) < 1e-9);
  assert.equal(al.area, "Zion National Park");
  assert.equal(al.ele_m, 1765);
  assert.equal(E.find((e) => e.name === "Zion National Park").area, "");
  assert.equal(E.find((e) => e.name === "West Rim Trail").km, 22.9);
  assert.equal(al.regionId, "zion");
});

test("decode rejects unknown formats and skips bad rows", () => {
  assert.equal(decodeIndex(null), null);
  assert.equal(decodeIndex({ ...doc, format: "other" }), null);
  assert.equal(decodeIndex({ ...doc, v: 2 }), null);
  const bad = { ...doc, entries: [["Ok", 0, 1, 2, -1], [5, 0, 1, 2, -1], ["Bad kind", 9, 1, 2, -1], "x", ["NaN", 0, "a", 2, -1], ["--", 0, 1, 2, -1]] };
  assert.deepEqual(names(decodeIndex(bad)), ["Ok"]);
  // unknown extra keys and trailing items are ignored
  const fwd = decodeIndex({ ...doc, entries: [["A", 0, 1, 2, -1, "zzz=1;km=2", "future"]], extra_key: 1 });
  assert.equal(fwd[0].km, 2);
});

test("ranking: prefix beats word-start beats substring", () => {
  const r = search(E, "dry");
  assert.deepEqual(names(r).slice(0, 3).sort(), ["Dry Creek", "Dry Creek", "Dry Creek Trail"]);
  assert.ok(names(r).includes("Upper Dry Creek Falls"));
  assert.ok(names(r).indexOf("Upper Dry Creek Falls") > names(r).indexOf("Dry Creek Trail"));
  const sub = search(E, "ngels");
  assert.deepEqual(names(sub), ["Angels Landing"]);
  const ws = search(E, "canyon");
  // word start (Hidden Canyon, Zion Canyon Scenic Drive) both found
  assert.deepEqual(names(ws).sort(), ["Hidden Canyon", "Zion Canyon Scenic Drive"]);
});

test("ranking: exact first, park-like kinds before trails on ties", () => {
  assert.equal(search(E, "zion national park")[0].kind, "park");
  const z = search(E, "zion");
  assert.equal(z[0].name, "Zion National Park"); // prefix, park priority, ahead of Zion Lodge (peak)
  assert.ok(names(z).includes("Zion Lodge"));
});

test("leading 'the' does not block a prefix match", () => {
  assert.equal(search(E, "narrows")[0].name, "The Narrows");
  assert.deepEqual(highlightRanges("The Narrows", "narrows"), [[4, 11]]);
});

test("multi-word and out-of-order queries", () => {
  assert.equal(search(E, "rim west")[0].name, "West Rim Trail");
  assert.equal(search(E, "west rim")[0].name, "West Rim Trail");
  assert.equal(search(E, "creek dry").filter((e) => e.name === "Dry Creek").length, 2);
});

test("case and diacritic insensitive both ways", () => {
  assert.equal(search(E, "CANON")[0].name, "Cañón Café");
  assert.equal(search(E, "cañón cafe")[0].name, "Cañón Café");
});

test("empty, whitespace, punctuation-only and no-match queries", () => {
  assert.deepEqual(search(E, ""), []);
  assert.deepEqual(search(E, "   "), []);
  assert.deepEqual(search(E, "!!"), []);
  assert.deepEqual(search(E, "zzzzqq"), []);
});

test("limit", () => {
  assert.equal(search(E, "a", { limit: 3 }).length, 3);
});

test("highlight ranges against the original string", () => {
  assert.deepEqual(highlightRanges("Dry Creek", "dry"), [[0, 3]]);
  assert.deepEqual(highlightRanges("Upper Dry Creek Falls", "creek dry"), [[6, 9], [10, 15]]);
  assert.deepEqual(highlightRanges("Cañón Café", "canon"), [[0, 5]]);
  assert.deepEqual(highlightRanges("Angels Landing", "ngels"), [[1, 6]]);
  assert.deepEqual(highlightRanges("Angels Landing", ""), []);
});

test("describe: kind, numbers in feet and miles, where", () => {
  const al = E.find((e) => e.name === "Angels Landing");
  assert.deepEqual(describeEntry(al), { kind: "Peak", numbers: ["5,791 ft"], where: "Zion National Park" });
  const wr = E.find((e) => e.name === "West Rim Trail");
  assert.deepEqual(describeEntry(wr).numbers, ["14.2 mi"]);
  const park = E.find((e) => e.kind === "park");
  assert.equal(describeEntry(park, { fallbackPlace: "Utah" }).where, "Utah");
  assert.equal(describeText(al), "Angels Landing, Peak, 5,791 ft, Zion National Park");
});

test("duplicates stay distinguishable by area", () => {
  const dry = search(E, "dry creek").filter((e) => e.name === "Dry Creek");
  assert.equal(dry.length, 2);
  assert.notEqual(dry[0].area, dry[1].area);
});

test("zoomFor: big things wide, points close", () => {
  assert.ok(zoomFor({ kind: "park" }) < zoomFor({ kind: "peak" }));
  assert.ok(zoomFor({ kind: "trail", km: 20 }) < zoomFor({ kind: "trail", km: 1 }));
});

test("mergeEntries drops overlap duplicates, keeps same name elsewhere", () => {
  const a = decodeIndex(doc, { regionId: "a" });
  const b = decodeIndex(doc, { regionId: "b" });
  const m = mergeEntries([a, b, null]);
  assert.equal(m.length, a.length);
  assert.equal(m.filter((e) => e.name === "Dry Creek").length, 2);
});

test("indexesForRegion: area uses its own, state uses all areas of the state", () => {
  const mk = (id, type, state, pi) => ({ id, name: id, type, state, place_index: pi, available: true });
  const pi = (id) => ({ url: `https://x/${id}.json`, version: id });
  const regions = [
    mk("utah-full", "state", "utah", null), mk("zion", "area", "utah", pi("zion")),
    mk("maze", "area", "utah", pi("maze")), mk("arches", "area", "utah", null),
    mk("yosemite", "area", "california", pi("yosemite")),
  ];
  assert.deepEqual(indexesForRegion(regions[1], regions).map((x) => x.regionId), ["zion"]);
  assert.deepEqual(indexesForRegion(regions[0], regions).map((x) => x.regionId), ["zion", "maze"]);
  assert.deepEqual(indexesForRegion(regions[3], regions), []);        // no index: nothing, quietly
  assert.deepEqual(indexesForRegion(null, regions), []);
  assert.deepEqual(indexesForRegion({ id: "x", type: "area" }, []), []);
  const dev = new Map([["arches", { url: "http://localhost/a.json" }]]);
  assert.deepEqual(indexesForRegion(regions[3], regions, dev).map((x) => x.regionId), ["arches"]);
  assert.deepEqual(indexesForRegion({ ...regions[0], state: "utah" }, regions, dev).map((x) => x.regionId), ["zion", "maze", "arches"]);
});

test("parseDevPlaces only on localhost", () => {
  const spec = "?places=zion:dev-places/zion.place-index.json,bad,x:";
  const ok = parseDevPlaces(spec, "http://localhost:8000/", "localhost");
  assert.equal(ok.get("zion").url, "http://localhost:8000/dev-places/zion.place-index.json");
  assert.equal(ok.size, 1);
  assert.equal(parseDevPlaces(spec, "https://outhere-web.pages.dev/", "outhere-web.pages.dev").size, 0);
});

await atest("loadPlaceIndex degrades to null on 404, bad JSON, network error", async () => {
  const entry = { info: { url: "https://x/y.json" }, regionId: "r", regionName: "R" };
  assert.equal(await loadPlaceIndex(entry, async () => ({ ok: false })), null);
  assert.equal(await loadPlaceIndex(entry, async () => ({ ok: true, json: async () => { throw new Error("x"); } })), null);
  assert.equal(await loadPlaceIndex(entry, async () => { throw new Error("offline"); }), null);
  assert.equal(await loadPlaceIndex(entry, async () => ({ ok: true, json: async () => ({ format: "nope" }) })), null);
  const good = await loadPlaceIndex(entry, async () => ({ ok: true, json: async () => doc }));
  assert.equal(good.length, E.length);
  assert.equal(good[0].regionName, "R");
});

if (process.env.PLACE_INDEX && existsSync(process.env.PLACE_INDEX)) {
  test("real index: expected Zion names rank sensibly", () => {
    const real = decodeIndex(JSON.parse(readFileSync(process.env.PLACE_INDEX, "utf8")), { regionId: "zion" });
    assert.ok(real.length > 300);
    assert.equal(search(real, "angels landing")[0].name, "Angels Landing");
    assert.equal(search(real, "zion national")[0].kind, "park");
    assert.equal(search(real, "narrows")[0].name, "The Narrows");
    const t = performance.now();
    for (let i = 0; i < 100; i++) search(real, "creek");
    assert.ok((performance.now() - t) / 100 < 5, "search under 5 ms");
  });
}

console.log(`\n${n} tests passed`);
