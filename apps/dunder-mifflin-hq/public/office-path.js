// Dunder Mifflin HQ Office: walkable grid, A* pathing and sim depth sorting (DOM-free, unit-tested in Node).
// Coordinates are scene tiles, the same space as HOME in office.js.

export const GRID = 0.25;
export const SCENE = Object.freeze({ w: 25.2, h: 16.3 });
export const WALKABLE = Object.freeze([
  Object.freeze({ x0: 0.1, y0: 0.1, x1: 14.75, y1: 11.3 }),  // Scranton office floor
  Object.freeze({ x0: 14.7, y0: 5.25, x1: 15.75, y1: 6.05 }), // hallway into the warehouse
  Object.freeze({ x0: 15.7, y0: 0.1, x1: 25.1, y1: 11.3 }),  // Infinity warehouse lab
  Object.freeze({ x0: 9.85, y0: 11.25, x1: 10.75, y1: 11.8 }), // Break Room door
  Object.freeze({ x0: 6.4, y0: 11.75, x1: 14.4, y1: 16.0 }),   // Break Room
]);
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inRect = (x, y, r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Build a walk grid from furniture footprints ({x0,y0,x1,y1}). Returns helpers bound to that grid. */
export function createGrid(obstacles, { walkable = WALKABLE, size = SCENE, cell = GRID } = {}) {
  const cols = Math.ceil(size.w / cell), rows = Math.ceil(size.h / cell);
  const blocked = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = (i + .5) * cell, cy = (j + .5) * cell;
    let b = !walkable.some(r => inRect(cx, cy, r));
    if (!b) {
      const x0 = i * cell + .03, x1 = (i + 1) * cell - .03, y0 = j * cell + .03, y1 = (j + 1) * cell - .03;
      b = obstacles.some(r => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
    }
    blocked[j * cols + i] = b ? 1 : 0;
  }
  const cellOf = (x, y) => [Math.max(0, Math.min(cols - 1, Math.floor(x / cell))), Math.max(0, Math.min(rows - 1, Math.floor(y / cell)))];
  const isFree = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && !blocked[j * cols + i];
  const freeAt = (x, y) => isFree(...cellOf(x, y));
  const center = (i, j) => [(i + .5) * cell, (j + .5) * cell];
  function nearestFree(i, j) {
    if (isFree(i, j)) return [i, j];
    for (let r = 1; r < 16; r++) {
      let best = null, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !isFree(i + di, j + dj)) continue;
        const d = di * di + dj * dj; if (d < bd) { bd = d; best = [i + di, j + dj]; }
      }
      if (best) return best;
    }
    return null;
  }
  function lineClear(ax, ay, bx, by) {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.08);
    for (let k = 1; k < n; k++) { const t = k / n; if (!freeAt(ax + (bx - ax) * t, ay + (by - ay) * t)) return false; }
    return true;
  }
  /** Waypoints from `from` to `to` (excluding the start). A blocked target ends on the closest free tile. */
  function findPath(from, to) {
    const s = nearestFree(...cellOf(...from)), g = nearestFree(...cellOf(...to));
    if (!s || !g) return [[to[0], to[1]]];
    const goal = freeAt(...to) ? [to[0], to[1]] : center(...g);
    const key = (i, j) => j * cols + i, gk = key(...g), n = cols * rows;
    const gScore = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    const heap = [];
    const push = (f, k) => {
      heap.push([f, k]);
      for (let c = heap.length - 1; c;) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
    };
    const pop = () => {
      const top = heap[0], end = heap.pop();
      if (heap.length) {
        heap[0] = end;
        for (let c = 0; ;) {
          const l = 2 * c + 1, r = l + 1; let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
        }
      }
      return top;
    };
    const h = (i, j) => Math.hypot(i - g[0], j - g[1]);
    gScore[key(...s)] = 0; push(h(...s), key(...s));
    while (heap.length) {
      const [, k] = pop(); if (closed[k]) continue; closed[k] = 1;
      if (k === gk) break;
      const i = k % cols, j = (k - i) / cols;
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj; if (!isFree(ni, nj)) continue;
        if (di && dj && (!isFree(i + di, j) || !isFree(i, j + dj))) continue; // no corner cutting
        const nk = key(ni, nj), ng = gScore[k] + (di && dj ? Math.SQRT2 : 1);
        if (ng < gScore[nk]) { gScore[nk] = ng; came[nk] = k; push(ng + h(ni, nj), nk); }
      }
    }
    if (!closed[gk]) return [goal];
    const cells = [];
    for (let k = gk; k !== -1; k = came[k]) cells.unshift(center(k % cols, Math.floor(k / cols)));
    cells[cells.length - 1] = goal;
    // String-pull: keep only the waypoints needed to stay clear of furniture.
    const out = []; let cur = [from[0], from[1]], idx = 0;
    while (idx < cells.length) {
      let far = idx;
      for (let k = cells.length - 1; k > idx; k--) if (lineClear(cur[0], cur[1], cells[k][0], cells[k][1])) { far = k; break; }
      out.push(cells[far]); cur = cells[far]; idx = far + 1;
    }
    return out;
  }
  return { cols, rows, isFree, freeAt, findPath, lineClear };
}

/**
 * Painter's-algorithm depth for a moving sim. Plain x+y mis-orders sims around long furniture (whiteboard,
 * conference table), so clamp it between the boxes ({x0,y0,x1,y1,depth}) the sim is visibly in front of and behind.
 */
const SIM_HALF_WIDTH = 0.6; // a sim is ~36px wide; screen x is (x - y) * 32px
export function simDepth(x, y, boxes) {
  let lo = -Infinity, hi = Infinity;
  const sx = x - y;
  for (const o of boxes) {
    if (sx <= o.x0 - o.y1 - SIM_HALF_WIDTH || sx >= o.x1 - o.y0 + SIM_HALF_WIDTH) continue; // no horizontal overlap on screen
    if (x >= o.x1 || y >= o.y1) lo = Math.max(lo, o.depth);
    else if (x <= o.x0 || y <= o.y0) hi = Math.min(hi, o.depth);
  }
  const d = x + y;
  if (d > lo && d < hi) return d;
  if (lo === -Infinity) return hi - 0.001;
  if (hi === Infinity || hi <= lo) return lo + 0.001;
  return (lo + hi) / 2;
}
