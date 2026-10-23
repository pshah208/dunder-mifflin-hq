import test from "node:test";
import assert from "node:assert/strict";
import { validateAutomation, nextAutomationTime, createAutomationStore, parseAutomationDraft, automationResultError } from "../automations.mjs";

const ids = new Set(["regional-manager", "product-manager", "office-administrator"]);
const workflow = () => ({ name: "Morning briefing", description: "Draft only", mode: "plan",
  schedule: { type: "interval", minutes: 15 }, timeoutMinutes: 2,
  steps: [{ title: "Read calendar", agent: "office-administrator", instruction: "Summarize today's calendar.", condition: "" }], agentModels: {} });
const complete = { answer: "Calendar summary.\nAUTOMATION STATUS: COMPLETED" };
function fixture() {
  let data = null, time = Date.parse("2026-10-22T12:00:00Z"), failWrite = false;
  const options = { agentIds: ids, now: () => time, read: async () => structuredClone(data),
    write: async value => { if (failWrite) throw new Error("disk full"); data = structuredClone(value); } };
  return { store: createAutomationStore(options), restart: () => createAutomationStore(options),
    advance: ms => { time += ms; }, diskFailure: () => { failWrite = true; }, data: () => data };
}
test("schema rejects unsafe schedules, unknown models/agents and malformed inputs", () => {
  assert.equal(validateAutomation(workflow(), ids).steps[0].agent, "office-administrator");
  for (const patch of [
    { name: "" }, { mode: "autopilot" }, { mode: "interactive" }, { timeoutMinutes: 0 }, { steps: [] },
    { schedule: { type: "interval", minutes: 1 } }, { schedule: { type: "webhook" } },
    { schedule: { type: "daily", time: "25:00", timezone: "UTC" } },
    { schedule: { type: "daily", time: "08:00", timezone: "not/a/timezone" } },
    { steps: [{ ...workflow().steps[0], agent: "unknown" }] }, { agentModels: { unknown: "model-1" } },
  ]) assert.throws(() => validateAutomation({ ...workflow(), ...patch }, ids));
  assert.equal(validateAutomation({ ...workflow(), mode: "interactive", schedule: { type: "manual" } }, ids).mode, "interactive");
});
test("timezone schedules skip spring-forward gaps and do not repeat fall-back hours", () => {
  const schedule = { type: "daily", time: "01:30", timezone: "America/New_York" };
  assert.equal(nextAutomationTime(schedule, Date.parse("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z");
  assert.equal(nextAutomationTime({ ...schedule, time: "02:30" }, Date.parse("2026-03-08T06:00:00Z")), "2026-03-09T06:30:00.000Z");
  assert.equal(nextAutomationTime({ type: "weekly", time: "09:00", weekday: 1, timezone: "UTC" }, Date.parse("2026-10-22T12:00:00Z")), "2026-10-26T09:00:00.000Z");
  assert.equal(nextAutomationTime({ type: "manual" }, Date.now()), null);
});
test("drafts never enable themselves, require one JSON block, and report blocked results", () => {
  const json = "```automation-json\n" + JSON.stringify({ ...workflow(), enabled: true }) + "\n```";
  assert.equal(parseAutomationDraft(json, ids).enabled, undefined);
  assert.throws(() => parseAutomationDraft(json + json, ids), /exactly one/);
  assert.throws(() => parseAutomationDraft("```automation-json\nnope\n```", ids), /invalid/);
  assert.ok(automationResultError("looks good"));
  assert.ok(automationResultError("AUTOMATION STATUS: BLOCKED"));
  assert.ok(automationResultError("AUTOMATION STATUS: COMPLETED\nAUTOMATION STATUS: BLOCKED"));
  assert.equal(automationResultError(complete.answer), null);
});
test("only tested current revisions can schedule; claims serialize, failures pause, edits invalidate tests", async () => {
  const f = fixture(), store = f.store;
  const def = await store.save(workflow());
  assert.equal(def.enabled, false);
  await assert.rejects(store.enable(def.id, 1, true), /Test/);
  const run = await store.claim({ id: def.id, revision: 1, trigger: "test", hqSessionId: "test" });
  await assert.rejects(store.claim({ id: def.id, revision: 1, trigger: "manual" }), /Another/);
  await assert.rejects(store.save(workflow(), def.id, 1), /Stop or finish/);
  await store.finish(run.id, complete);
  await store.enable(def.id, 1, true);
  f.advance(16 * 60_000);
  const claims = await Promise.allSettled([1, 2].map(() => store.claim({ id: def.id, revision: 1, trigger: "schedule", hqSessionId: "scheduled" })));
  assert.equal(claims.filter(x => x.status === "fulfilled").length, 1);
  const scheduled = claims.find(x => x.status === "fulfilled").value;
  await store.finish(scheduled.id, { error: "Access denied" });
  assert.equal((await store.list()).definitions[0].enabled, false);
  const edited = await store.save(workflow(), def.id, 1);
  assert.equal(edited.revision, 2); assert.equal(edited.testedRevision, null);
  await assert.rejects(store.save(workflow(), def.id, 1), /changed/);
  await assert.rejects(store.claim({ id: def.id, revision: 1, trigger: "manual" }), /changed/);
});
test("restart interrupts claimed work and pauses it without replay; missed idle schedules skip ahead", async () => {
  const f = fixture(), def = await f.store.save(workflow());
  const run = await f.store.claim({ id: def.id, revision: 1, trigger: "test", hqSessionId: "s" });
  await f.store.finish(run.id, complete);
  await f.store.enable(def.id, 1, true);
  f.advance(60 * 60_000);
  let restarted = f.restart(), state = await restarted.list();
  assert.ok(Date.parse(state.definitions[0].nextRunAt) > Date.parse("2026-10-22T13:00:00Z"));
  const manual = await restarted.claim({ id: def.id, revision: 1, trigger: "manual", hqSessionId: "s2" });
  restarted = f.restart(); state = await restarted.list();
  assert.equal(state.runs.find(r => r.id === manual.id).state, "interrupted");
  assert.equal(state.definitions[0].enabled, false);
  assert.equal(state.definitions[0].nextRunAt, null);
});
test("failed disk admission never becomes a runnable claim; corrupt stores fail closed", async () => {
  const f = fixture(), def = await f.store.save(workflow());
  f.diskFailure();
  await assert.rejects(f.store.claim({ id: def.id, revision: 1, trigger: "manual" }), /disk full/);
  assert.equal(f.data().runs.length, 0);
  const corrupt = createAutomationStore({ agentIds: ids, read: async () => ({ version: 0 }), write: async () => assert.fail("must not overwrite") });
  await assert.rejects(corrupt.list(), /invalid/);
});
