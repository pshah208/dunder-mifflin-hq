import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Lounge, Banter, LOUNGE_SPOTS, LOUNGE_BOUNDS, PATH_BAND, SIT_POSES, KINDS, RELATIONSHIPS, affinity, COURT_BANTER, COURT_REPLIES } from "../public/office-lounge.js";

const mulberry32 = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ids = n => Array.from({ length: n }, (_, i) => `a${i}`);
const crowd = (list, over = {}) => list.map(id => ({ id, working: false, walking: false, ...over }));
const eager = (o = {}) => new Lounge({ rng: mulberry32(7), startChance: 1, initialDelayMs: [0, 0], minIdleMs: 0, cooldownMs: [5000, 5000], ...o });
function simulate(lounge, agents, { steps = 300, stepMs = 2500, onTick } = {}) {
  let now = 0; const log = [];
  for (let i = 0; i < steps; i++) { now += stepMs; const cmds = lounge.tick(now, agents); log.push(...cmds.map(c => ({ ...c, now }))); onTick?.(now, cmds); }
  return log;
}

test("Dunder break layout: finite Break Room, Café Disco and water cooler spots stay off the path", () => {
  assert.ok(LOUNGE_SPOTS.some(s => s.zone === "break" && s.kind === "counter"));
  assert.ok(LOUNGE_SPOTS.some(s => s.zone === "cafe-disco"));
  assert.ok(LOUNGE_SPOTS.some(s => s.id === "water-cooler"));
  for (const s of LOUNGE_SPOTS) {
    assert.ok(s.x >= LOUNGE_BOUNDS.x0 && s.x <= LOUNGE_BOUNDS.x1 && s.y >= LOUNGE_BOUNDS.y0 && s.y <= LOUNGE_BOUNDS.y1, s.id);
    assert.ok(s.y < PATH_BAND.y0 || s.y > PATH_BAND.y1, `${s.id} blocks the warehouse walkway`);
  }
  assert.equal(new Set(LOUNGE_SPOTS.map(s => s.id)).size, LOUNGE_SPOTS.length);
  for (const k of Object.values(KINDS)) for (const st of k.stages) if (SIT_POSES.has(st.pose)) assert.ok(!st.need.includes("counter"));
});

test("scheduler remains bounded, deterministic and preempted by real work", () => {
  const run = seed => simulate(new Lounge({ rng: mulberry32(seed) }), crowd(ids(15)), { steps: 250 }).map(c => `${c.now}:${c.type}:${c.id}:${c.spot?.id || c.reason}`);
  assert.deepEqual(run(5), run(5));
  assert.notDeepEqual(run(5), run(6));
  const l = eager({ maxOnBreak: 4 });
  const agents = crowd(ids(15)); let peak = 0;
  const log = simulate(l, agents, { steps: 700, onTick: () => {
    peak = Math.max(peak, l.count);
    assert.ok(l.count <= 4);
    assert.ok(l.occupancy.size <= LOUNGE_SPOTS.length);
    for (const owner of l.occupancy.values()) assert.ok(l.onBreak(owner));
  }});
  assert.equal(peak, 4);
  const victim = [...new Set(log.filter(c => c.type === "go").map(c => c.id))].find(id => l.onBreak(id));
  assert.ok(victim && l.onBreak(victim));
  const held = [...l.occupancy].filter(([, o]) => o === victim).map(([k]) => k);
  assert.equal(l.preempt(victim, 999), true);
  assert.ok(held.every(k => !l.occupancy.has(k)));
});

test("relationship model nudges companions and ambient replies without becoming work", () => {
  assert.ok(affinity("account-strategist", "office-administrator") > affinity("regional-manager", "compliance-officer"));
  assert.ok(RELATIONSHIPS["account-strategist|office-administrator"] > 0);
  const l = eager({ maxOnBreak: 4, rng: () => 0.01 });
  const agents = crowd(["account-strategist", "office-administrator", "compliance-officer", "regional-manager"]);
  const cmds = l.tick(1000, agents);
  assert.ok(cmds.filter(c => c.type === "go").length >= 1);
  const b = new Banter({ lounge: l, rng: mulberry32(2), gapMs: [0, 0], agentCooldownMs: 0, pairBias: 1 });
  const lines = [];
  for (let t = 2000; t < 20000; t += 2500) lines.push(...b.tick(t, agents));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(l.onBreak(line.id), "banter only comes from lounge residents");
});

test("office.js and CSS keep breaks decorative and Dunder-themed", async () => {
  const [js, css, html] = await Promise.all(["office.js", "styles.css", "office.html"].map(f => readFile(path.resolve("public", f), "utf8")));
  assert.match(js, /from "\.\/office-lounge\.js"/);
  assert.match(js, /if \(s\.active\) lounge\.preempt\(id/);
  const applyLounge = js.slice(js.indexOf("function applyLounge"), js.indexOf("setInterval(() => {\n  if (document.hidden) return;", js.indexOf("function applyLounge")));
  assert.ok(!/\.active\s*=/.test(applyLounge), "a break never sets working active");
  assert.match(html, /dm-token/);
  assert.match(html, /Dunder Mifflin <span>HQ<\/span>/);
  assert.match(html, /NBC's <i>The Office<\/i>/);
  assert.match(css, /\.office-page \.sim \.mug/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("Break Room is its own room with kitchen, vending, tables, couch and ping-pong spots", async () => {
  const breakSpots = LOUNGE_SPOTS.filter(s => s.zone === "break");
  assert.ok(breakSpots.length >= 12, "plenty of places to hang out");
  for (const s of breakSpots) assert.ok(s.x > 6.3 && s.x < 14.5 && s.y > 11.65 && s.y < 16.1, `${s.id} is inside the Break Room`);
  for (const id of ["break-fridge", "break-micro", "break-coffee", "break-vend-snacks", "break-vend-drinks", "break-couch-1", "break-beanbag", "break-pingpong-w", "break-pingpong-e"])
    assert.ok(breakSpots.some(s => s.id === id), id);
  const js = await readFile(path.resolve("public", "office.js"), "utf8");
  assert.match(js, /function buildBreakRoom\(\)/);
  assert.match(js, /buildBreakRoom\(\);\n\}/);
  for (const label of ["SNACKS", "DRINKS", "BREAK ROOM"]) assert.ok(js.includes(`"${label}"`), label);
  assert.match(js, /class="pp-ball"/);
});

test("ping-pong is only booked for pairs, who take both ends of the table", () => {
  const solo = new Lounge({ rng: mulberry32(11), startChance: 1, initialDelayMs: [0, 0], minIdleMs: 0, maxOnBreak: 1, cooldownMs: [1000, 1000] });
  simulate(solo, crowd(ids(6)), { steps: 400, onTick: (now, cmds) => {
    for (const c of cmds) if (c.type === "go") assert.notEqual(c.pose, "pingpong", "nobody plays ping-pong alone");
  }});
  let games = 0;
  const l = eager({ maxOnBreak: 6 });
  simulate(l, crowd(ids(12)), { steps: 600, onTick: (now, cmds) => {
    const starts = cmds.filter(c => c.type === "go" && c.pose === "pingpong");
    if (!starts.length) return;
    games++;
    assert.equal(starts.length, 2, "both players start together");
    assert.ok(starts[0].group && starts[0].group === starts[1].group, "the two players are a pair");
    assert.notEqual(starts[0].spot.id, starts[1].spot.id);
  }});
  assert.ok(games > 0, "pairs do play");
  assert.ok(KINDS.disco.stages[0].need.every(k => k === "dance"), "dancing stays on the Café Disco floor");
  assert.ok(!SIT_POSES.has("pingpong"));
});

test("basketball reserves one shooting spot, never crowds it, and yields to work", () => {
  const l = eager({ kinds: { basketball: KINDS.basketball }, maxOnBreak: 3 });
  const agents = crowd(ids(4));
  const commands = l.tick(1000, agents);
  const shot = commands.find(c => c.type === "go" && c.pose === "shoot");
  assert.ok(shot, "an idle agent can shoot");
  assert.equal(shot.spot.id, "warehouse-free-throw");
  assert.equal(shot.spot.zone, "court");
  for (let now = 1100; now < 3000; now += 100) {
    l.tick(now, agents);
    assert.equal(l.count, 1, "one shooter at a time");
  }
  const stop = l.tick(3000, agents.map(a => ({ ...a, working: true })));
  assert.ok(stop.some(c => c.id === shot.id && c.reason === "working"));
  assert.equal(l.count, 0);
  assert.equal(l.occupancy.size, 0);
});

test("idle hoop pairs book a shooter and courtside friend without overlapping; busy agents cannot join", () => {
  const lounge = eager({ kinds: { hoops: KINDS.hoops }, rng: () => .01 });
  const agents = crowd(["account-strategist", "sales-lead", "regional-manager"]);
  agents.push({ id: "busy", working: true, walking: false }, { id: "walking", working: false, walking: true });
  const starts = lounge.tick(1000, agents).filter(c => c.type === "go");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map(c => c.pose), ["shoot", "cheer"]);
  assert.equal(starts[0].group, starts[1].group);
  assert.notEqual(starts[0].spot.id, starts[1].spot.id);
  for (let now = 2000; now < 5000; now += 1000) {
    assert.equal(lounge.tick(now, agents).filter(c => c.type === "go").length, 0, "court cannot admit another pair");
  }
  const cancelled = lounge.tick(5000, agents.map(a => ({ ...a, working: true })));
  assert.equal(cancelled.filter(c => c.reason === "working").length, 2);
  assert.equal(lounge.occupancy.size, 0);
});

test("court trash talk is persona-specific, stays courtside, replies, and cancels when work starts", async () => {
  const roster = JSON.parse(await readFile(path.resolve("personas.json"), "utf8"));
  assert.deepEqual(Object.keys(COURT_BANTER).sort(), roster.map(a => a.id).sort());
  for (const lines of Object.values(COURT_BANTER)) {
    assert.ok(lines.length >= 2);
    assert.ok(lines.every(line => line.length <= 90));
  }
  const agents = crowd(["account-strategist", "sales-lead"]);
  const lounge = eager({ kinds: { hoops: KINDS.hoops }, rng: () => .01 });
  lounge.tick(1000, agents);
  const banter = new Banter({ lounge, rng: () => .01, pairBias: 1, agentCooldownMs: 0, gapMs: [0, 0] });
  banter.tick(1100, agents);
  const opener = banter.tick(4000, agents);
  assert.equal(opener.length, 1);
  assert.ok(COURT_BANTER[opener[0].id].includes(opener[0].text));
  const reply = banter.tick(8000, agents);
  assert.equal(reply.length, 1);
  assert.notEqual(reply[0].id, opener[0].id);
  assert.ok(COURT_REPLIES.includes(reply[0].text));
  banter.tick(9000, agents);
  assert.ok(banter.pending);
  assert.deepEqual(banter.tick(14000, agents.map(a => ({ ...a, working: true }))), []);
  assert.equal(banter.pending, null, "no delayed smack talk after real work starts");
});

test("ordinary idle rotation occasionally chooses basketball, not only forced test games", () => {
  const lounge = eager();
  const log = simulate(lounge, crowd(Object.keys(COURT_BANTER)), { steps: 900 });
  assert.ok(log.some(c => c.type === "go" && c.pose === "shoot"));
  assert.ok(log.some(c => c.type === "go" && c.pose === "cheer"));
  assert.ok(log.some(c => c.type === "go" && c.pose === "brew"), "other downtime continues");
});
