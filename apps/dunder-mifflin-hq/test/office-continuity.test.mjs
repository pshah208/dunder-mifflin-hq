import test from "node:test";
import assert from "node:assert/strict";
import { captureOffice, restoreOffice } from "../public/office-continuity.js";
import { Lounge, Banter, KINDS } from "../public/office-lounge.js";
import { Antics } from "../public/office-antics.js";

function runtime() {
  const lounge = new Lounge({ rng: () => 0, startChance: 1, initialDelayMs: [0, 0],
    minIdleMs: 0, maxOnBreak: 1, kinds: { coffee: KINDS.coffee } });
  const bubble = { textContent: "Coffee break", classList: { toggle() {} } };
  const sims = new Map([["regional-manager", { x: 9.5, y: 6.5, path: [[10, 7], [12.25, 8.05]],
    pose: "talk", nextPose: "brew", target: "12.25,8.05", facing: -1, carry: null,
    bubbleUntil: 12500, bubble }]]);
  return { sims, lounge, banter: new Banter({ lounge }), antics: new Antics(), scene: null, antic: null };
}

test("navigation preserves position, walking destination, break reservations and remaining timers", () => {
  const original = runtime();
  original.lounge.tick(1000, [{ id: "regional-manager", working: false, walking: false }]);
  original.lounge.tick(1100, [{ id: "regional-manager", working: false, walking: false }]);
  original.banter.nextAt = 14000;
  original.banter.last.set("regional-manager", 8000);
  original.banter.pending = { from: "regional-manager", to: "regional-manager", dueAt: 13000 };
  const saved = captureOffice(original, 10000);
  const restored = runtime();
  restoreOffice(JSON.parse(JSON.stringify(saved)), restored, 500);
  const a = original.sims.get("regional-manager"), b = restored.sims.get("regional-manager");
  assert.deepEqual([b.x, b.y, b.path, b.target, b.nextPose, b.carry], [a.x, a.y, a.path, a.target, a.nextPose, a.carry]);
  assert.equal(b.bubbleUntil, 3000);
  assert.deepEqual(restored.lounge.occupancy, original.lounge.occupancy);
  assert.equal(restored.lounge.visits.get("regional-manager").endAt, original.lounge.visits.get("regional-manager").endAt - 9500);
  assert.equal(restored.banter.pending.dueAt, 3500);
  assert.equal(restored.banter.nextAt, 4500);
  assert.equal(restored.lounge.lastVisit.get("regional-manager"), -8500);
  b.path.shift();
  assert.equal(a.path.length, 2, "snapshot does not retain mutable runtime references");
  assert.equal(JSON.stringify(saved).includes("bubble\":{\""), false, "no DOM nodes in storage");
});

test("social and antic timelines resume without restarting their current lines", () => {
  const original = runtime();
  original.scene = { ids: ["regional-manager"], clock: 6000, last: 10000, phase: "talk", next: 2,
    talkAt: 2500, endAt: 20000, maxOnBreak: 5, lines: [], steps: [] };
  original.antic = { bit: { cast: ["regional-manager"] }, startedAt: 4000, t0: 7000, next: 1, steps: [], total: 6000 };
  const result = restoreOffice(captureOffice(original, 10000), runtime(), 500);
  assert.equal(result.scene.clock, 6000);
  assert.equal(result.scene.next, 2);
  assert.equal(result.scene.last, 500);
  assert.equal(result.antic.t0, -2500);
  assert.equal(result.antic.next, 1);
});

test("invalid scene versions and corrupt positions fail explicitly before restoring", () => {
  const r = runtime(), saved = captureOffice(r, 10000);
  saved.version = 99;
  assert.throws(() => restoreOffice(saved, r, 500), /Invalid saved Office scene/);
  saved.version = 1;
  saved.sims[0][1].x = null;
  assert.throws(() => restoreOffice(saved, r, 500), /Invalid saved Office scene/);
  assert.equal(r.sims.get("regional-manager").x, 9.5);
  const badTimers = captureOffice(r, 10000);
  badTimers.banter.last = [["regional-manager", null]];
  badTimers.sims[0][1].x = 10;
  assert.throws(() => restoreOffice(badTimers, r, 500), /Invalid saved Office scene/);
  assert.equal(r.sims.get("regional-manager").x, 9.5, "invalid timers do not partially move characters");
});
