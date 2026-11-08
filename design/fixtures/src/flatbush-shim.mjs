// Linear-scan stand-in for flatbush (same API subset routing.js uses).
export default class Flatbush {
  constructor(n) { this.b = []; }
  add(a, b, c, d) { this.b.push([a, b, c, d]); }
  finish() {}
  search(w, s, e, n, filter) { const out = []; this.b.forEach((q, i) => { if (q[2] >= w && q[0] <= e && q[3] >= s && q[1] <= n && (!filter || filter(i))) out.push(i); }); return out; }
  neighbors(x, y, k = 1, maxD = Infinity, filter) {
    let best = -1, bd = Infinity;
    this.b.forEach((q, i) => { if (filter && !filter(i)) return; const dx = Math.max(q[0] - x, 0, x - q[2]), dy = Math.max(q[1] - y, 0, y - q[3]); const d = Math.hypot(dx, dy); if (d < bd && d <= maxD) { bd = d; best = i; } });
    return best < 0 ? [] : [best];
  }
}
