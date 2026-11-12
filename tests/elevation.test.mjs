// elevation.js: sample density, chunked all-or-nothing fetching, and that a
// dense profile still draws quickly.
import { test, assert, near, pt, makeLine, makeTrip, point } from "./helpers.mjs";
import * as E from "../elevation.js";
import * as G from "../gpx-core.js";
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

test("gain and loss use the 3 m hysteresis GPX imports use (one shared function)", () => {
  assert.equal(G.hysteresisGainLoss, E.hysteresisGainLoss, "gpx-core re-exports elevation.js, no copy");
  assert.equal(G.HYSTERESIS_M, 3);
  // A steady 1,000 ft climb with +/- 6 ft of DEM noise on every sample.
  const noisy = Array.from({ length: 201 }, (_, k) => 5000 + k * 5 + (k % 2 ? 6 : -6));
  let everyStep = 0;
  for (let k = 1; k < noisy.length; k++) everyStep += Math.max(0, noisy[k] - noisy[k - 1]);
  const { gain, loss } = E.gainLoss(noisy);
  assert.ok(everyStep > 1600, `summing every step counts the noise: ${everyStep}`);
  near(gain, 1000, 15, "hysteresis gain");
  assert.equal(loss, 0, "wiggles under 3 m (9.8 ft) are not descents");
  // Real swings count in full: up 100, down 40, up 60.
  assert.deepEqual(E.gainLoss([1000, 1050, 1100, 1080, 1060, 1090, 1120]), { gain: 160, loss: 40 });
  assert.deepEqual(E.gainLoss([1000]), { gain: 0, loss: 0 });
});

test("each day's slice and a mirrored return get hysteresis gain, from the full-density profile", () => {
  const route = makeLine([[0, 0], [10, 0]]);
  // 100 m spacing: a 1,000 ft climb to halfway, then flat, +/- 3 ft noise throughout.
  const prof = Array.from({ length: 101 }, (_, k) => 5000 + Math.min(k, 50) * 20 + (k % 2 ? 3 : -3));
  route.properties.elevation_profile = prof;
  const trip = makeTrip([route]);
  const ix = M.lineIndex(route);
  trip.features.push(point("C", { type: "camp", attach: { route_id: "R", ...M.locateM(ix, ix.total / 2) } }));
  const pieces = () => M.displayTrip(trip, M.buildPlan(trip)).features.filter((f) => f.properties.type === "route").map((f) => f.properties);
  let [d1, d2] = pieces();
  near(d1.elevation_gain_ft, 1000, 15, "day 1 climbs");
  assert.ok(d2.elevation_gain_ft <= 12 && d2.elevation_loss_ft <= 12, `day 2 is flat, not ${d2.elevation_gain_ft} ft of noise`);
  assert.equal(d1.elevation_profile.length + d2.elevation_profile.length, 102, "slices keep every sample");
  assert.equal(route.properties.elevation_profile.length, 101, "the stored profile is untouched");

  appendReturn(trip);
  const rp = route.properties;
  assert.equal(rp.elevation_profile.length, 201);
  near(rp.elevation_gain_ft, 1000, 15); near(rp.elevation_loss_ft, 1000, 15);
  const days = pieces();
  near(days.reduce((a, d) => a + d.elevation_loss_ft, 0), 1000, 30, "the descent shows up on the way back");
});

test("trying again after a failed fetch asks only for what is missing", async () => {
  // After an edit: 0..4 km and 7..11 km still have elevation, the 3 km detour doesn't.
  const reuse = { profile: Array.from({ length: 101 }, (_, k) => k * 10), total: 10000, spans: [{ n0: 0, n1: 4000, o0: 0, o1: 4000 }, { n0: 7000, n1: 11000, o0: 6000, o1: 10000 }] };
  const job = (fetchFn) => E.buildProfile({ total: 11000, pointAt: (m) => pt(m / 1000, 0), reuse, fetchOpts: { fetchFn, retryDelays: [1] } });
  const down = fakeApi({ failOn: () => true });
  await assert.rejects(job(down.fetchFn), /HTTP 429/);
  assert.deepEqual(down.calls, [29, 29], "the outage only ever saw the missing samples");
  const up = fakeApi();
  const built = await job(up.fetchFn); // what "Try again" runs: same line, same reuse
  assert.deepEqual(up.calls, [29]);
  assert.deepEqual([built.profile.length, built.fetched], [111, 29]);
  assert.ok(built.profile.every(Number.isFinite), "a whole profile, no holes");
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

// ---------------------------------------------------------------------------
// One definition of climb: per-day figures come off the route's climb curve
// ---------------------------------------------------------------------------

const FT = 3.28084;
/** A rolling 12 km climb, 10 m fine series like the 3DEP path (metres). */
const fineSeries = () => Array.from({ length: 1201 }, (_, i) => 1500 + 0.03 * i * 10 + 2.0 * Math.sin((i * 10 * 2 * Math.PI) / 90) + 0.8 * Math.sin(i * 0.9));
/** What profileForRoute stores: the profile at `n` samples plus the climb curve, counted on the fine series. */
function storedRoute(fine, n) {
  const { gain, loss, gainAt, lossAt } = E.hysteresisClimb(fine, E.HYSTERESIS_M);
  const at = (s, t) => { const x = t * (s.length - 1), k = Math.min(s.length - 2, Math.floor(x)); return s[k] + (x - k) * (s[k + 1] - s[k]); };
  const ks = Array.from({ length: n }, (_, k) => k / (n - 1));
  return {
    elevation_profile: ks.map((t) => Math.round(at(fine, t) * FT)),
    elevation_gain_ft: Math.round(gain * FT), elevation_loss_ft: Math.round(loss * FT),
    _climb_ft: { gain: ks.map((t) => Math.round(at(gainAt, t) * FT)), loss: ks.map((t) => Math.round(at(lossAt, t) * FT)) },
  };
}
const cuts = [0, 1900, 3700, 5200, 7400, 9100, 12000];

test("hysteresisClimb: cumulative curves end at the totals and match hysteresisGainLoss", () => {
  const fine = fineSeries();
  const a = E.hysteresisClimb(fine, 3), b = E.hysteresisGainLoss(fine, 3);
  assert.equal(a.gain, b.gain); assert.equal(a.loss, b.loss);
  near(a.gainAt.at(-1), a.gain, 1e-9); near(a.lossAt.at(-1), a.loss, 1e-9);
  for (let i = 1; i < fine.length; i++) assert.ok(a.gainAt[i] >= a.gainAt[i - 1] - 1e-9 && a.lossAt[i] >= a.lossAt[i - 1] - 1e-9, "monotone");
});

test("slicing a coarse profile at day cuts loses gain; the climb curve does not", () => {
  const props = storedRoute(fineSeries(), 221); // ~55 m spacing, like a 12 km line capped at 1,000 samples on a long trip
  const days = cuts.slice(1).map((m1, i) => [cuts[i], m1]);
  // The old way: slice the stored profile per day and count each slice alone.
  const slice = (m0, m1) => {
    const n = props.elevation_profile.length, t = (m) => (m / 12000) * (n - 1);
    const k = Math.max(2, Math.round(t(m1) - t(m0)) + 1);
    return Array.from({ length: k }, (_, j) => { const x = t(m0) + ((t(m1) - t(m0)) * j) / (k - 1), i = Math.min(n - 2, Math.floor(x)); return Math.round(props.elevation_profile[i] + (x - i) * (props.elevation_profile[i + 1] - props.elevation_profile[i])); });
  };
  const old = days.reduce((a, [m0, m1]) => a + E.gainLoss(slice(m0, m1)).gain, 0);
  assert.ok(old < props.elevation_gain_ft * 0.97, `old per-day sum ${old} reads at least 3% under the route total ${props.elevation_gain_ft}`);
  const sum = { gain: 0, loss: 0 };
  for (const [m0, m1] of days) { const c = E.climbBetween(props, 12000, m0, m1); sum.gain += c.gain; sum.loss += c.loss; }
  assert.equal(sum.gain, props.elevation_gain_ft, "days add up to the route gain");
  assert.equal(sum.loss, props.elevation_loss_ft, "days add up to the route loss");
});

test("without a stored curve (Open-Meteo, recorded, older files) days still add up", () => {
  const props = storedRoute(fineSeries(), 121);
  delete props._climb_ft;
  const whole = E.gainLoss(props.elevation_profile);
  props.elevation_gain_ft = whole.gain; props.elevation_loss_ft = whole.loss; // counted on the stored profile, as planning.js does
  let g = 0, l = 0;
  for (let i = 1; i < cuts.length; i++) { const c = E.climbBetween(props, 12000, cuts[i - 1], cuts[i]); g += c.gain; l += c.loss; }
  assert.equal(g, whole.gain); assert.equal(l, whole.loss);
  // Stored figures from a finer series than the profile: the curve is scaled to end at them.
  props.elevation_gain_ft = whole.gain + 200; props.elevation_loss_ft = whole.loss + 150;
  g = 0; l = 0;
  for (let i = 1; i < cuts.length; i++) { const c = E.climbBetween(props, 12000, cuts[i - 1], cuts[i]); g += c.gain; l += c.loss; }
  assert.equal(g, whole.gain + 200); assert.equal(l, whole.loss + 150);
  // A stale curve (wrong length, or not ending at the stored figures) is ignored.
  props._climb_ft = { gain: [0, 1], loss: [0, 1] };
  assert.equal(E.climbCurve(props).gain.length, 121);
});

test("displayTrip: per-day gain and loss add up to the route's, with camps anywhere", () => {
  const route = makeLine([[0, 0], [4, 0], [8, 0], [12, 0]]);
  Object.assign(route.properties, storedRoute(fineSeries(), 221), { elevation_source: "usgs-3dep" });
  const trip = makeTrip([route]);
  const ix = M.lineIndex(route);
  for (const m of [1900, 3700, 5200, 7400, 9100]) trip.features.push(point("C" + m, { type: "camp", attach: { route_id: "R", ...M.locateM(ix, m) } }));
  const view = M.displayTrip(trip);
  const days = view.features.filter((f) => f.properties.type === "route");
  assert.equal(days.length, 6);
  assert.equal(days.reduce((a, f) => a + f.properties.elevation_gain_ft, 0), route.properties.elevation_gain_ft);
  assert.equal(days.reduce((a, f) => a + f.properties.elevation_loss_ft, 0), route.properties.elevation_loss_ft);
  // And the trip panel's total (sum over the day pieces) is the route's figure.
  const it = buildItinerary(view);
  assert.equal(it.gain, route.properties.elevation_gain_ft); assert.equal(it.loss, route.properties.elevation_loss_ft);
});

test("appendReturn carries the climb curve: the way back gains what the way out lost", () => {
  const route = makeLine([[0, 0], [4, 0], [8, 0], [12, 0]]);
  Object.assign(route.properties, storedRoute(fineSeries(), 221), { elevation_source: "usgs-3dep" });
  const g0 = route.properties.elevation_gain_ft, l0 = route.properties.elevation_loss_ft;
  const trip = makeTrip([route]);
  appendReturn(trip);
  const rp = route.properties, cv = E.climbCurve(rp);
  assert.equal(rp.elevation_gain_ft, g0 + l0);
  assert.equal(cv.gain.length, rp.elevation_profile.length);
  assert.equal(cv.gain.at(-1), g0 + l0); assert.equal(cv.loss.at(-1), g0 + l0);
  assert.equal(cv.gain[220], g0, "the turnaround: all the way-out gain, none of the way back");
  const view = M.displayTrip(makeTrip([route]));
  const days = view.features.filter((f) => f.properties.type === "route");
  assert.equal(days.reduce((a, f) => a + f.properties.elevation_gain_ft, 0), g0 + l0);
});
