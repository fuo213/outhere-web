// Shared helpers for the plain-node tests (no dependencies). See run.mjs.
import assert from "node:assert/strict";

export { assert };

let failed = 0, passed = 0;
const pending = [];

/** Register a test. Sync or async; failures are collected, not thrown. */
export function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log(`ok    ${name}`); },
    (err) => { failed++; console.log(`FAIL  ${name}\n      ${String(err?.stack || err).split("\n").slice(0, 6).join("\n      ")}`); },
  ));
}

export async function done() {
  await Promise.all(pending);
  return { passed, failed };
}

// A flat test world: x km east, y km north of a point in Zion.
const LAT0 = 37.25, LON0 = -113;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110574;
export const pt = (xKm, yKm = 0) => [LON0 + (xKm * 1000) / KX, LAT0 + (yKm * 1000) / KY];

const dense = (a, b, stepKm = 0.05) => {
  const d = Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY) / 1000;
  const n = Math.max(1, Math.round(d / stepKm));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
};

/** A route feature with one trail leg between consecutive waypoints ([xKm, yKm]). */
export function makeLine(waypoints, id = "R") {
  const coords = [], segments = [];
  for (let k = 0; k + 1 < waypoints.length; k++) {
    const pts = dense(pt(...waypoints[k]), pt(...waypoints[k + 1]));
    const s = coords.length ? coords.length - 1 : 0;
    if (!coords.length) coords.push(pts[0]);
    for (let i = 1; i < pts.length; i++) coords.push(pts[i]);
    segments.push({ mode: "trail", from_vertex: k, to_vertex: k + 1, coord_range: [s, coords.length - 1] });
  }
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { type: "route", _id: id, name: "", segments, vertex_coords: waypoints.map((w) => pt(...w)), vertex_types: waypoints.map(() => "route") },
  };
}

export function makeTrip(features, { version = "1.2", start = "2026-09-12" } = {}) {
  return {
    type: "FeatureCollection",
    properties: { trip_id: "T", name: "test", schema_version: version, dates: start ? { start, end: start } : null },
    days: [], unassigned: [], features,
  };
}

export const point = (id, props, coord = [0, 0]) => ({ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: { _id: id, ...props } });

/** Straight drawn legs through [xKm, yKm] waypoints, shaped like planning.js hands them to redrawLine. */
export const drawnLegs = (waypoints) => waypoints.slice(1).map((w, k) => ({ coords: dense(pt(...waypoints[k]), pt(...w)), mode: "manual" }));

export const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || "value"}: ${a} not within ${tol} of ${b}`);
