// Rebuilds design/fixtures/demo-maze-chocolate-drops.trip.geojson.
// Needs: routing.js from feat/graph-routing copied here as routing.mjs (its
// flatbush import pointed at ./flatbush-shim.mjs), the live graph saved as
// graph.json (catalog.json -> maze-district routing_graph), and the USGS 3DEP
// 1/3" tiles from outhere/utah_maps/downloads/dem (or ELEV=open-meteo).
//   node build-demo-trip.mjs out.geojson   (reads maze.plan.json, or $PLAN)
// Builds the Maze demo trip the way planning.js (feat/graph-routing) does:
// per-click snap (200 m = SNAP_MAX_M), A* legs, shift-click = manual straight leg,
// dayhike vertices = spur legs from the last main vertex, Open-Meteo elevation.
import fs from 'fs'; import { TrailGraph, lineLength, haversine } from './routing.mjs';
const doc = JSON.parse(fs.readFileSync('graph.json'));
const g = new TrailGraph(doc, { version: '1a03b49c', osm_timestamp: '2026-11-07T21:21:36Z' });
const MI = 1609.344;
const round6 = (c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];
const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];
const routing = { engine: 'booot-graph', graph: 'utah/maze-district', graph_version: '1a03b49c', osm_timestamp: g.osmTimestamp };

function sampleByDistance(coords, maxPoints = 100, minSpacingM = 25) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(...coords[i - 1], ...coords[i]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.min(maxPoints, Math.floor(total / minSpacingM) + 1));
  const out = []; let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j], t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / span)) : 0;
    out.push([coords[j][0] + t * (coords[j + 1][0] - coords[j][0]), coords[j][1] + t * (coords[j + 1][1] - coords[j][1])]);
  }
  return out;
}
// Elevation: same sampling as planning.js (sampleByDistance, 100 pts), but read
// from USGS 3DEP 1/3" (10 m) tiles the pipeline already downloaded instead of
// Open-Meteo's 90 m DEM, which turns Maze canyon walls into ~2x phantom gain.
import { execSync } from 'child_process';
const DEM = '/Users/vincent/development/booot/outhere/utah_maps/downloads/dem';
function demFt(pts) {
  return pts.map(([x, y]) => {
    const tile = `${DEM}/USGS_13_n${Math.ceil(y)}w${String(Math.ceil(-x)).padStart(3, '0')}.tif`;
    const m = +execSync(`gdallocationinfo -valonly -wgs84 ${tile} ${x} ${y}`).toString().trim();
    return Math.round(m * 3.28084);
  });
}
const ELEV_SRC = process.env.ELEV || 'dem';
async function elevation(coords) {
  const s = sampleByDistance(coords, 100);
  let ft;
  if (ELEV_SRC === 'open-meteo') {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${s.map(c => c[1].toFixed(6)).join(',')}&longitude=${s.map(c => c[0].toFixed(6)).join(',')}`;
    ft = (await (await fetch(url)).json()).elevation.map(m => Math.round(m * 3.28084));
  } else ft = demFt(s);
  let gain = 0, loss = 0;
  for (let i = 1; i < ft.length; i++) { const d = ft[i] - ft[i - 1]; if (d > 0) gain += d; else loss -= d; }
  return { elevation_profile: ft, elevation_gain_ft: Math.round(gain), elevation_loss_ft: Math.round(loss) };
}

let uid = 0;
const id = (p) => `${p}${String(++uid).padStart(12, '0')}`.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
const fid = () => { const n = String(++uid).padStart(12, '0'); return `b0070000-0000-4000-8000-${n}`; };

// clicks: [lon, lat, type, {shift, name}]
async function drawRoute(clicks) {
  const verts = clicks.map(([lon, lat, type, o = {}]) => {
    const snap = o.shift ? null : g.snap(lon, lat, 200);
    return { coord: snap ? [snap.lon, snap.lat] : [lon, lat], snapped: !!snap, type, snap, shift: !!o.shift };
  });
  const legs = [];
  const lastMain = (i) => { for (let k = i; k >= 0; k--) if (verts[k].type !== 'dayhike') return k; return 0; };
  for (let i = 1; i < verts.length; i++) {
    const from = lastMain(i - 1), A = verts[from], B = verts[i];
    const kind = B.type === 'dayhike' ? 'spur' : 'main';
    let leg;
    if (B.shift || !A.snap || !B.snap) { const c = [A.coord, B.coord]; leg = { mode: 'manual', coords: c, length_m: lineLength(c), wayIds: [] }; }
    else {
      const r = g.route(A.snap, B.snap);
      if (!r) { const c = [A.coord, B.coord]; leg = { mode: 'straight', reason: 'no_path', coords: c, length_m: lineLength(c), wayIds: [] }; }
      else leg = { mode: 'trail', coords: r.coords, length_m: r.length_m, wayIds: r.wayIds };
    }
    Object.assign(leg, { from, to: i, kind });
    legs.push(leg);
    console.error(`  leg ${from}->${i} ${kind} ${leg.mode} ${(leg.length_m / MI).toFixed(2)} mi`, leg.wayIds.map(w => g.wayName[g.wayOsm.indexOf(w)] || w).join(' > '));
  }
  const seg = (leg, range) => { const s = { mode: leg.mode, from_vertex: leg.from, to_vertex: leg.to, coord_range: range, length_m: Math.round(leg.length_m * 10) / 10 }; if (leg.mode === 'straight') s.reason = leg.reason; if (leg.mode === 'trail') s.osm_way_ids = leg.wayIds; return s; };
  const main = legs.filter(l => l.kind === 'main');
  const geom = [], segments = [];
  for (const leg of main) {
    const pts = leg.coords.map(round6);
    let start = geom.length - 1;
    if (start < 0 || !samePos(geom[start], pts[0])) { start = geom.length; geom.push(pts[0]); }
    for (let k = 1; k < pts.length; k++) geom.push(pts[k]);
    segments.push(seg(leg, [start, geom.length - 1]));
  }
  const spurs = legs.filter(l => l.kind === 'spur').map(leg => { const c = leg.coords.map(round6); return { coords: c, segments: [seg({ ...leg, from: 0, to: 1 }, [0, c.length - 1])] }; });
  const props = {
    type: 'route', name: '', planned: true, notes: '',
    vertex_types: verts.map(v => v.type), vertex_snapped: verts.map(v => v.snapped), vertex_coords: verts.map(v => round6(v.coord)),
    main_route_distance_mi: Math.round(lineLength(geom) / MI * 100) / 100,
    dayhike_distance_mi: Math.round(spurs.reduce((s, sp) => s + 2 * lineLength(sp.coords) / MI, 0) * 100) / 100,
    ...(await elevation(geom)),
    segments, routing,
  };
  return { geom, props, spurs, verts };
}

const P = JSON.parse(fs.readFileSync(process.env.PLAN || 'maze.plan.json'));
const start = P.start;
const dateOf = (i) => { const d = new Date(start + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const features = [], days = [];
for (const [di, day] of P.days.entries()) {
  console.error(`Day ${di + 1}`);
  const r = await drawRoute(day.clicks);
  const routeId = fid();
  const routeIdx = features.length;
  features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.geom }, properties: { ...r.props, _id: routeId, name: day.route_name } });
  const ids = [routeId];
  for (const sp of r.spurs) { const sid = fid(); features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: sp.coords }, properties: { type: 'dayhike_spur', _id: sid, route_index: routeIdx, name: day.spur_name || '', segments: sp.segments, routing } }); ids.push(sid); }
  r.verts.forEach((v, i) => {
    if (v.type === 'route') return;
    const meta = day.points?.[i] || {};
    const pid = fid();
    const pp = { type: v.type, point_type: v.type, _id: pid, route_index: routeIdx, route_vertex_index: i, date: dateOf(di), name: meta.name || '', notes: meta.notes || '' };
    if (v.type === 'camp') { pp.water_nearby = !!meta.water_nearby; pp.water_notes = meta.water_notes || ''; }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: round6(v.coord) }, properties: pp });
    ids.push(pid);
  });
  for (const w of day.waypoints || []) {
    const wid = fid();
    const wc = w.on ? round6(g._pointAt(w.on[0], g.eLen[w.on[0]] * w.on[1])) : w.coord;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: wc }, properties: { type: 'waypoint', subtype: w.subtype, _id: wid, name: w.name, notes: w.notes, ...(w.elevation ? { elevation: w.elevation } : {}) } });
    ids.push(wid);
  }
  // Itinerary order: route first, then stops in walking order (spur after its branch point).
  const along = (c) => { let best = 0, bd = Infinity, acc = 0; for (let k = 1; k < r.geom.length; k++) { const a = r.geom[k - 1], b = r.geom[k]; const L = haversine(...a, ...b); for (const t of [0, 0.25, 0.5, 0.75, 1]) { const d = haversine(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), ...c); if (d < bd) { bd = d; best = acc + t * L; } } acc += L; } return best; };
  const rank = (fidv) => { const f = features.find(x => x.properties._id === fidv); const t = f.properties.type; if (t === 'route') return -1; if (t === 'dayhike_spur') return along(f.geometry.coordinates[0]) + 0.2; if (t === 'dayhike') return along(f.geometry.coordinates) + 0.1; if (t === 'camp') return along(f.geometry.coordinates) + 0.05; return along(f.geometry.coordinates); };
  const ranked = ids.map(i => [i, rank(i)]); ranked.sort((a, b) => a[1] - b[1]); ids.splice(0, ids.length, ...ranked.map(x => x[0]));
  days.push({ id: `d0070000-0000-4000-8000-00000000000${di + 1}`, date: dateOf(di), title: undefined, features: ids, notes: day.notes });
  console.error(`  => ${r.props.main_route_distance_mi} mi +${r.props.elevation_gain_ft} -${r.props.elevation_loss_ft} spur ${r.props.dayhike_distance_mi}`);
}
for (const d of days) delete d.title;
const trip = {
  type: 'FeatureCollection',
  properties: { trip_id: 'b0070000-0000-4000-8000-0000000000aa', name: P.name, location: P.location, created: '2026-11-08T08:00:00.000Z', sharing: 'private', region: 'maze-district', readme: P.readme, notes: '', schema_version: '1.1', _schema_version: 4, dates: { start, end: dateOf(P.days.length - 1) } },
  days, unassigned: [], features,
};
fs.writeFileSync(process.argv[2], JSON.stringify(trip, null, 1) + '\n');
