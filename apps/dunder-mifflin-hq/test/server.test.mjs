import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const originalData = process.env.DM_DATA_DIR;
const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-unit-"));
process.env.DM_DATA_DIR = tmp;
const {
  reduceEvent,
  makeSessionTitle,
  createRunRegistry,
  createLiveBus,
  replaceFileAtomic,
  loadSdkCustomAgents,
  buildSdkSessionConfig,
  azureShellTargetError,
  setAzTokenRunnerForTests,
  toSdkSessionName,
} = await import("../server.mjs");

// Never call the real Azure CLI from tests: connectors that need a token report "sign-in needed".
setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });

test.after(async () => {
  if (originalData === undefined) delete process.env.DM_DATA_DIR;
  else process.env.DM_DATA_DIR = originalData;
  await rm(tmp, { recursive: true, force: true });
});

test("reduceEvent handles key shapes", () => {
  assert.deepEqual(reduceEvent({ type: "assistant.message_delta", data: { messageId: "m", deltaContent: "x" } }), { t: "delta", id: "m", text: "x" });
  assert.deepEqual(reduceEvent({ type: "assistant.message", data: { messageId: "m", content: "ok" } }), { t: "message", id: "m", text: "ok", toolRequests: [] });
  assert.deepEqual(
    reduceEvent({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "Agent started in background with agent_id: abc" } } }),
    { t: "tool_end", callId: "c1", ok: true, error: undefined, background: true },
  );
  assert.deepEqual(
    reduceEvent({ type: "tool.execution_complete", data: { toolCallId: "c2", success: false, error: { message: "boom" }, result: { content: "normal result" } } }),
    { t: "tool_end", callId: "c2", ok: false, error: "boom" },
  );
  assert.deepEqual(
    reduceEvent({ type: "subagent.started", data: { toolCallId: "t1", agentName: "tactics-expert", model: "gpt-6-sol" } }),
    { t: "agent_start", callId: "t1", agent: "tactics-expert", model: "gpt-6-sol" },
  );
  assert.deepEqual(
    reduceEvent({ type: "subagent.completed", data: { toolCallId: "t1", agentName: "tactics-expert" } }),
    { t: "agent_end", callId: "t1", agent: "tactics-expert", ok: true },
  );
  assert.deepEqual(
    reduceEvent({ type: "subagent.completed", data: { toolCallId: "t2", agentName: "tactics-expert", cancelled: true } }),
    { t: "agent_end", callId: "t2", agent: "tactics-expert", ok: false, cancelled: true },
  );
  assert.deepEqual(
    reduceEvent({ type: "subagent.completed", data: { toolCallId: "t3", agentName: "tactics-expert" } }),
    { t: "agent_end", callId: "t3", agent: "tactics-expert", ok: true },
  );
  assert.deepEqual(
    reduceEvent({ type: "subagent.failed", data: { toolCallId: "t2", agentName: "match-analyst", error: { message: "timeout" } } }),
    { t: "agent_end", callId: "t2", agent: "match-analyst", ok: false, error: "timeout" },
  );
  assert.equal(reduceEvent({ type: "unhandled" }), null);
});

test("title normalization", () => {
  assert.equal(makeSessionTitle("  hi there  "), "hi there");
  assert.ok(makeSessionTitle("x".repeat(120)).endsWith("…"));
});

test("atomic metadata replacement retries transient locks but reports permanent failures", async () => {
  let calls = 0;
  await replaceFileAtomic("temp", "target", async () => {
    if (++calls < 3) throw Object.assign(new Error("file locked"), { code: "EPERM" });
  });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(replaceFileAtomic("temp", "target", async () => {
    calls++; throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  }), /disk full/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(replaceFileAtomic("temp", "target", async () => {
    calls++; throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  }), /permission denied/);
  assert.equal(calls, 6);
});

test("global Office snapshots replay current delegations from all active conversations only", () => {
  const bus = createLiveBus();
  bus.startRun("a", "run-a"); bus.startRun("b", "run-b");
  bus.publish("a", { t: "start", runId: "run-a" });
  bus.publish("a", { t: "delegate", runId: "run-a", callId: "task-a", agent: "product-manager", summary: "Meeting: ideas" });
  bus.publish("b", { t: "start", runId: "run-b" });
  const snapshot = sessionId => {
    let close, output = "";
    bus.subscribe({ on: (event, cb) => { close = cb; } }, {
      writeHead() {}, write: line => { output += line; },
    }, { sessionId, busy: true });
    close();
    return JSON.parse(output.trim()).events;
  };
  assert.equal(snapshot().length, 3);
  assert.equal(snapshot("b").length, 1);
  bus.endRun("a", "run-a");
  assert.equal(snapshot().length, 1);
  const start = reduceEvent({ type: "subagent.started", data: {
    toolCallId: "task-b", agentName: "sales-lead", agentDisplayName: "Meeting: Customer360 ideas", executionMode: "background",
  } });
  assert.equal(start.agent, "sales-lead");
  assert.equal(start.summary, "Meeting: Customer360 ideas");
  assert.equal(start.background, true);
});

test("direct Azure shell requests require explicit selected target flags", () => {
  const target = { subscription: "11111111-1111-4111-8111-111111111111", resourceGroup: "synthetic-test-rg" };
  const request = fullCommandText => ({ kind: "shell", fullCommandText });
  assert.ok(azureShellTargetError(request("az group delete -n x"), {}));
  assert.ok(azureShellTargetError(request("az group delete -n x"), target));
  assert.ok(azureShellTargetError(request(`az resource list --subscription wrong -g ${target.resourceGroup}`), target));
  assert.equal(azureShellTargetError(request(`az resource list --subscription '${target.subscription}' --resource-group "${target.resourceGroup}"`), target), null);
  assert.equal(azureShellTargetError(request(`az resource list --subscription=${target.subscription} -g=${target.resourceGroup}`), target), null);
  assert.equal(azureShellTargetError(request("node --version"), {}), null);
});

test("run registry parallel + scoped stop", () => {
  const stopped = [];
  const r = createRunRegistry((run) => stopped.push(run.hqSessionId));
  const sid1 = "11111111-1111-4111-8111-111111111111";
  const sid2 = "22222222-2222-4222-8222-222222222222";
  assert.equal(r.start({ runId: "r1", hqSessionId: sid1 }), true);
  assert.equal(r.start({ runId: "r2", hqSessionId: sid2 }), true);
  assert.equal(r.start({ runId: "r3", hqSessionId: sid1 }), false);
  assert.equal(r.stop(sid1), true);
  assert.deepEqual(stopped, [sid1]);
  assert.equal(r.count(), 2); // stop signals but registry entry remains until end
  r.end(sid1);
  r.end(sid2);
  assert.equal(r.count(), 0);
});

test("sdk config loads project custom agents + AGENTS system message", async () => {
  const agents = await loadSdkCustomAgents();
  assert.ok(agents.length >= 5);
  assert.ok(agents.some(a => a.name === "regional-manager"));
  assert.ok(agents.every(a => typeof a.prompt === "string" && a.prompt.length > 20));
  const cfg = await buildSdkSessionConfig({
    name: "test",
    model: "gpt-5.3-codex",
    handlers: { onEvent: () => {}, onPermissionRequest: () => ({ kind: "approve-once" }) },
  });
  assert.ok(cfg.systemMessage?.content?.includes("Dunder Mifflin HQ"));
  assert.equal(cfg.customAgentsLocalOnly, true);
  assert.ok(cfg.customAgents.some(a => a.name === "automation-engineer"));
});

// Regression: titles come from the user's first message; the SDK rejected one containing double quotes
// ("Session name must not contain double quotes") and the run never started.
test("SDK session names satisfy the SDK rules whatever the chat title contains", async () => {
  const valid = n => n === undefined || (n.length > 0 && n === n.trim() && [...n].length <= 100 && !/["\u0000-\u001f\u007f]/.test(n));
  const title = makeSessionTitle('Review the email from Alex at Contoso regarding the "Pilot approval: storage options, residency for our analytics rollout" and prepare a draft response');
  const name = toSdkSessionName(title);
  assert.ok(valid(name), name);
  assert.ok(!name.includes('"'));
  assert.match(name, /^Review the email from Alex/);
  for (const raw of ['"quoted"', "“smart quotes”", "tab\there\nnewline", "  padded  ", "x".repeat(250), "😀".repeat(120), "", "   ", null, "ok"]) assert.ok(valid(toSdkSessionName(raw)), JSON.stringify(raw));
  assert.equal(toSdkSessionName("ok"), "ok");
  assert.equal(toSdkSessionName('say "hi"'), "say 'hi'");
  assert.equal(toSdkSessionName("   "), undefined);
  const cfg = await buildSdkSessionConfig({ name: title, handlers: {} });
  assert.ok(valid(cfg.name) && !cfg.name.includes('"'), "the config passed to createSession/resumeSession is sanitized");
});
