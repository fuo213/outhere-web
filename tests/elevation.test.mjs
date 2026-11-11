// elevation.js: sample density, chunked all-or-nothing fetching, and that a
// dense profile still draws quickly.
import { test, assert, near, pt, makeLine, makeTrip, point } from "./helpers.mjs";
import * as E from "../elevation.js";
import * as M from "../line-model.js";
import { appendReturn } from "../line-edit.js";
import { buildItinerary, drawProfile } from "../itinerary-profile.js";

test("sample density: ~100 m, never coarser than the old 100 points, 25 m floor, 800 cap", () => {
  assert.equal(E.profileSampleCount(2000), 81, "short route: 25 m spacing, as before");
  assert.equal(E.profileSampleCount(5000), 100, "the old 100 points, not fewer");
  assert.equal(E.profileSampleCount(23560), 237, "West Rim, 14.6 mi: one per 100 m");
  assert.equal(E.profileSampleCount(48000), 481);
  assert.equal(E.profileSampleCount(200000), 800, "capped");
});

test("buildProfile samples the line evenly by distance and returns feet", async () => {
  const route = makeLine([[0, 0], [12, 0]]);
  const ix = M.lineIndex(route);
  const asked = [];
  const fetchFn = async (url) => {
    const q = new URL(url).searchParams;
    const lons = q.get("longitude").split(",").map(Number), lats = q.get("latitude").split(",").map(Number);
    lons.forEach((lon, i) => asked.push([lon, lats[i]]));
    return { ok: true, status: 200, json: async () => ({ elevation: lons.map(() => 1000) }) };
  };
  const built = await E.buildProfile({ total: ix.total, pointAt: (m) => M.pointAtM(ix, m), fetchOpts: { fetchFn } });
  near(built.profile.length, 121, 1);
  assert.equal(built.fetched, built.profile.length);
  assert.ok(built.profile.every((ft) => ft === 3281), "metres to feet");
  assert.ok(M.hav(asked[0], pt(0, 0)) < 1 && M.hav(asked.at(-1), pt(12, 0)) < 1, "endpoints included");
  near(M.hav(asked[0], asked[1]), 100, 2, "one sample per 100 m");
  near(M.hav(asked.at(-2), asked.at(-1)), 100, 2);
});

test("after an edit only the drawn legs are fetched; kept stretches reuse the old profile", async () => {
  // Old line: 10 km, profile = feet equal to metres along / 10. The edit
  // replaced 4..6 km with a 3 km detour (new line 11 km).
  const old = { profile: Array.from({ length: 101 }, (_, k) => k * 10), total: 10000, spans: [{ n0: 0, n1: 4000, o0: 0, o1: 4000 }, { n0: 7000, n1: 11000, o0: 6000, o1: 10000 }] };
  const api = fakeApi();
  const built = await E.buildProfile({ total: 11000, pointAt: (m) => pt(m / 1000, 0), reuse: old, fetchOpts: { fetchFn: api.fetchFn } });
  assert.equal(built.profile.length, 111);
  assert.equal(built.fetched, 29, "samples strictly inside the 3 km detour");
  assert.deepEqual(api.calls, [29]);
  assert.deepEqual([built.profile[0], built.profile[40], built.profile[70], built.profile[110]], [0, 400, 600, 1000], "old values at their new place");
  // A mirrored span reads the old profile backwards (a regenerated way back).
  const back = await E.buildProfile({ total: 4000, pointAt: () => pt(0, 0), reuse: { ...old, spans: [{ n0: 0, n1: 4000, o0: 4000, o1: 0 }] }, fetchOpts: { fetchFn: api.fetchFn } });
  assert.equal(back.fetched, 0);
  assert.deepEqual([back.profile[0], back.profile.at(-1)], [400, 0]);
});

/** A fake Open-Meteo: elevation = number of points served so far. */
function fakeApi({ failOn = () => false } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0, served = 0, n = 0;
  const fetchFn = async (url) => {
    const call = ++n;
    const count = new URL(url).searchParams.get("latitude").split(",").length;
    calls.push(count);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (failOn(call)) return { ok: false, status: 429, json: async () => ({}) };
    const elevation = Array.from({ length: count }, () => served++);
    return { ok: true, status: 200, json: async () => ({ elevation }) };
  };
  return { fetchFn, calls, get maxInFlight() { return maxInFlight; } };
}
const points = (n) => Array.from({ length: n }, (_, k) => pt(k * 0.1, 0));

test("elevations are fetched in sequential chunks of at most 100", async () => {
  const api = fakeApi();
  const out = await E.fetchElevations(points(237), { fetchFn: api.fetchFn });
  assert.deepEqual(api.calls, [100, 100, 37]);
  assert.equal(api.maxInFlight, 1, "one request at a time");
  assert.deepEqual([out.length, out[0], out[236]], [237, 0, 236], "in order, complete");
});

test("a failed chunk is retried with backoff; if it keeps failing the whole profile is rejected", async () => {
  const flaky = fakeApi({ failOn: (call) => call === 2 || call === 3 });
  const out = await E.fetchElevations(points(237), { fetchFn: flaky.fetchFn, retryDelays: [1, 1, 1] });
  assert.equal(out.length, 237);
  assert.deepEqual(flaky.calls, [100, 100, 100, 100, 37]);
  assert.deepEqual([out[0], out[100], out[236]], [0, 100, 236], "the retried chunk lands in its place");

  const down = fakeApi({ failOn: (call) => call >= 2 });
  await assert.rejects(E.fetchElevations(points(237), { fetchFn: down.fetchFn, retryDelays: [1, 1, 1] }), /HTTP 429/);
  assert.deepEqual(down.calls, [100, 100, 100, 100, 100], "1 try + 3 retries, then nothing: no half profile");
  assert.deepEqual(E.RETRY_DELAYS_MS, [1000, 8000, 30000], "the last wait clears a rate-limit minute");
});

test("a fetch for a line that changed meanwhile resolves null", async () => {
  const api = fakeApi();
  let stale = false;
  const p = E.fetchElevations(points(237), { fetchFn: async (u) => { const r = await api.fetchFn(u); stale = true; return r; }, isStale: () => stale });
  assert.equal(await p, null);
  assert.deepEqual(api.calls, [100]);
});

test("gain and loss: every step counted (the existing method)", () => {
  assert.deepEqual(E.gainLoss([100, 110, 105, 120, 90]), { gain: 25, loss: 35 });
});

test("a dense profile (1,599 samples, 6 days) builds and draws in the panel", () => {
  // 80 km out and back: 800 samples out, mirrored without downsampling.
  const route = makeLine([[0, 0], [40, 0], [80, 0]]);
  route.properties.elevation_profile = Array.from({ length: 800 }, (_, k) => Math.round(5200 + 900 * Math.sin(k / 90) + 40 * Math.sin(k / 3)));
  const trip = makeTrip([route]);
  appendReturn(trip);
  assert.equal(route.properties.elevation_profile.length, 1599);
  const ix = M.lineIndex(route);
  for (let k = 1; k <= 5; k++) trip.features.push(point(`C${k}`, { type: "camp", attach: { route_id: "R", ...M.locateM(ix, (ix.total * k) / 6) } }));
  const t0 = performance.now();
  const plan = M.syncLineTrip(trip);
  const model = buildItinerary(M.displayTrip(trip, plan));
  const svg = drawProfile(model, 464, { height: 220, active: 2 });
  const compact = drawProfile(model, 464, { compact: true });
  const ms = performance.now() - t0;
  assert.equal(model.days.length, 6);
  assert.equal(model.complete, true);
  near(model.days.reduce((a, d) => a + d.pieces.reduce((b, p) => b + p.profile.length, 0), 0), 1599 + 5, 6, "every sample reaches the drawing");
  // Day elevation is continuous across camps (the same sample ends one day and starts the next).
  for (let i = 1; i < 6; i++) near(model.days[i].pieces[0].profile[0], model.days[i - 1].pieces[0].profile.at(-1), 1);
  assert.ok(svg.startsWith("<svg") && compact.startsWith("<svg"));
  assert.ok(!/NaN/.test(svg) && !/NaN/.test(compact), "no NaN in the drawing");
  assert.ok(ms < 1500, `plan + model + two drawings took ${ms.toFixed(0)} ms`);
  console.log(`      (plan + model + full and compact profile: ${ms.toFixed(0)} ms, svg ${(svg.length / 1024).toFixed(0)} KB)`);
});
