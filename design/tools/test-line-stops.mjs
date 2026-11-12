#!/usr/bin/env node
// Unit tests for the line + stops model: camp offsets stay within their leg.
//
//   node design/tools/test-line-stops.mjs
import assert from "node:assert/strict";
import { lineIndex, resolveAttach, locateM, convertTypedVertices, buildPlan } from "../../line-model.js";
import { redrawLine } from "../../line-edit.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  ", name); };

// A 3-leg line: A -> B -> C -> back through B's neighbourhood. Leg lengths are
// chosen so that rounding the first leg's length to 0.1 m goes UP.
function makeTrip() {
  const coords = [[-112, 40], [-112, 40.010502], [-111.99, 40.010502], [-111.99, 40.0001], [-112.0001, 40.0001], [-112.00001, 40.0104]];
  const route = {
    type: "Feature",
    properties: {
      type: "route", _id: "r1", vertex_types: ["route", "camp", "route", "route"],
      segments: [
        { mode: "trail", from_vertex: 0, to_vertex: 1, coord_range: [0, 1] },
        { mode: "trail", from_vertex: 1, to_vertex: 2, coord_range: [1, 2] },
        { mode: "trail", from_vertex: 2, to_vertex: 3, coord_range: [2, 5] },
      ],
    },
    geometry: { type: "LineString", coordinates: coords },
  };
  const camp = { type: "Feature", properties: { _id: "c1", type: "camp", point_type: "camp", name: "Camp", route_index: 0, route_vertex_index: 1 }, geometry: { type: "Point", coordinates: coords[1] } };
  return { type: "FeatureCollection", properties: { name: "t", schema_version: "1.1" }, features: [route, camp], days: [], unassigned: [] };
}
const r1 = (v) => Math.round(v * 10) / 10;
const legsOf = (t) => lineIndex(t.features.find((f) => f.properties.type === "route")).legs;

test("fixture: rounding leg 0's length to 0.1 m would round up", () => {
  const len = legsOf(makeTrip())[0].len;
  assert.ok(r1(len) > len, `len ${len} rounds to ${r1(len)}`);
});

test("convertTypedVertices never stores an offset past the leg length", () => {
  const t = makeTrip();
  assert.ok(convertTypedVertices(t));
  const a = t.features.find((f) => f.properties.type === "camp").properties.attach;
  const len = legsOf(t)[a.leg].len;
  assert.equal(a.leg, 0);
  assert.ok(a.offset_m <= len, `offset ${a.offset_m} > leg ${len}`);
  assert.ok(len - a.offset_m < 0.1);
});

test("locateM never rounds an offset past the leg length", () => {
  const t = makeTrip();
  const ix = lineIndex(t.features[0]);
  const m = ix.legs[1].endM - 1e-3; // near the end of leg 1
  const q = locateM(ix, m);
  assert.ok(q.offset_m <= ix.legs[q.leg].len);
});

const extend = (t) => {
  const ix = lineIndex(t.features[0]);
  const end = ix.coords.at(-1);
  return redrawLine(t, { cutM: ix.total, newLegs: [{ coords: [end, [end[0] + 0.01, end[1]]], mode: "trail" }] });
};

for (const over of [0.05, 0.1]) {
  test(`a camp saved ${over} m past its leg end stays on its leg through an extend`, () => {
    const t = makeTrip();
    convertTypedVertices(t);
    const camp = t.features.find((f) => f.properties.type === "camp");
    const len = legsOf(t)[0].len;
    camp.properties.attach = { route_id: "r1", leg: 0, offset_m: r1(len) + over };
    const res = extend(t);
    assert.ok(res);
    assert.equal(res.reattached, 0);
    const a = camp.properties.attach;
    assert.equal(a.leg, 0);
    assert.ok(a.offset_m <= legsOf(t)[0].len, `offset ${a.offset_m} > leg ${legsOf(t)[0].len}`);
    assert.ok(Math.abs(a.offset_m - len) < 0.2);
  });
}

test("a converted camp survives an extend without moving", () => {
  const t = makeTrip();
  convertTypedVertices(t);
  const camp = t.features.find((f) => f.properties.type === "camp");
  const before = JSON.stringify(camp.properties.attach);
  extend(t);
  assert.equal(camp.properties.attach.leg, 0);
  assert.ok(Math.abs(camp.properties.attach.offset_m - JSON.parse(before).offset_m) < 0.2);
});

console.log(`\n${n} passed`);
