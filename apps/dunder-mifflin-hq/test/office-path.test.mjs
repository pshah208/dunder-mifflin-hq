import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createGrid, simDepth, WALKABLE } from "../public/office-path.js";
import { LOUNGE_SPOTS } from "../public/office-lounge.js";
import { HUDDLE_SPOTS } from "../public/office-social.js";

// Evaluate the pure layout part of office.js (helpers, buildScene, stations) without a DOM.
async function loadLayout() {
  const src = await readFile(path.resolve("public", "office.js"), "utf8");
  const body = src.slice(src.indexOf("// ---------- Isometric helpers"), src.indexOf("// ---------- Sims"));
  const esc = s => String(s ?? "");
  return new Function("esc", `${body}; buildScene(); return { items, HOME, SEATS, HUDDLE, CONF_SEATS, CONF_HEAD, DESKS, STUDY_SPOTS, STUDY_HOST, BASKETBALL };`)(esc);
}

test("office-path: A* walks around an obstacle and never cuts through it", () => {
  const wall = { x0: 2, y0: 0, x1: 2.5, y1: 4 };
  const g = createGrid([wall], { walkable: [{ x0: 0, y0: 0, x1: 5, y1: 5 }], size: { w: 5, h: 5 } });
  const pts = g.findPath([1, 1], [4, 1]);
  assert.deepEqual(pts.at(-1), [4, 1]);
  let cur = [1, 1];
  for (const p of pts) { assert.ok(g.lineClear(cur[0], cur[1], p[0], p[1]), `segment ${cur} -> ${p}`); cur = p; }
  assert.ok(pts.some(([, y]) => y > 4), "detours below the wall");
});

test("office-path: a blocked target ends on the nearest free tile", () => {
  const g = createGrid([{ x0: 1, y0: 1, x1: 2, y1: 2 }], { walkable: [{ x0: 0, y0: 0, x1: 4, y1: 4 }], size: { w: 4, h: 4 } });
  const end = g.findPath([0.2, 0.2], [1.5, 1.5]).at(-1);
  assert.ok(g.freeAt(...end));
  assert.ok(Math.hypot(end[0] - 1.5, end[1] - 1.5) < 0.9);
});

test("office-path: sims in front of a long box draw after it, sims behind draw before it", () => {
  const board = { x0: 17.8, y0: 2.1, x1: 20.2, y1: 2.22, depth: 17.8 + 1.2 + 2.16 };
  assert.ok(simDepth(17.9, 2.8, [board]) > board.depth, "in front of the left end");
  assert.ok(simDepth(20.0, 1.7, [board]) < board.depth, "behind the right end");
  assert.equal(simDepth(5, 5, [board]), 10, "unrelated sims keep x+y");
});

test("office layout: furniture never overlaps and every station is free and reachable", async () => {
  const { items, HOME, SEATS, CONF_SEATS, CONF_HEAD, STUDY_SPOTS, STUDY_HOST } = await loadLayout();
  const rects = items.filter(it => it.rect).map(it => ({ ...it.rect, depth: it.depth }));
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const r = rects[a], s = rects[b];
    const overlap = r.x0 < s.x1 - 1e-6 && r.x1 > s.x0 + 1e-6 && r.y0 < s.y1 - 1e-6 && r.y1 > s.y0 + 1e-6;
    assert.ok(!overlap, `furniture overlaps: ${JSON.stringify(r)} vs ${JSON.stringify(s)}`);
  }
  const g = createGrid(rects);
  const spots = [
    ...Object.entries(HOME).map(([id, [x, y]]) => [`home ${id}`, x, y]),
    ...Object.entries(SEATS).flatMap(([room, list]) => list.map(([x, y], i) => [`seat ${room}#${i}`, x, y])),
    ...LOUNGE_SPOTS.map(s => [`lounge ${s.id}`, s.x, s.y]),
    ...HUDDLE_SPOTS.map(([x, y], i) => [`huddle #${i}`, x, y]),
    ...CONF_SEATS.map(([x, y], i) => [`conference seat #${i}`, x, y]),
    ["conference head", ...CONF_HEAD],
    ...STUDY_SPOTS.map(([x, y], i) => [`study spot #${i}`, x, y]),
    ["study host", ...STUDY_HOST],
  ];
  const start = HOME["regional-manager"];
  for (const [name, x, y] of spots) {
    assert.ok(WALKABLE.some(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1), `${name} is off the floor`);
    assert.ok(g.freeAt(x, y), `${name} stands inside furniture`);
    const pts = g.findPath([start[0], start[1]], [x, y]);
    assert.deepEqual(pts.at(-1), [x, y], `${name} unreachable from Michael's office`);
    let cur = [start[0], start[1]];
    for (const p of pts) { assert.ok(g.lineClear(cur[0], cur[1], p[0], p[1]), `${name}: path cuts through furniture`); cur = p; }
  }
});

test("office layout: room signs sit in their rooms and Michael's office is clear of the annex", async () => {
  const src = await readFile(path.resolve("public", "office.js"), "utf8");
  assert.ok(!/signText\(0, [\d.]+, \d+, "Break Room"/.test(src), "Break Room sign is not on the bullpen back wall");
  assert.ok(!/signText\(0, [\d.]+, \d+, "Café Disco"/.test(src), "Café Disco sign is not on the bullpen back wall");
  assert.match(src, /floorText\([\d.]+, [\d.]+, "BREAK ROOM"/);
  assert.match(src, /floorText\([\d.]+, [\d.]+, "CAFÉ DISCO"/);
  const { HOME } = await loadLayout();
  const [mx, my] = HOME["regional-manager"];
  assert.ok(mx < 3.0 && my < 3.4, "Michael's home is inside his office");
});

test("office CSS animates phone calls, dancing and the disco ball, and keeps one blink keyframe", async () => {
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.match(css, /\.sim\.active\.pose-phone \.phone \{ display: block; \}/);
  assert.match(css, /\.sim\.pose-dance \.sim-body \{ animation: dance/);
  assert.match(css, /\.office-page \.disco \{ animation: discoglow/);
  assert.equal((css.match(/@keyframes blink\b/g) || []).length, 1, "office LED must not override the chat cursor blink");
  assert.ok(!/pose-film/.test(css));
});

test("office layout: every character has personal props on their own desk; conference room seats a big meeting", async () => {
  const { DESKS, CONF_SEATS, CONF_HEAD, items } = await loadLayout();
  const team = JSON.parse(await readFile(path.resolve("personas.json"), "utf8"));
  assert.deepEqual(DESKS.map(d => d.who).sort(), team.map(m => m.id).sort(), "one decorated desk per agent");
  for (const d of DESKS) {
    assert.ok(d.props.length >= 2, `${d.who} has at least two personal items`);
    const w = d.w ?? 1.35, dd = d.d ?? .75;
    for (const [, ox, oy] of d.props) assert.ok(ox >= 0 && ox <= w && oy >= 0 && oy <= dd, `${d.who}: prop sits on the desk`);
  }
  assert.equal(items.filter(it => it.svg.includes('class="desk-decor"')).length, team.length);
  assert.ok(CONF_SEATS.length >= team.length - 1, "everyone but Michael gets a conference-room spot");
  for (const [x, y] of [...CONF_SEATS, CONF_HEAD]) assert.ok(x > 3.2 && x < 6.3 && y > 0.2 && y < 3.45, "seat is in the conference room");
});

test("Oscar and Andy sit in the front office; Toby and Kelly sit in the back office with their own props", async () => {
  const { HOME, DESKS, items } = await loadLayout();
  for (const [id, front, prop] of [
    ["cloud-ai-architect", true, "books"], ["presentation-designer", true, "banjo"],
    ["compliance-officer", false, "tissues"], ["communications", false, "magazine"],
  ]) {
    const d = DESKS.find(d => d.who === id);
    const [x, y] = HOME[id];
    assert.equal(d.x < 15.3, front, `${id}: desk in the intended room`);
    assert.equal(x < 15.3, front, `${id}: character in the intended room`);
    assert.ok(x >= d.x && x <= d.x + 1.35 && y < d.y && d.y - y <= .35, `${id}: stands at their own desk`);
    assert.ok(d.props.some(([kind]) => kind === prop), `${id}: personal items moved too`);
    assert.ok(items.some(it => it.rect?.x0 === d.x && it.rect?.y0 === d.y), `${id}: physical desk matches decorations`);
  }
});

test("warehouse basketball includes a net, marked court and motion-safe shooting animation", async () => {
  const { items, BASKETBALL, SEATS } = await loadLayout();
  const shooter = LOUNGE_SPOTS.find(s => s.id === "warehouse-free-throw");
  assert.deepEqual([shooter.x, shooter.y], [BASKETBALL.x, BASKETBALL.y], "animated shot starts at the reserved spot");
  assert.ok(BASKETBALL.rimX > 20.2 && BASKETBALL.rimX < 23.1 && BASKETBALL.rimY < 3.65, "hoop sits between the design board and boxes, north of the forklift");
  for (const [x, y] of SEATS.engineering) {
    assert.ok(Math.hypot(x - shooter.x, y - shooter.y) > 1, "shooting spot stays clear of design-board huddles");
  }
  assert.ok(items.some(it => it.svg.includes('class="basketball-hoop"') && it.svg.includes("woven net")));
  assert.ok(items.some(it => it.svg.includes('class="basketball-court"') && it.svg.includes("SCRANTON HOOPS")));
  assert.ok(items.some(it => it.svg.includes('class="basketball-shot"')));
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.match(css, /\.office-page \.basketball-shot\.on/);
  assert.match(css, /\.office-page\.tab-hidden \.basketball-shot/);
  assert.match(css, /prefers-reduced-motion: reduce.*animation: none !important/);
});
