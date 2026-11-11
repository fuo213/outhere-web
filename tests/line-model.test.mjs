// line-model.js: anchoring, passes, the plan (camps → days), place-stop
// visits, the per-day display view, and the opt-in 1.1 → 1.2 conversion.
import { test, assert, near, pt, makeLine, makeTrip, point } from "./helpers.mjs";
import * as M from "../line-model.js";
import { appendReturn } from "../line-edit.js";

/** 3 km east in three legs, then back the same way (6 legs, ~6 km). */
function outAndBack() {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const trip = makeTrip([route]);
  appendReturn(trip);
  return { trip, route, ix: M.lineIndex(route) };
}
const attachAt = (ix, m) => ({ route_id: "R", ...M.locateM(ix, m) });

test("index, passes and per-leg anchoring on an out-and-back", () => {
  const { ix } = outAndBack();
  assert.equal(ix.legs.length, 6);
  near(ix.total, 6000, 20, "total");
  const p = pt(1.5, 0.03); // 30 m off the trail, 1.5 km out
  const passes = M.passesNear(ix, p, 100);
  assert.equal(passes.length, 2);
  near(passes[0].m, 1500, 10); near(passes[1].m, 4500, 10);
  // A camp dropped here after a camp at 2.5 km goes on the way back.
  near(M.choosePass(ix, p, 100, 2500).m, 4500, 10);
  near(M.choosePass(ix, p, 100, -1).m, 1500, 10);
  // The same spot resolves to different metres depending on its leg.
  const back = M.locateM(ix, 4500);
  assert.equal(back.leg, 4);
  near(M.resolveAttach(ix, back).m, 4500, 1);
  near(M.resolveAttach(ix, { leg: 1, offset_m: back.offset_m }).m, 1000 + back.offset_m, 5);
});

test("days build themselves: numbering, nights, dates, off-route, notes follow camps", () => {
  const { trip, ix } = outAndBack();
  trip.features.push(
    point("C1", { type: "camp", nights: 2, attach: attachAt(ix, 3000) }),
    point("C0", { type: "camp", attach: attachAt(ix, 1500) }),
    point("B", { type: "break", attach: attachAt(ix, 4500) }),
    point("W", { type: "waypoint", subtype: "water" }, pt(1.5, 0.03)),
    point("OFF", { type: "camp" }, pt(40, 40)),
  );
  const plan = M.syncLineTrip(trip);
  assert.deepEqual(plan.camps.map((c) => [c.id, c.n]), [["C0", 1], ["C1", 2]]);
  assert.deepEqual(plan.days.map((d) => d.kind), ["move", "move", "rest", "move"]);
  assert.deepEqual(trip.days.map((d) => d.date), ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]);
  assert.equal(trip.properties.dates.end, "2026-09-15");
  // Water is listed on the way out (day 1) and on the way back (day 4).
  assert.deepEqual(plan.days.map((d) => d.stops.filter((s) => !s.offRoute).map((s) => s.id).join(",")), ["W,C0", "C1", "", "W,B"]);
  assert.deepEqual(plan.offRoute.map((o) => o.id), ["OFF"]);
  const c0 = trip.features.find((f) => f.properties._id === "C0");
  assert.ok(M.hav(c0.geometry.coordinates, M.pointAtM(ix, 1500)) < 1, "geometry follows attach");
  assert.equal(c0.properties.date, "2026-09-12");

  trip.days[1].notes = "to camp 2";
  trip.features.push(point("C00", { type: "camp", attach: attachAt(ix, 500) }));
  M.syncLineTrip(trip);
  assert.equal(trip.days.find((d) => d.notes === "to camp 2")._key, "to:C1", "notes stay with the camp the day ends at");
});

// Four switchbacks, 500 m long and 60 m apart.
const ZIGZAG = [[0, 0], [0.5, 0], [0.5, 0.06], [0, 0.06], [0, 0.12], [0.5, 0.12], [0.5, 0.18], [0, 0.18]];
const listings = (plan, id) => plan.days.flatMap((d) => d.stops.filter((s) => s.id === id).map((s) => ({ day: d.n, m: s.m })));

test("a place stop beside switchbacks is listed once, at the closest pass", () => {
  const route = makeLine(ZIGZAG);
  const trip = makeTrip([route, point("W", { type: "waypoint", subtype: "water" }, pt(0.25, 0.07))]);
  const ix = M.lineIndex(route);
  assert.ok(M.passesNear(ix, pt(0.25, 0.07), M.NEAR_M).length >= 3, "several switchbacks are within reach");
  let got = listings(M.buildPlan(trip), "W");
  assert.equal(got.length, 1);
  near(got[0].m, 500 + 60 + 250, 15, "the 60 m switchback, 10 m away");
  // A camp between the switchbacks doesn't make it appear in both days.
  trip.features.push(point("C", { type: "camp", attach: attachAt(ix, 600) }));
  got = listings(M.buildPlan(trip), "W");
  assert.deepEqual(got.map((g) => g.day), [2]);
});

test("the same place stop is still listed out and back on an out-and-back", () => {
  const route = makeLine(ZIGZAG);
  const trip = makeTrip([route, point("W", { type: "waypoint", subtype: "water" }, pt(0.25, 0.07))]);
  appendReturn(trip);
  const ix = M.lineIndex(route);
  const got = listings(M.buildPlan(trip), "W");
  assert.equal(got.length, 2, "once per visit");
  near(got[0].m, 810, 15); near(got[1].m, ix.total - 810, 15);
  assert.deepEqual(M.buildPlan(trip).days[0].stops.filter((s) => s.id === "W").map((s) => M.passLabel(s)), ["out", "back"]);
});

test("displayTrip keeps the stored profile's density in each day", () => {
  const { trip, ix } = outAndBack();
  const n = 601; // one sample per 10 m
  trip.features[0].properties.elevation_profile = Array.from({ length: n }, (_, k) => Math.round(5000 + 300 * Math.sin(k / 40) + 7 * Math.sin(k * 1.7)));
  trip.features.push(point("C", { type: "camp", attach: attachAt(ix, 4200) }));
  const plan = M.buildPlan(trip);
  const view = M.displayTrip(trip, plan);
  const pieces = view.features.filter((f) => f.properties.type === "route");
  assert.equal(pieces.length, 2);
  for (const f of pieces) for (const s of f.properties.segments) assert.ok(s.coord_range[1] < f.geometry.coordinates.length && s.coord_range[0] <= s.coord_range[1]);
  near(pieces.reduce((a, f) => a + f.properties.main_route_distance_mi, 0) * M.MI, ix.total, 5);
  const [d1, d2] = pieces.map((f) => f.properties.elevation_profile.length);
  near(d1, 421, 2, "day 1 samples (4.2 of 6 km)"); near(d2, 181, 2, "day 2 samples");
  assert.ok(d1 > 100, "no 100-sample cap");
});

// ---------------------------------------------------------------------------
// 1.1 → 1.2 conversion (opt-in)
// ---------------------------------------------------------------------------

/**
 * A 1.1 trip as the old planner wrote it: main vertices 0,1,(2 = dayhike),3,4.
 * The day-hike marker sits at the far end of a spur that leaves vertex 1.
 */
function legacyTrip({ campAtBranch = false } = {}) {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0]], "R2");
  const rp = route.properties;
  rp.vertex_types = ["route", campAtBranch ? "camp" : "route", "dayhike", "camp", "route"];
  rp.vertex_coords = [pt(0, 0), pt(1, 0), pt(1, 0.8), pt(2, 0), pt(3, 0)];
  rp.segments[0] = { ...rp.segments[0], from_vertex: 0, to_vertex: 1 };
  rp.segments[1] = { ...rp.segments[1], from_vertex: 1, to_vertex: 3 };
  rp.segments[2] = { ...rp.segments[2], from_vertex: 3, to_vertex: 4 };
  const spur = makeLine([[1, 0], [1, 0.8]], "S");
  spur.properties = { type: "dayhike_spur", _id: "S", route_index: 0, name: "", segments: [{ mode: "trail", from_vertex: 0, to_vertex: 1, coord_range: [0, spur.geometry.coordinates.length - 1] }] };
  const feats = [
    route, spur,
    point("DH", { type: "dayhike", point_type: "dayhike", route_index: 0, route_vertex_index: 2, name: "The overlook", notes: "Go early." }, pt(1, 0.8)),
    point("LC", { type: "camp", point_type: "camp", route_index: 0, route_vertex_index: 3, name: "" }, pt(2, 0)),
    point("LR", { type: "rest", point_type: "rest", route_index: 0, route_vertex_index: 4 }, pt(3, 0)),
  ];
  if (campAtBranch) feats.push(point("BC", { type: "camp", point_type: "camp", route_index: 0, route_vertex_index: 1, name: "Junction camp" }, pt(1, 0)));
  const trip = makeTrip(feats, { version: "1.1" });
  trip.days = [{ id: "d1", date: null, features: ["R2", "S", "DH", "LC"], notes: "day one" }, { id: "d2", date: null, features: ["LR"], notes: "" }];
  return trip;
}

test("conversion is opt-in and only for one routed line", () => {
  const trip = legacyTrip();
  assert.equal(M.canConvertToLine(trip), true);
  assert.equal(M.isLineTrip(trip), false, "nothing converts by itself");
  const two = legacyTrip(); two.features.push(makeLine([[0, 1], [1, 1]], "R3"));
  assert.equal(M.canConvertToLine(two), false);
  const gpx = legacyTrip(); gpx.features[0].properties.segments[0].mode = "imported";
  assert.equal(M.canConvertToLine(gpx), false);
  assert.equal(M.convertTypedVertices(gpx), false);
  assert.equal(gpx.properties.schema_version, "1.1");
  const done = legacyTrip(); M.convertTypedVertices(done);
  assert.equal(M.canConvertToLine(done), false, "already 1.2");
});

test("conversion: a day-hike marker becomes a break at the spur's branch point, on the route", () => {
  const trip = legacyTrip();
  assert.equal(M.convertTypedVertices(trip), true);
  assert.equal(trip.properties.schema_version, "1.2");
  const get = (id) => trip.features.find((f) => f.properties._id === id);
  const dh = get("DH");
  assert.equal(dh.properties.type, "break");
  assert.equal(dh.properties.attach.leg, 0, "the leg that ends at the branch vertex");
  near(dh.properties.attach.offset_m, 1000, 15);
  assert.ok(M.hav(dh.geometry.coordinates, pt(1, 0)) < 5, "moved from the spur's far end to the line");
  assert.equal(get("S").properties.from_stop, "DH");
  assert.equal(get("S").properties.name, "The overlook", "the marker named the destination");
  // Camp + rest: attached at its vertex, the rest day is a second night.
  const lc = get("LC").properties;
  assert.deepEqual([lc.attach.leg, lc.nights], [1, 2]);
  near(lc.attach.offset_m, 1000, 15);
  assert.equal(get("LR"), undefined);

  const plan = M.syncLineTrip(trip);
  assert.deepEqual(plan.offRoute, [], "nothing is flagged off route");
  assert.equal(plan.stopsById.get("DH").offRoute, false);
  assert.deepEqual(plan.days.map((d) => d.kind), ["move", "rest", "move"]);
  assert.deepEqual(plan.days[0].spurs.map((s) => [s.id, s.fromStop]), [["S", "DH"]]);
  near(plan.days[0].spurs[0].m, 1000, 15, "the spur leaves the line at the branch point");
  assert.ok(trip.days.every((d) => d.features.every((id) => get(id))), "days reference live features only");
});

test("conversion: a day hike from a camp leaves from that camp", () => {
  const trip = legacyTrip({ campAtBranch: true });
  assert.equal(M.convertTypedVertices(trip), true);
  const get = (id) => trip.features.find((f) => f.properties._id === id);
  assert.equal(get("DH"), undefined, "the marker folds into the spur");
  assert.deepEqual([get("S").properties.from_stop, get("S").properties.name, get("S").properties.notes], ["BC", "The overlook", "Go early."]);
  const plan = M.syncLineTrip(trip);
  assert.deepEqual(plan.offRoute, []);
  assert.deepEqual(plan.camps.map((c) => c.id), ["BC", "LC"]);
  assert.equal(plan.days.find((d) => d.spurs.length).camp.id, "BC");
});

// ---- profile metre mapping, moving a camp, same campsite ---------------------

import { moveStopAlong } from "../line-edit.js";
import { lineSpotAtMile, buildItinerary } from "../itinerary-profile.js";

test("profile mile on an out-and-back names the pass; rest days place nothing", () => {
  const { trip, ix } = outAndBack();
  trip.features.push(point("C1", { type: "camp", nights: 2, attach: attachAt(ix, 3000) }));
  const view = M.displayTrip(trip);
  const model = buildItinerary(view);
  model.line = true;
  const d0 = model.days[0];
  assert.equal(d0.fromM, 0);
  // 1.5 km into day 1 is the way out; the same ground on the day after the rest day is the way back.
  const out = lineSpotAtMile(model, 1500 / M.MI);
  near(out.m, 1500, 5, "out pass");
  const lastDay = model.days.at(-1);
  const back = lineSpotAtMile(model, lastDay.startMi + 1500 / M.MI); // 1.5 km into the last day = 4.5 km of line
  near(back.m, 4500, 5, "back pass");
  assert.ok(back.m > out.m + 2000);
  const rest = model.days.find((d) => d.empty);
  const r = lineSpotAtMile(model, (rest.startMi + rest.endMi) / 2);
  assert.equal(r.rest, true);
  near(r.m, 3000, 5, "rest day gives its camp");
  assert.equal(lineSpotAtMile(model, model.total + 5), null);
});

test("moveStopAlong re-attaches a camp to the pass at that metre and days follow", () => {
  const { trip, ix } = outAndBack();
  trip.features.push(point("C1", { type: "camp", attach: attachAt(ix, 1500) }), point("C2", { type: "camp", attach: attachAt(ix, 4500) }));
  assert.ok(moveStopAlong(trip, "C1", 4000));
  const c1 = trip.features.find((f) => f.properties._id === "C1");
  near(M.resolveAttach(ix, c1.properties.attach).m, 4000, 1);
  const plan = M.buildPlan(trip);
  assert.deepEqual(plan.camps.map((c) => c.id), ["C1", "C2"]); // 4000 < 4500
  assert.ok(moveStopAlong(trip, "C1", 5000));
  assert.deepEqual(M.buildPlan(trip).camps.map((c) => c.id), ["C2", "C1"]);
  assert.equal(moveStopAlong(trip, "nope", 100), false);
});

test("same campsite: candidate only on a later pass; link shares name and notes; stale links drop", () => {
  const { trip, ix } = outAndBack();
  trip.features.push(
    point("C1", { type: "camp", name: "Lake camp", notes: "wind", attach: attachAt(ix, 1500) }),
    point("C0", { type: "camp", attach: attachAt(ix, 1550) }),   // same pass, 50 m on: not a candidate
    point("C2", { type: "camp", attach: attachAt(ix, 4500) }),   // way back, same ground
  );
  let plan = M.buildPlan(trip);
  assert.equal(M.sameSiteCandidate(plan, "C0"), null);
  const cand = M.sameSiteCandidate(plan, "C2");
  assert.equal(cand.id, "C1"); // closest earlier camp on another pass (C0 is 50 m off, C1 on the same pass as C0 but closer in space)
  assert.ok(M.linkSameSite(trip, "C2", cand.id));
  const c2 = trip.features.find((f) => f.properties._id === "C2").properties;
  assert.equal(c2.same_place_as, "C1");
  assert.equal(c2.name, "Lake camp"); assert.equal(c2.notes, "wind");
  // Editing either shares name and notes.
  c2.name = "Lake camp (shady)";
  M.shareCampFields(trip, "C2");
  assert.equal(trip.features.find((f) => f.properties._id === "C1").properties.name, "Lake camp (shady)");
  plan = M.buildPlan(trip);
  assert.equal(plan.camps.find((c) => c.id === "C2").sameAs, plan.camps.find((c) => c.id === "C1").n);
  assert.deepEqual(M.campGroup(trip, "C2").sort(), ["C1", "C2"]);
  // Moving it far from the site drops the link.
  moveStopAlong(trip, "C2", 5500);
  M.syncLineTrip(trip);
  assert.equal(trip.features.find((f) => f.properties._id === "C2").properties.same_place_as, undefined);
  // Deleting the first camp drops it too.
  moveStopAlong(trip, "C2", 4500); M.linkSameSite(trip, "C2", "C1");
  trip.features = trip.features.filter((f) => f.properties._id !== "C1");
  M.syncLineTrip(trip);
  assert.equal(trip.features.find((f) => f.properties._id === "C2").properties.same_place_as, undefined);
});
