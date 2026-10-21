import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

const originalData = process.env.DM_DATA_DIR;
const originalDisableAzureDiscovery = process.env.DM_DISABLE_AZURE_DISCOVERY;
const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-int-"));
const approvedFixturePath = path.join(tmp, "approved.txt");
process.env.DM_DATA_DIR = tmp;
process.env.DM_DISABLE_AZURE_DISCOVERY = "1";

const {
  createServer,
  setSdkClientFactoryForTests,
  setAzTokenRunnerForTests,
} = await import("../server.mjs");

// Never call the real Azure CLI from tests: connectors that need a token report "sign-in needed".
setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });
let FORCE_RESUME_MISSING = false;
let FAIL_NEXT_CREATE = false;

class MockSession {
  constructor(id, cfg) {
    this.sessionId = id;
    this.cfg = cfg;
    this.aborted = false;
    this.pendingSlowResolve = null;
  }
  async setModel() {}
  async send({ prompt }) {
    const emit = (type, data = {}) => this.cfg.onEvent?.({ type, data });
    if (prompt.includes("[HQ FINAL ANSWER]")) {
      const permission = await this.cfg.onPermissionRequest({ kind: "write" });
      assert.equal(permission.kind, "reject", "summary recovery cannot repeat an action");
      setTimeout(() => {
        if (!this.failSummary) emit("assistant.message", { messageId: "summary", content: "Summary of completed work." });
        emit("session.idle");
      }, 10);
      return "summary";
    }
    if (prompt.includes("tool-without-summary")) {
      this.failSummary = prompt.includes("fail-summary");
      setTimeout(() => {
        emit("assistant.message", { messageId: "preamble", content: "I will check." });
        emit("tool.execution_start", { toolCallId: "read", toolName: "view", arguments: {} });
        emit("tool.execution_complete", { toolCallId: "read", success: true });
        emit("session.idle");
      }, 10);
      return "tool";
    }
    if (prompt.includes("intermediate-autopilot-idle")) {
      setTimeout(() => {
        emit("assistant.message", { messageId: "preamble", content: "Starting work." });
        emit("session.idle", { mode: "autopilot" });
        emit("subagent.started", { toolCallId: "meeting-child", agentName: "product-manager", agentDisplayName: "Meeting: ideas", executionMode: "background" });
        this.cfg.onEvent({ type: "session.idle", data: { agentId: "legacy-child" } });
      }, 10);
      setTimeout(() => {
        emit("subagent.completed", { toolCallId: "meeting-child", agentName: "product-manager" });
        emit("assistant.message_delta", { messageId: "final", deltaContent: "Complete " });
        emit("assistant.message_delta", { messageId: "final", deltaContent: "answer." });
        emit("session.idle", { mode: "interactive" });
      }, 180);
      return "interim";
    }
    if (prompt.includes("empty-final-idle")) {
      setTimeout(() => emit("session.idle"), 10);
      return "empty";
    }
    if (prompt.includes("autopilot-tool-batch")) {
      setTimeout(async () => {
        const decisions = [];
        for (const request of [
          { kind: "mcp", serverName: "powerbi-browser", toolName: "browser_navigate", readOnly: false },
          { kind: "mcp", serverName: "powerbi-browser", toolName: "browser_click", readOnly: false },
          { kind: "mcp", serverName: "powerbi-browser", toolName: "browser_select_option", readOnly: false },
          { kind: "mcp", serverName: "workiq", toolName: "create_entity", readOnly: false },
          { kind: "write", fileName: approvedFixturePath },
          { kind: "shell", fullCommandText: "echo approved" },
          { kind: "shell", fullCommandText: "az group delete --name forbidden" },
        ]) decisions.push((await this.cfg.onPermissionRequest(request)).kind);
        emit("assistant.message", { messageId: "tool-batch", content: JSON.stringify(decisions) });
        emit("session.idle");
      }, 10);
      return "uBatch";
    }
    if (prompt.includes("service-confirmation-test")) {
      setTimeout(async () => {
        const result = await this.cfg.onElicitationRequest({
          mode: "form", elicitationSource: "msx", message: "Confirm service write?",
          requestedSchema: { type: "object", required: ["confirm"], properties: { confirm: { type: "boolean" } } },
        });
        emit("assistant.message", { messageId: "service-confirm", content: result.action });
        emit("session.idle");
      }, 10);
      return "uService";
    }
    if (prompt.includes("subagent-finishes-first")) {
      setTimeout(() => {
        this.cfg.onEvent?.({ type: "assistant.message", agentId: "sub-1", data: { messageId: "sub-message", content: "Specialist draft" } });
        this.cfg.onEvent?.({ type: "session.error", agentId: "sub-1", data: { message: "Specialist retry" } });
        this.cfg.onEvent?.({ type: "session.idle", agentId: "sub-1", data: {} });
      }, 10);
      setTimeout(() => {
        emit("assistant.message", { messageId: "root-message", content: "Michael final reply" });
        emit("session.idle");
      }, 250);
      return "uSubagent";
    }
    if (prompt.includes("toby-review-run")) {
      setTimeout(() => {
        emit("tool.execution_start", { toolCallId: "c1", toolName: "task", arguments: { agent_type: "product-manager", description: "Pitch" } });
        emit("tool.execution_start", { toolCallId: "c2", toolName: "task", arguments: { agent_type: "compliance-officer", description: "Review" } });
        this.cfg.onEvent?.({ type: "assistant.message", agentId: "sub-toby", data: { messageId: "toby-msg", content: "Fine.\nTOBY VERDICT: APPROVED (for: product-manager)" } });
        emit("assistant.message", { messageId: "mToby", content: "Ideas ready.\nTOBY VERDICT: APPROVED (for: product-manager)", toolRequests: [] });
        emit("session.idle", {});
      }, 10);
      return "uToby";
    }
    if (prompt.includes("simple-question-test")) {
      setTimeout(() => {
        emit("assistant.message", { messageId: "m1", content: "ok", toolRequests: [] });
        emit("session.idle", {});
      }, 10);
      return "u1";
    }
    if (prompt.includes("request-write-bridge")) {
      setTimeout(async () => {
        const decision = await this.cfg.onPermissionRequest({
          kind: "write",
          fileName: approvedFixturePath,
          intention: "Write approved fixture",
        });
        if (decision?.kind?.startsWith("approve")) {
          await writeFile(approvedFixturePath, "approved write\n", "utf8");
          emit("assistant.message", { messageId: "m2", content: "wrote approved fixture", toolRequests: [] });
        } else {
          emit("assistant.message", { messageId: "m2", content: "write denied", toolRequests: [] });
        }
        emit("session.idle", {});
      }, 10);
      return "u2";
    }
    if (prompt.includes("plan-permission-matrix")) {
      setTimeout(async () => {
        const read = await this.cfg.onPermissionRequest({ kind: "read" });
        const mcpRead = await this.cfg.onPermissionRequest({ kind: "mcp", readOnly: true, serverName: "x", toolName: "y" });
        const mcpWrite = await this.cfg.onPermissionRequest({ kind: "mcp", readOnly: false, serverName: "x", toolName: "z" });
        const write = await this.cfg.onPermissionRequest({ kind: "write", fileName: approvedFixturePath });
        const unknown = await this.cfg.onPermissionRequest({ kind: "future-kind" });
        const exit = this.cfg.onExitPlanModeRequest ? await this.cfg.onExitPlanModeRequest({ summary: "s", actions: ["interactive"], recommendedAction: "interactive" }) : { approved: null };
        emit("assistant.message", { messageId: "mPlan", content: JSON.stringify({ read: read.kind, mcpRead: mcpRead.kind, mcpWrite: mcpWrite.kind, write: write.kind, unknown: unknown.kind, exitApproved: exit.approved }), toolRequests: [] });
        emit("session.idle", {});
      }, 10);
      return "uPlan";
    }
    if (prompt.includes("autopilot-managed-gate")) {
      setTimeout(async () => {
        const decision = await this.cfg.onPermissionRequest({ kind: "write", fileName: approvedFixturePath, managedApprovalRequired: true, intention: "Managed gate write" });
        if (decision?.kind?.startsWith("approve")) await writeFile(approvedFixturePath, "managed approved\n", "utf8");
        emit("assistant.message", { messageId: "mAutoGate", content: decision?.kind || "none", toolRequests: [] });
        emit("session.idle", {});
      }, 10);
      return "uAutoGate";
    }
    if (prompt.includes("managed-read-gate")) {
      setTimeout(async () => {
        const decision = await this.cfg.onPermissionRequest({ kind: "read", managedApprovalRequired: true, fileName: approvedFixturePath });
        emit("assistant.message", { messageId: "managed-read", content: decision.kind });
        emit("session.idle");
      }, 10);
      return "uManagedRead";
    }
    if (prompt.includes("question-bridge-delayed")) {
      setTimeout(async () => {
        if (typeof this.cfg.onUserInputRequest !== "function") {
          emit("assistant.message", { messageId: "m3d", content: "no-question-handler", toolRequests: [] });
          emit("session.idle", {});
          return;
        }
        const ans = await this.cfg.onUserInputRequest({ question: "Choose", choices: ["A", "B"], allowFreeform: true });
        setTimeout(() => {
          emit("assistant.message", { messageId: "m3d", content: `answer:${ans.answer}|freeform:${ans.wasFreeform}`, toolRequests: [] });
          emit("session.idle", {});
        }, 5300);
      }, 10);
      return "u3d";
    }
    if (prompt.includes("question-bridge")) {
      setTimeout(async () => {
        if (typeof this.cfg.onUserInputRequest !== "function") {
          emit("assistant.message", { messageId: "m3", content: "no-question-handler", toolRequests: [] });
          emit("session.idle", {});
          return;
        }
        const ans = await this.cfg.onUserInputRequest({ question: "Choose", choices: ["A", "B"], allowFreeform: true });
        emit("assistant.message", { messageId: "m3", content: `answer:${ans.answer}|freeform:${ans.wasFreeform}`, toolRequests: [] });
        emit("session.idle", {});
      }, 10);
      return "u3";
    }
    if (prompt.includes("admission-delay")) {
      setTimeout(() => emit("assistant.message", { messageId: "mDelay", content: "still running", toolRequests: [] }), 10);
      setTimeout(() => emit("session.idle", {}), 250);
      return "uDelay";
    }
    if (prompt.includes("slow-run")) {
      setTimeout(() => emit("assistant.message", { messageId: "m4", content: "working", toolRequests: [] }), 10);
      await new Promise(resolve => { this.pendingSlowResolve = resolve; });
      return "u4";
    }
    if (prompt.includes("fail-no-response")) {
      throw new Error("mock nonzero");
    }
    if (prompt.includes("session-error")) {
      setTimeout(() => emit("session.error", { message: "sdk session error" }), 10);
      return "ue";
    }
    if (prompt.includes("late-permission-after-idle")) {
      setTimeout(() => emit("session.idle", {}), 10);
      setTimeout(async () => {
        await this.cfg.onPermissionRequest({ kind: "write", fileName: approvedFixturePath, intention: "late request" });
      }, 40);
      return "ue";
    }
    setTimeout(() => {
      emit("assistant.message", { messageId: "mx", content: "done", toolRequests: [] });
      emit("session.idle", {});
    }, 10);
    return "ux";
  }
  async abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.pendingSlowResolve?.();
    this.cfg.onEvent?.({ type: "session.idle", data: {} });
  }
}

class MockClient {
  constructor(store) { this.sessions = new Map(); this.store = store; }
  async start() {}
  async stop() { this.store.stopCount = (this.store.stopCount || 0) + 1; }
  async listModels() {
    return [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", policy: { state: "enabled", terms: "" }, capabilities: { supports: { vision: false } } },
      { id: "gpt-6-sol", name: "GPT-6 Sol", policy: { state: "enabled", terms: "" }, capabilities: { supports: { vision: true } } },
    ];
  }
  async resumeSession(id, cfg) {
    this.store.resumeConfigs.push(cfg);
    if (FORCE_RESUME_MISSING || this.store.forceMissingOnResume) throw new Error("missing");
    if (!this.sessions.has(id)) throw new Error("missing");
    const s = new MockSession(id, cfg);
    this.sessions.set(id, s);
    return s;
  }
  async createSession(cfg) {
    this.store.createConfigs.push(cfg);
    if (FAIL_NEXT_CREATE) {
      FAIL_NEXT_CREATE = false;
      throw new Error("temporary create failure");
    }
    const id = cfg.sessionId;
    const s = new MockSession(id, cfg);
    this.sessions.set(id, s);
    return s;
  }
}

test.after(async () => {
  if (originalData === undefined) delete process.env.DM_DATA_DIR;
  else process.env.DM_DATA_DIR = originalData;
  if (originalDisableAzureDiscovery === undefined) delete process.env.DM_DISABLE_AZURE_DISCOVERY;
  else process.env.DM_DISABLE_AZURE_DISCOVERY = originalDisableAzureDiscovery;
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch (e) {
    if (e?.code !== "EBUSY") throw e;
  }
});

async function createSession(base, token) {
  const r = await fetch(`${base}/api/history/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DM-Token": token },
    body: "{}",
  });
  return r.json();
}

async function post(base, token, pathName, body) {
  return fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DM-Token": token },
    body: JSON.stringify(body),
  });
}

async function waitForBusy(base, token, sid, expected, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(sid)}`, { headers: { "X-DM-Token": token } })).json();
    if (!!s.busy === expected) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting busy=${expected}`);
}

async function waitForPending(base, token, sid, key, minCount = 1, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(sid)}`, { headers: { "X-DM-Token": token } })).json();
    if (Array.isArray(p?.[key]) && p[key].length >= minCount) return p;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting pending.${key} >= ${minCount}`);
}

test("queued messages wait for final idle, drain FIFO, and pause on stop/failure", async () => {
  const sdkStore = { createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(sdkStore));
  const token = "queue-test", port = 4566;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const get = async endpoint => (await fetch(`${base}${endpoint}`, { headers: { "X-DM-Token": token } })).json();
  const history = sid => get(`/api/history/sessions/${sid}`);
  const queue = sid => get(`/api/queue?hqSessionId=${sid}`);
  const until = async predicate => {
    for (let i = 0; i < 150; i++) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail("Timed out waiting for queue");
  };
  try {
    const s = await createSession(base, token), other = await createSession(base, token);
    assert.equal((await post(base, token, "/api/chat", { hqSessionId: s.id, mode: "autopilot", message: "intermediate-autopilot-idle" })).status, 200);
    const second = await post(base, token, "/api/chat", { hqSessionId: s.id, queue: true, mode: "plan", speed: "team", message: "second" });
    assert.equal(second.status, 202);
    const third = await post(base, token, "/api/chat", { hqSessionId: s.id, queue: true, mode: "interactive", message: "third" });
    assert.equal(third.status, 202);
    assert.equal((await post(base, token, "/api/chat", { hqSessionId: other.id, message: "independent" })).status, 200);
    await new Promise(r => setTimeout(r, 40));
    assert.equal((await history(s.id)).entries.filter(e => e.role === "user").length, 1, "interim idle cannot release the next request");
    await until(async () => (await history(s.id)).entries.filter(e => e.role === "assistant").length === 3);
    await waitForBusy(base, token, s.id, false);
    const doc = await history(s.id);
    assert.deepEqual(doc.entries.filter(e => e.role === "user").map(e => e.text), ["intermediate-autopilot-idle", "second", "third"]);
    assert.equal(doc.entries.find(e => e.role === "assistant").text, "Complete answer.");
    assert.equal(doc.entries.filter(e => e.role === "user")[1].speed, "team");
    assert.equal(doc.entries.filter(e => e.role === "assistant")[1].mode, "plan");
    assert.equal((await queue(s.id)).items.length, 0);

    await post(base, token, "/api/chat", { hqSessionId: s.id, message: "slow-run" });
    const queued = await (await post(base, token, "/api/chat", { hqSessionId: s.id, queue: true, message: "waiting" })).json();
    assert.equal((await post(base, token, "/api/chat", { hqSessionId: s.id, queue: true, message: "bad image", attachmentIds: ["not-mine"] })).status, 400);
    await post(base, token, "/api/stop", { hqSessionId: s.id });
    await waitForBusy(base, token, s.id, false);
    assert.equal((await queue(s.id)).paused, true);
    assert.equal((await queue(s.id)).items.length, 1);
    assert.match((await history(s.id)).entries.at(-1).error, /Stopped/);
    await post(base, token, "/api/queue/remove", { hqSessionId: s.id, queueId: queued.queueId });
    assert.equal((await queue(s.id)).items.length, 0);
    await post(base, token, "/api/queue/resume", { hqSessionId: s.id });

    const failed = await createSession(base, token);
    await post(base, token, "/api/queue/pause", { hqSessionId: failed.id });
    await post(base, token, "/api/chat", { hqSessionId: failed.id, queue: true, message: "empty-final-idle" });
    await post(base, token, "/api/chat", { hqSessionId: failed.id, queue: true, message: "after failure" });
    await post(base, token, "/api/queue/resume", { hqSessionId: failed.id });
    await until(async () => (await queue(failed.id)).paused);
    assert.equal((await queue(failed.id)).items.length, 1);
    assert.match((await history(failed.id)).entries.at(-1).error, /without a response/);
    await post(base, token, "/api/queue/resume", { hqSessionId: failed.id });
    await until(async () => (await history(failed.id)).entries.filter(e => e.role === "assistant").length === 2);
    await waitForBusy(base, token, failed.id, false);
    assert.equal((await queue(failed.id)).items.length, 0);
    for (const suffix of ["", " fail-summary"]) {
      const recovery = await createSession(base, token);
      await post(base, token, "/api/chat", { hqSessionId: recovery.id, message: `tool-without-summary${suffix}` });
      await waitForBusy(base, token, recovery.id, false);
      const answer = (await history(recovery.id)).entries.at(-1);
      if (suffix) {
        assert.equal(answer.state, "failed");
        assert.match(answer.error, /one summary attempt/);
      } else {
        assert.equal(answer.text, "Summary of completed work.");
        assert.equal(answer.state, "completed");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("sdk interactive bridge + scoped concurrency", async () => {
  const sdkStore = { createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(sdkStore));
  const token = "test-token";
  const port = 4550;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const s1 = await createSession(base, token);
    const s2 = await createSession(base, token);

    // write approval appears and deny keeps no follow-up writes
    const r1 = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "request-write-bridge" });
    assert.equal(r1.status, 200);
    const pending1 = await waitForPending(base, token, s1.id, "approvals", 1);
    assert.equal(pending1.approvals.length, 1);
    assert.equal(pending1.approvals[0].request.intention, "Write approved fixture");
    await post(base, token, "/api/approvals/respond", { hqSessionId: s1.id, approvalId: pending1.approvals[0].approvalId, decision: "deny" });
    await waitForBusy(base, token, s1.id, false);
    assert.equal(existsSync(approvedFixturePath), false);

    // approving the same request writes only the requested fixture
    const r1b = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "request-write-bridge" });
    assert.equal(r1b.status, 200);
    const pending1b = await waitForPending(base, token, s1.id, "approvals", 1);
    await post(base, token, "/api/approvals/respond", { hqSessionId: s1.id, approvalId: pending1b.approvals[0].approvalId, decision: "approve" });
    await waitForBusy(base, token, s1.id, false);
    assert.equal(await readFile(approvedFixturePath, "utf8"), "approved write\n");

    // plan mode denies write requests (no pending approval surfaced, no write)
    await writeFile(approvedFixturePath, "", "utf8");
    const planWrite = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "plan", message: "request-write-bridge" });
    assert.equal(planWrite.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const planPending = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(planPending.approvals.length, 0);
    assert.notEqual(await readFile(approvedFixturePath, "utf8"), "approved write\n");
    const planMatrix = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "plan", message: "plan-permission-matrix" });
    assert.equal(planMatrix.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const planHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    const matrix = JSON.parse(planHistory.entries.at(-1).text);
    assert.deepEqual(matrix, { read: "approve-once", mcpRead: "approve-once", mcpWrite: "reject", write: "reject", unknown: "reject", exitApproved: false });

    // autopilot mode approves write automatically (no pending approval)
    const autoWrite = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "autopilot", message: "request-write-bridge" });
    assert.equal(autoWrite.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const autoPending = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(autoPending.approvals.length, 0);
    assert.equal(await readFile(approvedFixturePath, "utf8"), "approved write\n");
    await writeFile(approvedFixturePath, "", "utf8");
    for (let i = 0; i < 2; i++) {
      assert.equal((await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "autopilot", message: "autopilot-tool-batch" })).status, 200);
      await waitForBusy(base, token, s1.id, false);
      const history = await (await fetch(`${base}/api/history/sessions/${s1.id}`, { headers: { "X-DM-Token": token } })).json();
      assert.deepEqual(JSON.parse(history.entries.at(-1).text), [
        "approve-once", "approve-once", "approve-once", "approve-once", "approve-once", "approve-once", "reject",
      ], "one Autopilot grant covers successive tool calls and turns, not forbidden Azure actions");
      const pending = await (await fetch(`${base}/api/pending?hqSessionId=${s1.id}`, { headers: { "X-DM-Token": token } })).json();
      assert.equal(pending.approvals.length, 0);
    }
    // A different conversation in Interactive does not inherit Autopilot permission.
    await post(base, token, "/api/chat", { hqSessionId: s2.id, mode: "interactive", message: "autopilot-tool-batch" });
    const isolatedApproval = await waitForPending(base, token, s2.id, "approvals", 1);
    assert.equal(isolatedApproval.approvals[0].request.toolName, "browser_navigate");
    await post(base, token, "/api/stop", { hqSessionId: s2.id });
    await waitForBusy(base, token, s2.id, false);
    await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "plan", message: "autopilot-tool-batch" });
    await waitForBusy(base, token, s1.id, false);
    const planBatch = await (await fetch(`${base}/api/history/sessions/${s1.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.deepEqual(JSON.parse(planBatch.entries.at(-1).text), Array(7).fill("reject"));
    const autoManaged = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "autopilot", message: "autopilot-managed-gate" });
    assert.equal(autoManaged.status, 200);
    const managedPending = await waitForPending(base, token, s1.id, "approvals", 1);
    assert.equal(managedPending.approvals[0].request.intention, "Managed gate write");
    await post(base, token, "/api/approvals/respond", { hqSessionId: s1.id, approvalId: managedPending.approvals[0].approvalId, decision: "deny" });
    await waitForBusy(base, token, s1.id, false);
    assert.equal(await readFile(approvedFixturePath, "utf8"), "");
    const autoQ = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "autopilot", message: "question-bridge" });
    assert.equal(autoQ.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const autoQPending = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(autoQPending.questions.length, 0);
    await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "autopilot", message: "service-confirmation-test" });
    const servicePending = await waitForPending(base, token, s1.id, "elicitations", 1);
    assert.equal(servicePending.elicitations[0].message, "Confirm service write?");
    await post(base, token, "/api/elicitations/respond", {
      hqSessionId: s1.id, elicitationId: servicePending.elicitations[0].elicitationId, action: "decline",
    });
    await waitForBusy(base, token, s1.id, false);
    const serviceHistory = await (await fetch(`${base}/api/history/sessions/${s1.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(serviceHistory.entries.at(-1).text, "decline", "Autopilot never fabricates service consent");

    // ask_user bridge
    const qStart = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "question-bridge" });
    assert.equal(qStart.status, 200);
    const pendingQ = await waitForPending(base, token, s1.id, "questions", 1);
    assert.equal(pendingQ.questions.length, 1);
    await post(base, token, "/api/questions/respond", { hqSessionId: s1.id, questionId: pendingQ.questions[0].questionId, answer: "A" });
    await waitForBusy(base, token, s1.id, false);
    const afterChoiceHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    const answeredChoice = afterChoiceHistory.entries.find(entry => entry.role === "question" && entry.questionId === pendingQ.questions[0].questionId);
    assert.equal(answeredChoice.role, "question");
    assert.equal(answeredChoice.prompt, "Choose");
    assert.deepEqual(answeredChoice.choices, ["A", "B"]);
    assert.equal(answeredChoice.answer, "A");
    const lastChoiceAssistant = [...afterChoiceHistory.entries].reverse().find(entry => entry.role === "assistant");
    assert.equal(lastChoiceAssistant.text, "answer:A|freeform:false");

    const qStartFreeform = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "question-bridge" });
    assert.equal(qStartFreeform.status, 200);
    const pendingQFreeform = await waitForPending(base, token, s1.id, "questions", 1);
    await post(base, token, "/api/questions/respond", { hqSessionId: s1.id, questionId: pendingQFreeform.questions[0].questionId, answer: "C" });
    await waitForBusy(base, token, s1.id, false);
    const afterFreeformHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    const lastFreeformAssistant = [...afterFreeformHistory.entries].reverse().find(entry => entry.role === "assistant");
    assert.equal(lastFreeformAssistant.text, "answer:C|freeform:true");

    const sFail = await createSession(base, token);
    const qStartFail = await post(base, token, "/api/chat", { hqSessionId: sFail.id, mode: "interactive", message: "question-bridge-delayed" });
    assert.equal(qStartFail.status, 200);
    const pendingQFail = await waitForPending(base, token, sFail.id, "questions", 1);
    const questionFailLockPath = path.join(tmp, "history", "locks", `${sFail.id}.edit.lock`);
    await writeFile(questionFailLockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    const respondFail = await post(base, token, "/api/questions/respond", { hqSessionId: sFail.id, questionId: pendingQFail.questions[0].questionId, answer: "B" });
    assert.equal(respondFail.status, 200);
    const respondFailBody = await respondFail.json();
    assert.equal(respondFailBody.ok, true);
    assert.equal(respondFailBody.persisted, false);
    await unlink(questionFailLockPath).catch(() => {});
    await waitForBusy(base, token, sFail.id, false, 12000);
    const failPending = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(sFail.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(failPending.questions.length, 0);
    const afterFailHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(sFail.id)}`, { headers: { "X-DM-Token": token } })).json();
    const lastFailAssistant = [...afterFailHistory.entries].reverse().find(entry => entry.role === "assistant");
    assert.equal(lastFailAssistant.text, "answer:B|freeform:false");

    // send admission should not auto-finish before idle
    const admitted = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "admission-delay" });
    assert.equal(admitted.status, 200);
    await waitForBusy(base, token, s1.id, true);
    await new Promise(r => setTimeout(r, 100));
    const mid = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(mid.busy, true);
    await waitForBusy(base, token, s1.id, false, 3000);

    const delegated = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "subagent-finishes-first" });
    assert.equal(delegated.status, 200);
    await new Promise(r => setTimeout(r, 100));
    const duringDelegation = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(duringDelegation.busy, true);
    await waitForBusy(base, token, s1.id, false, 3000);
    const delegatedHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(delegatedHistory.entries.at(-1).text, "Michael final reply");
    assert.ok(!delegatedHistory.entries.at(-1).error);

    // session.error should finish and unlock run
    const er1 = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "session-error" });
    assert.equal(er1.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const er2 = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(er2.status, 200);
    await waitForBusy(base, token, s1.id, false);

    // late callback after finish should be ignored/rejected without pending UI
    const late = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "late-permission-after-idle" });
    assert.equal(late.status, 200);
    await waitForBusy(base, token, s1.id, false);
    const latePending = await (await fetch(`${base}/api/pending?hqSessionId=${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(latePending.approvals.length, 0);

    // concurrent distinct sessions
    await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "slow-run" });
    await waitForBusy(base, token, s1.id, true);
    await post(base, token, "/api/chat", { hqSessionId: s2.id, mode: "interactive", message: "slow-run" });
    await waitForBusy(base, token, s2.id, true);

    // same-session conflict
    const conflict = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "slow-run again" });
    assert.equal(conflict.status, 409);

    // stop one, other still busy
    await post(base, token, "/api/stop", { hqSessionId: s1.id });
    await waitForBusy(base, token, s1.id, false);
    const st2 = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(s2.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(st2.busy, true);
    await post(base, token, "/api/stop", { hqSessionId: s2.id });
    await waitForBusy(base, token, s2.id, false);

    // explicit startup/no-assistant error visible
    const s3 = await createSession(base, token);
    const rr = await post(base, token, "/api/chat", { hqSessionId: s3.id, mode: "interactive", message: "fail-no-response" });
    assert.equal(rr.status, 200);
    await waitForBusy(base, token, s3.id, false);
    const hist = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s3.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.ok(hist.entries.some(e => e.role === "assistant" && e.error));
    const createsBeforeResumeFail = sdkStore.createConfigs.length;
    FORCE_RESUME_MISSING = true;
    const resumeFailExisting = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(resumeFailExisting.status, 200);
    await waitForBusy(base, token, s1.id, false);
    assert.equal(sdkStore.createConfigs.length, createsBeforeResumeFail);
    const resumeFailHistory = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s1.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.ok(String(resumeFailHistory.entries.at(-1)?.error || "").toLowerCase().includes("missing"));
    const newOnlyUser = await createSession(base, token);
    const resumeFailNew = await post(base, token, "/api/chat", { hqSessionId: newOnlyUser.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(resumeFailNew.status, 200);
    await waitForBusy(base, token, newOnlyUser.id, false);
    FORCE_RESUME_MISSING = false;

    const retrySession = await createSession(base, token);
    FAIL_NEXT_CREATE = true;
    await post(base, token, "/api/chat", { hqSessionId: retrySession.id, mode: "interactive", message: "simple-question-test" });
    await waitForBusy(base, token, retrySession.id, false);
    const failedCreate = await (await fetch(`${base}/api/history/sessions/${retrySession.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.match(failedCreate.entries.at(-1).error, /temporary create failure/);
    await post(base, token, "/api/chat", { hqSessionId: retrySession.id, mode: "interactive", message: "simple-question-test" });
    await waitForBusy(base, token, retrySession.id, false);
    const retried = await (await fetch(`${base}/api/history/sessions/${retrySession.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(retried.entries.at(-1).text, "ok");

    await post(base, token, "/api/chat", { hqSessionId: retrySession.id, mode: "interactive", message: "managed-read-gate" });
    const managedRead = await waitForPending(base, token, retrySession.id, "approvals");
    await post(base, token, "/api/approvals/respond", { hqSessionId: retrySession.id, approvalId: managedRead.approvals[0].approvalId, decision: "deny" });
    await waitForBusy(base, token, retrySession.id, false);
    await post(base, token, "/api/chat", { hqSessionId: retrySession.id, mode: "plan", message: "managed-read-gate" });
    await waitForBusy(base, token, retrySession.id, false);
    const managedPlan = await (await fetch(`${base}/api/history/sessions/${retrySession.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(managedPlan.entries.at(-1).text, "reject");

    // SDK create/resume configs carry custom agents + AGENTS.md system prompt
    assert.ok(sdkStore.createConfigs.length >= 1);
    const firstCreate = sdkStore.createConfigs[0];
    assert.ok(Array.isArray(firstCreate.customAgents));
    assert.ok(firstCreate.customAgents.some(a => a.name === "regional-manager"));
    assert.ok(firstCreate.systemMessage?.content?.includes("Dunder Mifflin HQ"));
    assert.ok(sdkStore.resumeConfigs.length >= 1);
    assert.ok(sdkStore.resumeConfigs[0].customAgents.some(a => a.name === "automation-engineer"));

    // stale edit lock recovered by dead PID cleanup
    const staleSession = await createSession(base, token);
    const staleLockPath = path.join(tmp, "history", "locks", `${staleSession.id}.edit.lock`);
    await writeFile(staleLockPath, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), "utf8");
    const staleRun = await post(base, token, "/api/chat", { hqSessionId: staleSession.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(staleRun.status, 200);
    await waitForBusy(base, token, staleSession.id, false);

    // startRun failure after live start should cleanup snapshot/run state
    const failStartSession = await createSession(base, token);
    const failLockPath = path.join(tmp, "history", "locks", `${failStartSession.id}.edit.lock`);
    await writeFile(failLockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    const failed = await post(base, token, "/api/chat", { hqSessionId: failStartSession.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(failed.status, 500);
    const failStatus = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(failStartSession.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(failStatus.busy, false);
  } finally {
    try {
      const status = await (await fetch(`${base}/api/status`, { headers: { "X-DM-Token": token } })).json();
      for (const sid of status.activeSessions || []) {
        await post(base, token, "/api/stop", { hqSessionId: sid });
      }
    } catch {
      // best-effort cleanup
    }
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("mode transitions keep same SDK session id", async () => {
  const store = { createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "transition-token";
  const port = 4551;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const s = await createSession(base, token);
    for (const mode of ["plan", "interactive", "autopilot", "plan"]) {
      const rr = await post(base, token, "/api/chat", { hqSessionId: s.id, mode, message: "simple-question-test" });
      assert.equal(rr.status, 200);
      await waitForBusy(base, token, s.id, false);
    }
    const h = await (await fetch(`${base}/api/history/sessions/${encodeURIComponent(s.id)}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(h.copilotSessionId, s.copilotSessionId);
    assert.ok(store.createConfigs.length >= 1);
    assert.ok(store.resumeConfigs.length >= 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("sdk clients are cached by target context", async () => {
  const store = { createConfigs: [], resumeConfigs: [], targets: [] };
  setSdkClientFactoryForTests((target) => {
    store.targets.push({ ...(target || {}) });
    return new MockClient(store);
  });
  const token = "target-token";
  const port = 4552;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const subA = "11111111-1111-4111-8111-111111111111";
  const subB = "22222222-2222-4222-8222-222222222222";
  const oldCfgDir = process.env.DM_AZURE_CONFIG_DIR;
  process.env.DM_AZURE_CONFIG_DIR = path.join(tmp, "azure-cfg-mock");
  try {
    const s1 = await createSession(base, token);
    const s2 = await createSession(base, token);
    let rr = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "simple-question-test", subscription: subA, resourceGroup: "rg-a" });
    assert.equal(rr.status, 200);
    await waitForBusy(base, token, s1.id, false);
    rr = await post(base, token, "/api/chat", { hqSessionId: s1.id, mode: "interactive", message: "simple-question-test", subscription: subA, resourceGroup: "rg-a" });
    assert.equal(rr.status, 200);
    await waitForBusy(base, token, s1.id, false);
    rr = await post(base, token, "/api/chat", { hqSessionId: s2.id, mode: "interactive", message: "simple-question-test", subscription: subB, resourceGroup: "rg-b" });
    assert.equal(rr.status, 200);
    await waitForBusy(base, token, s2.id, false);
    assert.ok(store.targets.length >= 2);
    const targetA = store.targets.find(t => t.subscription === subA && t.resourceGroup === "rg-a");
    const targetB = store.targets.find(t => t.subscription === subB && t.resourceGroup === "rg-b");
    assert.ok(targetA, "target A client should be cached");
    assert.ok(targetB, "target B client should be cached");
    assert.equal(targetA.azureConfigDir, process.env.DM_AZURE_CONFIG_DIR);
    assert.equal(targetB.azureConfigDir, process.env.DM_AZURE_CONFIG_DIR);
    assert.ok(typeof targetA.workingDirectory === "string" && targetA.workingDirectory.length > 1);
    assert.ok(typeof targetB.workingDirectory === "string" && targetB.workingDirectory.length > 1);
  } finally {
    if (oldCfgDir === undefined) delete process.env.DM_AZURE_CONFIG_DIR;
    else process.env.DM_AZURE_CONFIG_DIR = oldCfgDir;
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("server shutdown stops sdk clients", async () => {
  const store = { stopCount: 0 };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "shutdown-token";
  const port = 4553;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const s = await createSession(base, token);
    const rr = await post(base, token, "/api/chat", { hqSessionId: s.id, mode: "interactive", message: "simple-question-test" });
    assert.equal(rr.status, 200);
    await waitForBusy(base, token, s.id, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    await new Promise(r => setTimeout(r, 25));
    assert.equal(store.stopCount, 1);
    setSdkClientFactoryForTests(null);
  }
});

test("rewards: Toby verdicts land in the ledger and chat feedback feeds the Dundies", async () => {
  const store = { createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "test-token";
  const port = 4554;
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const get = async p => (await fetch(`${base}${p}`, { headers: { "X-DM-Token": token } })).json();
  try {
    const s = await createSession(base, token);
    assert.equal((await post(base, token, "/api/chat", { hqSessionId: s.id, mode: "interactive", message: "toby-review-run" })).status, 200);
    await waitForBusy(base, token, s.id, false);
    const entry = (await get(`/api/history/sessions/${s.id}`)).entries.findLast(e => e.role === "assistant");
    assert.ok(entry.runId, "assistant entries carry the runId the feedback bar needs");
    assert.deepEqual(entry.feedback.toby, { verdict: "approved", for: ["product-manager"] });
    assert.deepEqual([...entry.feedback.agents].sort(), ["compliance-officer", "product-manager", "regional-manager"]);
    assert.equal(entry.feedback.rating, null);

    let r = await post(base, token, "/api/feedback", { hqSessionId: s.id, runId: entry.runId, rating: "up", usedAsWritten: true });
    assert.equal(r.status, 200);
    const fb = await r.json();
    assert.equal(fb.rating, "up");
    assert.equal(fb.usedAsWritten, true);
    assert.equal((await get(`/api/history/sessions/${s.id}`)).entries.findLast(e => e.role === "assistant").feedback.rating, "up");

    const ledger = JSON.parse(await readFile(path.join(tmp, "rewards", "ledger.json"), "utf8"));
    assert.ok(!JSON.stringify(ledger).includes("Ideas ready"), "the ledger stores ids and flags, never message text");

    const report = await get("/api/rewards");
    const ryan = report.scorecard.find(a => a.id === "product-manager");
    assert.equal(ryan.approved, 1);
    assert.equal(ryan.up, 1);
    assert.equal(report.scorecard.find(a => a.id === "compliance-officer")?.approved || 0, 0, "Toby never scores his own verdict");
    assert.ok(Array.isArray(report.awards));

    assert.equal((await post(base, token, "/api/feedback", { hqSessionId: s.id, runId: entry.runId, rating: "meh" })).status, 400);
    assert.equal((await post(base, token, "/api/feedback", { hqSessionId: "../x", runId: entry.runId, rating: "up" })).status, 400);
    assert.equal((await post(base, token, "/api/feedback", { hqSessionId: s.id, runId: "00000000-0000-4000-8000-000000000000", rating: "up" })).status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});
