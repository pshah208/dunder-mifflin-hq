import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ANTICS, Antics, anticTimeline, CAMERA } from "../public/office-antics.js";

const mulberry32 = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const team = JSON.parse(await readFile(path.resolve("personas.json"), "utf8"));
const ids = team.map(m => m.id);
const allIdle = ids.map(id => ({ id, idle: true }));

test("every antic uses real agents, only cast members speak, visits stay in the cast", () => {
  assert.ok(ANTICS.length >= 30, "a deep bench of bits so idle time doesn't repeat quickly");
  assert.equal(new Set(ANTICS.map(b => b.id)).size, ANTICS.length);
  for (const b of ANTICS) {
    for (const id of b.cast) assert.ok(ids.includes(id), `${b.id}: unknown ${id}`);
    for (const [id, text] of b.lines) {
      assert.ok(b.cast.includes(id), `${b.id}: ${id} speaks but isn't cast`);
      assert.ok(text.length > 0 && text.length <= 95, `${b.id}: line length`);
    }
    if (b.visit) { assert.equal(b.visit.length, 2); assert.ok(b.cast.includes(b.visit[0]) && b.cast.includes(b.visit[1])); }
  }
  const speakers = new Set(ANTICS.flatMap(b => b.lines.map(([id]) => id)));
  for (const id of ids) assert.ok(speakers.has(id), `${id} never gets a joke`);
  assert.ok(ANTICS.some(b => b.lines.some(([, t]) => t.startsWith(CAMERA))), "talking-head asides exist");
  assert.ok(ANTICS.some(b => b.visit), "desk visits exist");
});

test("antics are original text, never famous script lines", () => {
  const banned = [/that's what she said/i, /bears\.? beets/i, /did i stutter/i, /why are you the way/i, /faster than 80/i,
    /i declare bankruptcy/i, /bob vance,? vance refrigeration/i, /identity theft is not a joke/i, /no, god,? please no/i, /i'?m not superstitious/i];
  for (const b of ANTICS) for (const [, text] of b.lines) for (const re of banned) assert.ok(!re.test(text), `${b.id}: ${text}`);
});

test("scheduler only casts idle agents, waits between bits and avoids repeats", () => {
  const a = new Antics({ rng: mulberry32(3), gapMs: [1000, 1000] });
  assert.equal(a.tick(0, allIdle), null, "first tick only schedules");
  const seen = [];
  let now = 0;
  for (let i = 0; i < 14; i++) {
    now += 1000;
    const pick = a.tick(now, allIdle);
    assert.ok(pick, "a bit plays when everyone is idle");
    seen.push(pick.bit.id);
    assert.equal(a.tick(now + 10, allIdle), null, "respects the gap");
  }
  assert.equal(new Set(seen).size, seen.length, "no repeats within the recent window");
  const busyDwight = allIdle.map(x => x.id === "sales-lead" ? { ...x, idle: false } : x);
  for (let i = 0; i < 40; i++) {
    now += 1000;
    const pick = a.tick(now, busyDwight);
    if (pick) assert.ok(!pick.bit.cast.includes("sales-lead"), "a working agent is never cast");
  }
  assert.equal(a.tick(now + 5000, ids.map(id => ({ id, idle: false }))), null, "nobody idle, no bit");
});

test("bits are rarer while the team is busy, and timelines give time to read", () => {
  const a = new Antics({ rng: () => 0, gapMs: [1000, 1000], busyGapFactor: 3 });
  a.tick(0, allIdle, { teamBusy: true });
  assert.equal(a.nextAt, 3000);
  const steps = anticTimeline(ANTICS.find(b => b.id === "stapler-jello"));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].at - steps[i - 1].at >= 2600);
  assert.ok(steps.every(s => s.ms >= 1900 && s.ms <= 4200));
});

test("office.js wires antics as decoration that real work cancels", async () => {
  const js = await readFile(path.resolve("public", "office.js"), "utf8");
  const block = js.slice(js.indexOf("// ---------- Antics"), js.indexOf("// Idle life:"));
  assert.ok(block.length > 0);
  assert.ok(!/\.active\s*=/.test(block), "an antic never marks anyone as working");
  assert.ok(block.includes("document.hidden") && block.includes("state.replaying"));
  assert.match(js, /if \(antic && antic\.bit\.cast\.some\(id => working\.has\(id\)/, "real work ends the bit");
  assert.match(js, /inScene\(id\) \|\| inAntic\(id\)/);
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.match(css, /\.office-page \.bubble\.camera \{/);
});
