// line-edit.js: selecting and deleting a section of the line, deleting the line.
import { test, assert, near, pt, makeLine, makeTrip, point } from "./helpers.mjs";
import * as M from "../line-model.js";
import { sectionAt, sectionCoords, deleteSection, deleteLine, appendReturn } from "../line-edit.js";

const attachAt = (ix, m) => ({ route_id: "R", ...M.locateM(ix, m) });
const get = (trip, id) => trip.features.find((f) => f.properties._id === id);

/** 4 km east in four 1 km legs; stops on legs 0..3 plus a water place stop. */
function fourLegs() {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  const trip = makeTrip([route]);
  const ix = M.lineIndex(route);
  trip.features.push(
    point("C0", { type: "camp", attach: attachAt(ix, 500) }, pt(0.5)),
    point("C1", { type: "camp", attach: attachAt(ix, 1500) }, pt(1.5)),
    point("C2", { type: "break", attach: attachAt(ix, 2500) }, pt(2.5)),
    point("C3", { type: "camp", attach: attachAt(ix, 3500) }, pt(3.5)),
    point("W", { type: "waypoint", subtype: "water" }, pt(2.5, 0.01)),
  );
  M.syncLineTrip(trip);
  return { trip, route };
}

test("sectionAt picks the leg under a metre and says where it sits", () => {
  const { route } = fourLegs();
  const s = (m) => sectionAt(route, m);
  assert.deepEqual([s(100).leg, s(100).where], [0, "first"]);
  assert.deepEqual([s(1500).leg, s(1500).where], [1, "middle"]);
  assert.deepEqual([s(3999).leg, s(3999).where], [3, "last"]);
  assert.equal(s(1000.2).leg, 1, "a joint belongs to the leg that starts there");
  assert.equal(sectionAt(makeLine([[0, 0], [1, 0]]), 300).where, "only");
  near(sectionCoords(route, 1).length ? M.hav(sectionCoords(route, 1)[0], sectionCoords(route, 1).at(-1)) : 0, 1000, 5, "section length");
});

test("delete the last section: the line is trimmed to the neighbouring anchor", () => {
  const { trip, route } = fourLegs();
  const res = deleteSection(trip, 3);
  assert.equal(res.removed, "last");
  assert.equal(route.properties.segments.length, 3);
  near(M.lineIndex(route).total, 3000, 8, "length");
  assert.equal(route.properties.vertex_coords.length, 4);
  assert.deepEqual(res.lost.map((l) => l.id), ["C3"]);
  assert.equal(get(trip, "C3").properties.attach, undefined, "stop on the removed section is off route, not deleted");
  assert.ok(get(trip, "C1").properties.attach && get(trip, "C2").properties.attach);
  assert.ok(get(trip, "W"), "place stop kept");
});

test("delete the first section: the line now starts at the second anchor", () => {
  const { trip, route } = fourLegs();
  const res = deleteSection(trip, 0);
  assert.equal(res.removed, "first");
  assert.equal(route.properties.segments.length, 3);
  near(M.lineIndex(route).total, 3000, 8, "length");
  assert.ok(M.hav(route.geometry.coordinates[0], pt(1)) < 1, "starts at anchor 1");
  assert.deepEqual(res.lost.map((l) => l.id), ["C0"]);
  // C1 was 500 m into old leg 1, now leg 0
  assert.equal(get(trip, "C1").properties.attach.leg, 0);
  near(get(trip, "C1").properties.attach.offset_m, 500, 3, "offset");
  assert.equal(get(trip, "C3").properties.attach.leg, 2);
});

test("delete a middle section: anchors are joined by the bridge and the line stays continuous", () => {
  const { trip, route } = fourLegs();
  // routed bridge bows north
  const bridge = { coords: [pt(1), pt(1.25, 0.15), pt(1.5, 0.3), pt(1.75, 0.15), pt(2)], mode: "trail", wayIds: [7] };
  const res = deleteSection(trip, 1, { bridge });
  assert.equal(res.removed, "middle");
  const rp = route.properties;
  assert.equal(rp.segments.length, 4);
  assert.deepEqual(rp.segments.map((s) => s.mode), ["trail", "trail", "trail", "trail"]);
  assert.deepEqual(rp.segments[1].osm_way_ids, [7]);
  const c = route.geometry.coordinates;
  for (let i = 1; i < c.length; i++) assert.ok(M.hav(c[i - 1], c[i]) < 400, "no jump between coordinates");
  assert.equal(rp.vertex_coords.length, 5);
  assert.deepEqual(rp.segments.map((s, k) => [s.from_vertex, s.to_vertex]), [[0, 1], [1, 2], [2, 3], [3, 4]]);
  // C1 sat on the removed section, 1.5 km east: the bridge peak is 0.3 km off: beyond? 300 m > NEAR_M -> off route
  assert.deepEqual(res.lost.map((l) => l.id), ["C1"]);
  // stops after the gap keep their leg offsets, indices unchanged (leg count same)
  assert.equal(get(trip, "C2").properties.attach.leg, 2);
  near(get(trip, "C2").properties.attach.offset_m, 500, 3, "offset");
  assert.equal(get(trip, "C0").properties.attach.leg, 0);
});

test("delete a middle section with no bridge: a straight manual segment", () => {
  const { trip, route } = fourLegs();
  const res = deleteSection(trip, 2);
  assert.equal(route.properties.segments[2].mode, "manual");
  near(M.lineIndex(route).total, 4000, 8);
  // the straight segment lies on the old section, so the stop on it re-attaches
  assert.deepEqual(res.lost, []);
  assert.equal(res.reattached, 1);
  assert.equal(get(trip, "C2").properties.attach.leg, 2);
});

test("delete the only section removes the line and keeps stops off route", () => {
  const route = makeLine([[0, 0], [1, 0]]);
  const trip = makeTrip([route]);
  trip.features.push(point("C", { type: "camp", attach: attachAt(M.lineIndex(route), 400) }, pt(0.4)));
  const res = deleteSection(trip, 0);
  assert.equal(res.removed, "line");
  assert.equal(M.mainRoute(trip), null);
});

test("deleteLine detaches every time stop in place, keeps place stops, drops the line", () => {
  const { trip } = fourLegs();
  const res = deleteLine(trip);
  assert.equal(res.lost.length, 4);
  assert.equal(M.mainRoute(trip), null);
  for (const id of ["C0", "C1", "C2", "C3"]) {
    const f = get(trip, id);
    assert.equal(f.properties.attach, undefined);
    assert.equal(f.geometry.type, "Point");
  }
  near(M.hav(get(trip, "C1").geometry.coordinates, pt(1.5)), 0, 2, "stays where it was");
  assert.ok(get(trip, "W"));
  assert.doesNotThrow(() => M.syncLineTrip(trip));
});

test("deleting an outbound section on a linked out-and-back rebuilds the way back", () => {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const trip = makeTrip([route]);
  appendReturn(trip);
  assert.equal(route.properties.segments.length, 6);
  const bridge = { coords: [pt(1), pt(1.5, 0.05), pt(2)], mode: "trail" };
  const res = deleteSection(trip, 1, { bridge });
  assert.equal(res.removed, "middle");
  assert.equal(res.regenerated, true);
  assert.equal(route.properties.segments.length, 6);
  assert.equal(route.properties.return_same_way, true);
  const c = route.geometry.coordinates;
  for (let i = 0; i < c.length; i++) assert.deepEqual(c[i], c[c.length - 1 - i], `coordinate ${i} mirrors`);
});
