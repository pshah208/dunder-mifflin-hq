import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { findEndKey } from "../public/ui-logic.js";
import { isMeetingSummary } from "../public/office-social.js";
import { teamOf } from "../public/office-crossteam.js";

test("Office uses real child lifecycle, preserves meeting identity and ignores specialist completion/text", async () => {
  const source = await readFile(new URL("../public/office.js", import.meta.url), "utf8");
  const noop = () => {};
  const sandbox = {
    state: { runs: new Map(), source: "test", replaying: true },
    makeRun: () => ({ active: new Map(), summaries: new Map(), delegates: 0, leadText: "", fullText: "" }),
    personaOf: () => null, logFeed: noop, say: noop, plan: noop,
    esc: String, trim: String, TEXT_CAP: 10000, findEndKey, isSocialRun: () => false,
    setTimeout: noop, loadDundies: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function onEvent(ev)"), source.indexOf("const toolVerb")), sandbox);
  const emit = event => sandbox.onEvent({ runId: "run", ...event });
  emit({ t: "start" });
  emit({ t: "delegate", callId: "c", agent: "product-manager", summary: "Meeting: brainstorm" });
  emit({ t: "agent_start", callId: "c", agent: "product-manager", background: true });
  emit({ t: "tool_end", callId: "c", ok: true });
  const run = sandbox.state.runs.get("run");
  assert.equal(run.busy, true);
  assert.ok(isMeetingSummary(run.active.get("c").summary));
  emit({ t: "message", agentId: "child", text: "Not Michael's final reply" });
  emit({ t: "delta", agentId: "child", text: "Child delta" });
  emit({ t: "result", agentId: "child", exitCode: 0 });
  emit({ t: "end", agentId: "child", code: 0 });
  assert.equal(run.fullText, "");
  assert.equal(run.active.size, 1);
  assert.equal(run.busy, true);
  emit({ t: "agent_end", callId: "c", agent: "product-manager", ok: true });
  assert.equal(run.active.size, 0);
  emit({ t: "agent_start", callId: "new", agent: "sales-lead", summary: "Meeting: customer review" });
  assert.ok(isMeetingSummary(run.active.get("new").summary));
  emit({ t: "end", code: 0 });
  assert.equal(sandbox.state.runs.size, 0);
});

test("physical meetings use one request's stakeholders, not unrelated work or desk locations", async () => {
  const source = await readFile(new URL("../public/office.js", import.meta.url), "utf8");
  const noop = () => {};
  const sandbox = {
    state: { busy: true, runs: new Map(), source: "live" }, scene: null, antic: null,
    esc: String, teamOf, isMeetingSummary, performance: { now: () => 1000 },
    lounge: { preempt: noop, onBreak: () => false },
    sims: new Map(), inScene: () => false, inAntic: () => false, crossPlan: noop,
    $: () => ({}), noteMeeting: ids => { sandbox.meeting = [...ids]; },
    goTo: (s, x, y, pose) => { s.destination = [x, y, pose]; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("// ---------- Isometric helpers"), source.indexOf("// ---------- Sims")), sandbox);
  vm.runInContext('for (const id of Object.keys(HOME)) sims.set(id, { m: { id } });', sandbox);
  vm.runInContext(source.slice(source.indexOf("function plan()"), source.indexOf("// ---------- Meetings")), sandbox);
  const run = (ids, study = false) => ({ busy: true, study, leadText: "", active: new Map(ids.map(id => [id, { agent: id, summary: "Task" }])),
    summaries: new Map(ids.map(id => [id, "Task"])) });
  sandbox.state.runs.set("sales-request", run(["finance-analyst"]));
  sandbox.state.runs.set("technical-request", run(["cloud-ai-architect"]));
  sandbox.plan();
  assert.equal(sandbox.meeting.length, 0, "independent requests aren't invented into a meeting");
  sandbox.state.runs.clear();
  const shared = run(["finance-analyst", "cloud-ai-architect", "compliance-officer"]);
  sandbox.state.runs.set("shared", shared);
  sandbox.plan();
  assert.equal(sandbox.meeting.length, 3, "accounting, engineering and review gather together");
  assert.deepEqual(sandbox.sims.get("regional-manager").destination, [6, 1.88, "talk"]);
  shared.active.delete("finance-analyst");
  sandbox.plan();
  assert.equal(sandbox.meeting.length, 3);
  assert.equal(sandbox.sims.get("finance-analyst").active, false, "completed attendees aren't falsely shown as working");
  shared.study = true;
  sandbox.plan();
  assert.equal(sandbox.meeting.length, 0, "character study keeps its own break-room choreography");
});
