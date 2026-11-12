// line-edit.js: "Redraw from here" stitching, stop re-attachment, and the
// way back following the way out while it is still linked.
import { test, assert, near, pt, makeLine, makeTrip, point, drawnLegs } from "./helpers.mjs";
import * as M from "../line-model.js";
import { redrawLine, appendReturn, returnLink } from "../line-edit.js";

const attachAt = (ix, m) => ({ route_id: "R", ...M.locateM(ix, m) });
const get = (trip, id) => trip.features.find((f) => f.properties._id === id);
const stopM = (trip, id) => M.resolveAttach(M.lineIndex(trip.features[0]), get(trip, id).properties.attach).m;
const coordOf = (trip, id) => M.resolveAttach(M.lineIndex(trip.features[0]), get(trip, id).properties.attach).coord;

/** The second half of the line is the first half walked backwards. */
function assertPalindrome(route) {
  const c = route.geometry.coordinates;
  assert.equal(c.length % 2, 1, "odd number of coordinates (shared turnaround)");
  for (let i = 0; i < c.length; i++) assert.deepEqual(c[i], c[c.length - 1 - i], `coordinate ${i} mirrors`);
}

/** Every reuse span maps a stretch of the new line onto the same ground on the old line. */
function assertSpansMatch(reuse, oldIx, newIx) {
  assert.ok(reuse.spans.length > 0);
  for (const q of reuse.spans) {
    for (const t of [0, 0.5, 1]) {
      const a = M.pointAtM(newIx, q.n0 + t * (q.n1 - q.n0)), b = M.pointAtM(oldIx, q.o0 + t * (q.o1 - q.o0));
      assert.ok(M.hav(a, b) < 1.5, `span ${JSON.stringify(q)} at ${t}: ${M.hav(a, b).toFixed(1)} m apart`);
    }
  }
}
const frozenIndex = (route) => M.lineIndex(JSON.parse(JSON.stringify(route)));

/** 3 km east in three legs and back; stops on both passes. */
function linkedOutAndBack() {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const trip = makeTrip([route]);
  route.properties.elevation_profile = Array.from({ length: 301 }, (_, k) => 5000 + k);
  route.properties.elevation_gain_ft = 300; route.properties.elevation_loss_ft = 0;
  assert.equal(appendReturn(trip), true);
  const ix = M.lineIndex(route);
  trip.features.push(
    point("OUT", { type: "camp", attach: attachAt(ix, 500) }),     // way out, before the edit
    point("TURN", { type: "camp", attach: attachAt(ix, 2600) }),   // way out, after the edit
    point("BACKMID", { type: "break", attach: attachAt(ix, 4500) }), // way back, inside the redrawn stretch (x = 1.5)
    point("BACK", { type: "camp", attach: attachAt(ix, 5500) }),   // way back, on a stretch that survives (x = 0.5)
  );
  M.syncLineTrip(trip);
  return { trip, route, backFromEnd: ix.total - 5500 }; // BACK's distance from the finish
}

test("appendReturn mirrors legs and the whole elevation profile", () => {
  const { route } = linkedOutAndBack();
  const rp = route.properties;
  assert.equal(rp.segments.length, 6);
  assert.deepEqual(rp.segments.slice(3).map((s) => s.mirror_of), [2, 1, 0]);
  assert.deepEqual(returnLink(rp.segments), { firstMirror: 3, linked: true });
  assertPalindrome(route);
  assert.equal(rp.elevation_profile.length, 601, "no downsampling");
  assert.deepEqual([rp.elevation_profile[0], rp.elevation_profile[300], rp.elevation_profile[600]], [5000, 5300, 5000]);
  assert.deepEqual([rp.elevation_gain_ft, rp.elevation_loss_ft], [300, 300]);
});

test("redraw with rejoin on the way out: the linked way back follows", () => {
  const { trip, route, backFromEnd } = linkedOutAndBack();
  const before = { out: coordOf(trip, "OUT"), turn: coordOf(trip, "TURN"), back: coordOf(trip, "BACK"), backmid: coordOf(trip, "BACKMID") };
  const oldIx = frozenIndex(route);
  // Cut at 1.2 km, swing 40 m north, rejoin at 1.8 km (both inside leg 1).
  const res = redrawLine(trip, { cutM: 1200, rejoinM: 1800, newLegs: drawnLegs([[1.2, 0], [1.5, 0.04], [1.8, 0]]) });
  assert.deepEqual([res.regenerated, res.returnNote, res.rejoined], [true, null, true]);
  const rp = route.properties;
  const link = returnLink(rp.segments);
  assert.equal(link.linked, true, "still a linked out-and-back");
  assert.equal(rp.segments.length, 2 * link.firstMirror);
  assert.equal(rp.return_same_way, true);
  assertPalindrome(route);
  assert.equal(rp.elevation_profile, undefined, "the old profile no longer describes the line");
  const ix = M.lineIndex(route);
  const half = ix.total / 2;
  // The old profile is reused everywhere but the drawn detour, on both passes.
  assert.equal(res.reuse.profile.length, 601);
  assertSpansMatch(res.reuse, oldIx, ix);
  const covered = res.reuse.spans.reduce((a, q) => a + (q.n1 - q.n0), 0);
  near(ix.total - covered, 2 * M.hav(pt(1.2, 0), pt(1.5, 0.04)) * 2, 15, "only the detour (out and back) is not covered");

  // Stops on stretches that survived keep their exact place and their pass.
  for (const [id, key] of [["OUT", "out"], ["TURN", "turn"], ["BACK", "back"]]) {
    assert.ok(M.hav(coordOf(trip, id), before[key]) < 1, `${id} did not move`);
  }
  assert.ok(stopM(trip, "OUT") < half && stopM(trip, "TURN") < half, "way-out stops stay on the way out");
  assert.ok(stopM(trip, "BACK") > half, "the way-back camp stays on the way back");
  near(stopM(trip, "BACK"), ix.total - backFromEnd, 2);
  // The break on the removed stretch of the way back re-attaches to the new way back.
  assert.equal(res.reattached, 1);
  assert.deepEqual(res.lost, []);
  assert.ok(stopM(trip, "BACKMID") > half, "re-attached on the way back, not the way out");
  assert.ok(M.hav(coordOf(trip, "BACKMID"), before.backmid) < 60);
  // Days still build: camps in walking order OUT, TURN, BACK.
  assert.deepEqual(M.syncLineTrip(trip).camps.map((c) => c.id), ["OUT", "TURN", "BACK"]);
});

test("redraw with rejoin: a stop too far from the new way back goes off route, never deleted", () => {
  const { trip } = linkedOutAndBack();
  const res = redrawLine(trip, { cutM: 1200, rejoinM: 1800, newLegs: drawnLegs([[1.2, 0], [1.5, 0.4], [1.8, 0]]) });
  assert.equal(res.regenerated, true);
  assert.deepEqual(res.lost.map((l) => [l.id, l.kind, l.label]), [["BACKMID", "break", "A break"]]);
  assert.ok(get(trip, "BACKMID"), "still in the trip");
  assert.equal(get(trip, "BACKMID").properties.attach, undefined);
  assert.deepEqual(M.buildPlan(trip).offRoute.map((o) => o.id), ["BACKMID"]);
});

test("redraw the way out without rejoining: the way back is rebuilt from the new way out", () => {
  const { trip, route, backFromEnd } = linkedOutAndBack();
  const before = { out: coordOf(trip, "OUT"), back: coordOf(trip, "BACK") };
  // Cut at 1.2 km and head 1 km north instead; double-click to end there.
  const res = redrawLine(trip, { cutM: 1200, newLegs: drawnLegs([[1.2, 0], [1.2, 1]]) });
  assert.deepEqual([res.regenerated, res.returnNote, res.rejoined], [true, null, false]);
  const ix = M.lineIndex(route);
  near(ix.total, 2 * (1200 + 1000), 30, "out to the new end and back");
  assert.equal(returnLink(route.properties.segments).linked, true);
  assertPalindrome(route);
  assert.ok(M.hav(coordOf(trip, "OUT"), before.out) < 1);
  assert.ok(M.hav(coordOf(trip, "BACK"), before.back) < 1, "the way-back camp is on the rebuilt way back");
  near(stopM(trip, "BACK"), ix.total - backFromEnd, 2);
  // TURN (x = 2.6) and BACKMID (x = 1.5) were on the abandoned trail.
  assert.deepEqual(res.lost.map((l) => l.id).sort(), ["BACKMID", "TURN"]);
  assert.equal(res.lost.find((l) => l.id === "TURN").label, "Camp 2");
});

test("a way back edited by hand is left alone, and the result says so", () => {
  const { trip, route } = linkedOutAndBack();
  // Redraw part of the way back by hand (cut and rejoin both on the return).
  const first = redrawLine(trip, { cutM: 4200, rejoinM: 4800, newLegs: drawnLegs([[1.8, 0], [1.5, -0.05], [1.2, 0]]) });
  assert.deepEqual([first.regenerated, first.returnNote], [false, null], "editing the return is not an outbound edit");
  let link = returnLink(route.properties.segments);
  assert.equal(link.linked, false, "the link is partly broken");
  assert.equal(route.properties.return_same_way, true, "untouched return legs are still mirrors");
  const ix1 = M.lineIndex(route);
  const turnM = ix1.legs[link.firstMirror].startM;
  const tailBefore = M.sliceM(ix1, turnM, ix1.total);

  // Now change the way out with a rejoin: the hand-made return stays.
  const snapshot = JSON.stringify(trip);
  const res = redrawLine(trip, { cutM: 400, rejoinM: 700, newLegs: drawnLegs([[0.4, 0], [0.55, 0.03], [0.7, 0]]) });
  assert.deepEqual([res.regenerated, res.returnNote], [false, "kept"]);
  const ix2 = M.lineIndex(route);
  link = returnLink(route.properties.segments);
  const tailAfter = M.sliceM(ix2, ix2.legs[link.firstMirror].startM, ix2.total);
  near(ix2.total - ix2.legs[link.firstMirror].startM, ix1.total - turnM, 1, "return length unchanged");
  assert.ok(M.hav(tailAfter[Math.floor(tailAfter.length / 2)], tailBefore[Math.floor(tailBefore.length / 2)]) < 1, "return geometry unchanged");
  assert.ok(route.properties.segments.some((s) => s.mirror_of === undefined && route.properties.segments.indexOf(s) > link.firstMirror), "no regenerated mirrors");

  // Without a rejoin everything after the cut goes, the hand-made return with it.
  const trip2 = JSON.parse(snapshot);
  const res2 = redrawLine(trip2, { cutM: 400, newLegs: drawnLegs([[0.4, 0], [0.4, 0.5]]) });
  assert.deepEqual([res2.regenerated, res2.returnNote], [false, "removed"]);
  assert.equal(trip2.features[0].properties.return_same_way, undefined);
  near(M.lineIndex(trip2.features[0]).total, 400 + 500, 15);
});

test("redraw on a one-way line: stops downstream keep leg + offset (indices shift)", () => {
  const route = makeLine([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const trip = makeTrip([route]);
  const ix = M.lineIndex(route);
  trip.features.push(point("A", { type: "camp", attach: attachAt(ix, 300) }), point("Z", { type: "camp", attach: attachAt(ix, 2500) }));
  const zOff = get(trip, "Z").properties.attach.offset_m;
  const res = redrawLine(trip, { cutM: 600, rejoinM: 900, newLegs: drawnLegs([[0.6, 0], [0.75, 0.05], [0.9, 0]]) });
  assert.deepEqual([res.regenerated, res.returnNote, res.reattached, res.lost.length], [false, null, 0, 0]);
  assert.equal(res.reuse, null, "no old profile, nothing to reuse");
  assert.deepEqual(get(trip, "A").properties.attach, { route_id: "R", leg: 0, offset_m: 300 });
  // Old leg 2 is now leg 5: [0..600] + 2 drawn + [900..1000] + leg 1 + leg 2.
  assert.deepEqual(get(trip, "Z").properties.attach, { route_id: "R", leg: 5, offset_m: zOff });
  assert.equal(route.properties.vertex_coords.length, route.properties.segments.length + 1, "anchors stay in step with legs");
});
