import test from "node:test";
import assert from "node:assert/strict";
import { createMessageQueue, publicQueue } from "../message-queue.mjs";

function fixture(max = 20) {
  const disk = new Map();
  const io = { read: async sid => structuredClone(disk.get(sid)), write: async (sid, q) => { disk.set(sid, structuredClone(q)); }, max };
  return { disk, io, q: createMessageQueue(io) };
}

test("queue is FIFO, bounded, scoped and preserves execution settings without exposing private paths", async () => {
  const { q } = fixture(2);
  const [first, second] = await Promise.all([
    q.enqueue("a", { message: "one", mode: "autopilot", speed: "team", model: "chosen", attachmentIds: ["image"], repoId: "repo" }),
    q.enqueue("a", { message: "two" }),
  ]);
  await assert.rejects(q.enqueue("a", { message: "overflow" }), /full/);
  await q.enqueue("b", { message: "independent" });
  const claimed = await q.claim("a");
  assert.equal(claimed.queueId, first.queueId);
  assert.equal(claimed.model, "chosen");
  assert.deepEqual(claimed.attachmentIds, ["image"]);
  assert.equal(await q.claim("a"), null);
  await assert.rejects(q.remove("a", first.queueId), /starting/);
  await q.complete("a", first.queueId);
  assert.equal((await q.claim("a")).queueId, second.queueId);
  assert.equal((await q.claim("b")).message, "independent");
  assert.equal(publicQueue(await q.get("a")).items[0].attachmentIds, undefined);
});

test("pause, cancel and failed admission preserve waiting items; resume is explicit", async () => {
  const { q } = fixture();
  const a = await q.enqueue("a", { message: "one" });
  const b = await q.enqueue("a", { message: "two" });
  await q.pause("a", "Stop");
  assert.equal(await q.claim("a"), null);
  await q.remove("a", b.queueId);
  await q.resume("a");
  assert.equal((await q.claim("a")).queueId, a.queueId);
  await q.fail("a", a.queueId, "Cannot connect");
  assert.equal((await q.get("a")).reason, "Cannot connect");
  assert.equal(await q.claim("a"), null);
  await q.resume("a");
  assert.equal((await q.claim("a")).queueId, a.queueId);
});

test("restart pauses saved work and never automatically retries an uncertain admission", async () => {
  const { q, io } = fixture();
  const a = await q.enqueue("a", { message: "possibly sent" });
  await q.enqueue("a", { message: "not sent" });
  await q.claim("a");
  const restored = createMessageQueue(io);
  assert.equal(await restored.claim("a"), null);
  assert.equal((await restored.get("a")).items[0].status, "uncertain");
  await assert.rejects(restored.resume("a"), /duplicate/);
  await restored.remove("a", a.queueId);
  await restored.resume("a");
  assert.equal((await restored.claim("a")).message, "not sent");
});

test("persistence failure rejects admission and does not silently accept or lose later requests", async () => {
  const { io } = fixture();
  let fail = true;
  const q = createMessageQueue({ ...io, write: async (sid, item) => {
    if (fail) throw new Error("disk full");
    await io.write(sid, item);
  } });
  await assert.rejects(q.enqueue("a", { message: "not accepted" }), /disk full/);
  assert.equal((await q.get("a")).items.length, 0);
  fail = false;
  await q.enqueue("a", { message: "accepted" });
  assert.equal((await q.claim("a")).message, "accepted");
});
