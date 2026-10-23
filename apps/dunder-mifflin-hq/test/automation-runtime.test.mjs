import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";

const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-automations-"));
process.env.DM_DATA_DIR = tmp;
process.env.DM_DISABLE_AZURE_DISCOVERY = "1";
const { createServer, setSdkClientFactoryForTests, setAzTokenRunnerForTests, triggerAutomationSchedulerTickForTests } = await import("../server.mjs");
setAzTokenRunnerForTests(async () => { throw new Error("Test: Azure CLI disabled"); });
const workflow = () => ({ name: "Synthetic briefing", description: "Test data only", mode: "plan", schedule: { type: "interval", minutes: 15 },
  timeoutMinutes: 1, steps: [{ title: "Summarize", agent: "summarizer", instruction: "Summarize synthetic text only.", condition: "" }], agentModels: {} });
const runtime = { configs: [], prompts: [], hold: false, write: false, answer: null };
class MockSession {
  constructor(config) { this.cfg = config; runtime.configs.push(config); }
  async send({ prompt }) {
    runtime.prompts.push(prompt);
    const emit = (type, data = {}) => this.cfg.onEvent({ type, data });
    this.emit = emit;
    if (runtime.hold) { emit("subagent.started", { agentName: "summarizer", toolCallId: "a1" }); return; }
    setTimeout(async () => {
      if (runtime.write) await this.cfg.onPermissionRequest({ kind: "mcp", serverName: "workiq", toolName: "create_entity", readOnly: false });
      const content = runtime.answer ?? (prompt.includes("[AUTOMATION BUILDER]")
        ? "```automation-json\n" + JSON.stringify(workflow()) + "\n```"
        : "Synthetic result.\nAUTOMATION STATUS: COMPLETED");
      emit("assistant.message", { messageId: "m1", content, toolRequests: [] });
      emit("session.idle");
    }, 15);
  }
  async disconnect() {}
  async abort() { this.emit?.("session.idle"); }
}
class MockClient {
  async listModels() { return [{ id: "test-model", policy: { state: "enabled" } }]; }
  async resumeSession() { throw new Error("missing"); }
  async createSession(config) { return new MockSession(config); }
  async stop() {}
}
setSdkClientFactoryForTests(() => new MockClient());
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const token = "automation-test";
const { server } = createServer({ port, token, enableStudyScheduler: false, enableAutomationScheduler: true });
await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
async function call(route, method = "GET", body) {
  const response = await fetch(base + route, { method, headers: { "X-DM-Token": token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail("Timed out waiting for automation");
}
const completed = id => waitFor(async () => (await call("/api/automations")).data.runs.find(r => r.id === id && r.state !== "running"));
test.after(async () => {
  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
});

test("builder produces a disabled, validated draft with no connectors or permissions", async () => {
  assert.equal((await fetch(base + "/api/automations")).status, 401);
  const page = await (await fetch(base + "/automations.html")).text();
  assert.ok(page.includes(token)); assert.ok(!page.includes("__DM_TOKEN__"));
  assert.equal((await call("/api/automations/build", "POST", {})).status, 400);
  const response = await call("/api/automations/build", "POST", { request: "Design a synthetic briefing." });
  assert.equal(response.status, 202);
  const run = await completed(response.data.runId);
  assert.equal(run.state, "completed"); assert.ok(run.draftId);
  const cfg = runtime.configs.at(-1);
  assert.equal(cfg.mcpServers, undefined);
  assert.equal(cfg.onUserInputRequest, undefined);
  assert.equal((await cfg.onPermissionRequest({ kind: "read" })).kind, "reject");
  assert.match(runtime.prompts.at(-1), /delegate this design to product-manager/);
  const def = (await call("/api/automations")).data.definitions.find(d => d.id === run.draftId);
  assert.equal(def.enabled, false);
});
test("test, enable, scheduler execution and version invalidation reuse normal history", async () => {
  const def = (await call("/api/automations", "POST", workflow())).data;
  assert.equal((await call(`/api/automations/${def.id}/enabled`, "POST", { revision: 1, enabled: true })).status, 400);
  const response = await call(`/api/automations/${def.id}/run`, "POST", { revision: 1, test: true });
  assert.equal(response.status, 202); assert.equal((await completed(response.data.runId)).state, "completed");
  const cfg = runtime.configs.at(-1);
  assert.ok(cfg.mcpServers?.workiq); assert.equal(cfg.onUserInputRequest, undefined);
  assert.ok(cfg.customAgents.every(a => !a.model || a.model === "test-model"), "default-model runs must sanitize unavailable specialist defaults using the enabled catalog");
  const history = (await call(`/api/history/sessions/${response.data.hqSessionId}`)).data;
  assert.equal(history.kind, "automation"); assert.match(history.entries.at(-1).text, /Synthetic result/);
  assert.equal((await call(`/api/automations/${def.id}/enabled`, "POST", { revision: 1, enabled: true })).status, 200);
  const storeFile = path.join(tmp, "automations", "store.json");
  const raw = JSON.parse(await readFile(storeFile, "utf8"));
  raw.definitions.find(d => d.id === def.id).nextRunAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(storeFile, JSON.stringify(raw));
  await triggerAutomationSchedulerTickForTests();
  const scheduled = await waitFor(async () => (await call("/api/automations")).data.runs.find(r => r.automationId === def.id && r.trigger === "schedule"));
  assert.equal((await completed(scheduled.id)).state, "completed");
  const updated = await call(`/api/automations/${def.id}`, "PUT", { ...workflow(), revision: 1 });
  assert.equal(updated.data.revision, 2); assert.equal(updated.data.enabled, false);
  assert.equal((await call(`/api/automations/${def.id}/run`, "POST", { revision: 1 })).status, 409);
});
test("denied tools cannot be masked as a successful automation test", async () => {
  runtime.write = true;
  try {
    const def = (await call("/api/automations", "POST", workflow())).data;
    const response = await call(`/api/automations/${def.id}/run`, "POST", { revision: 1, test: true });
    const run = await completed(response.data.runId);
    assert.equal(run.state, "failed"); assert.match(run.error, /denied/);
    assert.equal((await call(`/api/automations/${def.id}/enabled`, "POST", { revision: 1, enabled: true })).status, 400);
  } finally { runtime.write = false; }
});
test("interactive automation writes keep approval cards; stopping held work pauses it", async () => {
  runtime.write = true;
  const def = (await call("/api/automations", "POST", { ...workflow(), mode: "interactive", schedule: { type: "manual" } })).data;
  try {
    const response = await call(`/api/automations/${def.id}/run`, "POST", { revision: 1 });
    const approval = await waitFor(async () => (await call(`/api/pending?hqSessionId=${response.data.hqSessionId}`)).data.approvals[0]);
    await call("/api/approvals/respond", "POST", { hqSessionId: response.data.hqSessionId, approvalId: approval.approvalId, decision: "deny" });
    assert.equal((await completed(response.data.runId)).state, "failed");
  } finally { runtime.write = false; }
  runtime.hold = true;
  try {
    const response = await call(`/api/automations/${def.id}/run`, "POST", { revision: 1 });
    assert.equal((await call(`/api/automations/${def.id}/run`, "POST", { revision: 1 })).status, 409);
    assert.equal((await call(`/api/automations/${def.id}`, "DELETE", { revision: 1 })).status, 409);
    await waitFor(async () => (await call("/api/status")).data.activeCount > 0);
    const stopped = await call(`/api/automations/${response.data.runId}/stop`, "POST", {});
    assert.equal(stopped.status, 200);
    assert.equal((await completed(response.data.runId)).state, "failed");
  } finally { runtime.hold = false; }
});
test("a one-minute automation deadline fails held work instead of leaving it running", { timeout: 75000 }, async () => {
  runtime.hold = true;
  try {
    const def = (await call("/api/automations", "POST", workflow())).data;
    const response = await call(`/api/automations/${def.id}/run`, "POST", { revision: 1 });
    const started = Date.now();
    let record;
    while (Date.now() - started < 68000) {
      record = (await call("/api/automations")).data.runs.find(r => r.id === response.data.runId);
      if (record.state !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(record.state, "failed");
    assert.match(record.error, /time limit exceeded/);
    assert.ok(Date.now() - started >= 59000, "one-minute deadline must not fire early");
    assert.equal((await call("/api/status")).data.activeCount, 0);
  } finally { runtime.hold = false; }
});
test("Edge supports form editing, reordering, saved drafts, testing, enabling, run links and navigation", {
  skip: process.env.DM_TEST_EDGE !== "1", timeout: 90000,
}, async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", dialog => dialog.accept());
    await page.goto(base + "/automations.html");
    await page.waitForFunction(() => document.querySelector("#modelStatus").textContent.startsWith("Blank means"));
    await page.getByRole("button", { name: "Morning briefing", exact: true }).click();
    await page.locator("#workflowName").fill("Browser workflow");
    const steps = page.locator(".automation-step");
    await steps.nth(1).getByRole("button", { name: "Up", exact: true }).click();
    assert.equal(await steps.nth(0).locator('[data-field="title"]').inputValue(), "Upcoming milestones");
    await page.locator("#saveWorkflow").click();
    await page.waitForFunction(() => document.querySelector("#saveState").textContent.startsWith("Revision"));
    assert.equal(await page.locator("#error").isVisible(), false);
    assert.equal(await page.locator("#toggleSchedule").isDisabled(), true);
    await page.locator("#testWorkflow").click();
    await page.waitForFunction(() => !document.querySelector("#toggleSchedule").disabled);
    await page.locator("#toggleSchedule").click();
    await page.waitForFunction(() => document.querySelector("#toggleSchedule").textContent === "Pause schedule");
    await page.locator("#workflowDescription").fill("Editing pauses until retested.");
    assert.equal(await page.locator("#runWorkflow").isDisabled(), true);
    await page.locator("#saveWorkflow").click();
    await page.waitForFunction(() => document.querySelector("#saveState").textContent.startsWith("Revision 2"));
    assert.equal(await page.locator("#toggleSchedule").isDisabled(), true);
    assert.ok(await page.getByRole("link", { name: "Open run", exact: true }).count() > 0);
    await page.locator("#buildRequest").fill("Build a synthetic read-only briefing.");
    await page.locator("#buildButton").click();
    await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("draft is ready"));
    assert.ok(await page.getByRole("button", { name: "Review draft", exact: true }).count() > 0);
    await page.getByRole("link", { name: "Office", exact: true }).click();
    await page.getByRole("link", { name: "Automations", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
