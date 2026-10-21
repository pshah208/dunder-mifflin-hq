import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";

const originalData = process.env.DM_DATA_DIR;
const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-study-"));
process.env.DM_DATA_DIR = tmp;
process.env.DM_DISABLE_AZURE_DISCOVERY = "1";

const { createServer, setSdkClientFactoryForTests, setAzTokenRunnerForTests } = await import("../server.mjs");
setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });
const {
  DEFAULT_STUDY_SETTINGS, validateStudySettings, pickStudents, studyIsDue, buildStudyMessage, parseStudyNotes, mergeStudyNotes,
  isAllowedStudyUrl, studyPermissionDecision,
} = await import("../persona-study.mjs");

test.after(async () => {
  if (originalData === undefined) delete process.env.DM_DATA_DIR; else process.env.DM_DATA_DIR = originalData;
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const block = arr => "What a day of learning.\n```persona-notes-json\n" + JSON.stringify(arr) + "\n```";

test("settings validation: defaults, ranges", () => {
  assert.deepEqual(validateStudySettings(null), { ...DEFAULT_STUDY_SETTINGS });
  assert.equal(validateStudySettings({ enabled: false }).enabled, false);
  assert.throws(() => validateStudySettings({ perRun: 9 }), /perRun/);
  assert.throws(() => validateStudySettings({ hour: 24 }), /hour/);
});

test("pickStudents rotates: never-studied first, then stalest, roster order on ties", () => {
  const ids = ["a", "b", "c", "d"];
  const notes = { a: { updatedAt: "2026-10-10T00:00:00Z" }, c: { updatedAt: "2026-10-01T00:00:00Z" } };
  assert.deepEqual(pickStudents(ids, notes, 3), ["b", "d", "c"]);
  assert.deepEqual(pickStudents(ids, {}, 2), ["a", "b"]);
});

test("studyIsDue only when enabled, after the slot, not yet run, and the team is free", () => {
  const s = { enabled: true, hour: 15, minute: 0 };
  const after = new Date(2026, 9, 18, 16, 0).getTime();
  const slot = studyIsDue({ now: after, settings: s, lastSlotIso: null, busy: false });
  assert.ok(slot);
  assert.equal(studyIsDue({ now: after, settings: s, lastSlotIso: slot.toISOString(), busy: false }), null);
  assert.equal(studyIsDue({ now: after, settings: s, lastSlotIso: null, busy: true }), null);
  assert.equal(studyIsDue({ now: new Date(2026, 9, 18, 14, 0).getTime(), settings: s, lastSlotIso: null, busy: false }), null);
  assert.equal(studyIsDue({ now: after, settings: { ...s, enabled: false }, lastSlotIso: null, busy: false }), null);
});

test("parseStudyNotes: known students only, sources required and public, lengths capped, dedupe", () => {
  const known = new Set(["sales-lead", "summarizer"]);
  const { notes, error } = parseStudyNotes(block([
    { agent: "sales-lead", summary: "Intense, rule-loving salesman.", traits: ["Loyal", "Loyal", "x".repeat(300)], quips: ["Preparedness is a lifestyle."], sources: [{ title: "Wiki", url: "https://example.org/dwight" }, { url: "http://localhost/x" }, { url: "http://10.0.0.5/x" }, { url: "javascript:alert(1)" }] },
    { agent: "summarizer", summary: "No sources", traits: ["Hungry"], sources: [] },
    { agent: "qa-reviewer", summary: "Not a student", sources: [{ url: "https://example.org/creed" }] },
    { agent: "sales-lead", summary: "duplicate", sources: [{ url: "https://example.org/dup" }] },
  ]), known);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(notes), ["sales-lead"]);
  const d = notes["sales-lead"];
  assert.equal(d.summary, "Intense, rule-loving salesman.");
  assert.equal(d.traits.length, 2);
  assert.equal(d.traits[1].length, 140);
  assert.deepEqual(d.sources.map(s => s.url), ["https://example.org/dwight"]);
  assert.match(parseStudyNotes("no block", known).error, /no persona-notes-json/);
  assert.match(parseStudyNotes("```persona-notes-json\n{bad\n```", known).error, /malformed/);
});

test("mergeStudyNotes stamps time, run and study count; message lists students from The Office", () => {
  const a = mergeStudyNotes({}, { x: { summary: "s" } }, "2026-10-18T00:00:00.000Z", "r1");
  const b = mergeStudyNotes(a, { x: { summary: "t" } }, "2026-10-19T00:00:00.000Z", "r2");
  assert.equal(b.x.studies, 2); assert.equal(b.x.runId, "r2"); assert.equal(b.x.summary, "t");
  assert.match(buildStudyMessage("PLAY", ["x"], { x: { persona: "Dwight Schrute", show: "The Office" } }), /- x: Dwight Schrute from "The Office"/);
});

test("study runs may only read and fetch public web pages: no connectors, shell, writes or private hosts", () => {
  assert.equal(isAllowedStudyUrl("https://theoffice.fandom.com/wiki/Dwight_Schrute").allowed, true);
  for (const bad of ["http://localhost:4343/api/team", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://192.168.1.4/", "http://[::1]/", "https://user:pw@example.org/", "file:///C:/secrets.txt", "http://intranet.internal/"])
    assert.equal(isAllowedStudyUrl(bad).allowed, false, bad);
  assert.equal(studyPermissionDecision({ kind: "url", url: "https://en.wikipedia.org/wiki/The_Office" }).kind, "approve-once");
  assert.equal(studyPermissionDecision({ kind: "url", url: "http://localhost/" }).kind, "reject");
  assert.equal(studyPermissionDecision({ kind: "read" }).kind, "approve-once");
  for (const r of [{ kind: "mcp", serverName: "workiq", toolName: "ask", readOnly: true }, { kind: "mcp", serverName: "msx", toolName: "get_milestones" }, { kind: "shell" }, { kind: "write" }, { kind: "custom-tool" }, { kind: "read", managedApprovalRequired: true }])
    assert.equal(studyPermissionDecision(r).kind, "reject", JSON.stringify(r));
});

class MockSession {
  constructor(cfg, store) { this.cfg = cfg; this.store = store; store.configs.push(cfg); }
  async send({ prompt }) {
    this.store.prompts.push(prompt);
    const emit = (type, data = {}) => this.cfg.onEvent?.({ type, data });
    setTimeout(() => {
      emit("assistant.message", { messageId: "m", content: block([
        { agent: "sales-lead", summary: "Intense.", traits: ["Loyal"], quips: ["Preparedness is a lifestyle."], sources: [{ url: "https://example.org/dwight" }] },
        { agent: "regional-manager", summary: "Not requested; must be ignored.", sources: [{ url: "https://example.org/michael" }] },
      ]) });
      emit("session.idle", {});
    }, 20);
    return "u";
  }
  async abort() {}
  async disconnect() {}
}
class MockClient {
  constructor(store) { this.store = store; }
  async listModels() { return []; }
  async resumeSession() { throw new Error("missing"); }
  async createSession(cfg) { return new MockSession(cfg, this.store); }
  async stop() {}
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

test("manual study run: unattended plan-mode study, no connectors, notes saved for requested students only, hidden kind", async () => {
  const store = { prompts: [], configs: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "study-token";
  const port = await freePort();
  const { server } = createServer({ port, token, enableStudyScheduler: false });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const call = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { "Content-Type": "application/json", "X-DM-Token": token } });
  try {
    const started = await call("/api/personas/study", { method: "POST", body: JSON.stringify({ agents: ["sales-lead", "not-an-agent"] }) });
    assert.equal(started.status, 200);
    const s = await started.json();
    assert.deepEqual(s.students, ["sales-lead"]);
    assert.equal((await call("/api/personas/study", { method: "POST", body: "{}" })).status, 409); // one study at a time
    let notes = {};
    for (let i = 0; i < 80 && !notes["sales-lead"]; i++) {
      await new Promise(r => setTimeout(r, 25));
      notes = (await (await call("/api/personas/notes")).json()).notes;
    }
    assert.equal(notes["sales-lead"].quips[0], "Preparedness is a lifestyle.");
    assert.equal(notes["regional-manager"], undefined);
    assert.match(store.prompts[0], /\[STUDENTS\][\s\S]*sales-lead: Dwight Schrute from "The Office"/);
    assert.match(store.prompts[0], /character study\)\. Nobody is watching: never call ask_user/);
    assert.ok(!/\[CONNECTORS\]/.test(store.prompts[0]), "no connector block in a study prompt");
    const cfg = store.configs[0];
    assert.ok(!cfg.mcpServers, "no MCP connectors attached to a study session");
    assert.equal(typeof cfg.onUserInputRequest, "undefined", "nobody to answer questions");
    assert.equal((await cfg.onPermissionRequest({ kind: "mcp", serverName: "workiq", toolName: "ask", readOnly: true })).kind, "reject");
    assert.equal((await cfg.onPermissionRequest({ kind: "shell", fullCommandText: "dir" })).kind, "reject");
    const sessions = await (await call("/api/history/sessions")).json();
    assert.equal(sessions.find(x => x.id === s.hqSessionId).kind, "study");
    const saved = JSON.parse(await readFile(path.join(tmp, "personas", "notes.json"), "utf8"));
    assert.equal(saved["sales-lead"].studies, 1);
    let last;
    for (let i = 0; i < 80; i++) {
      last = (await (await call("/api/personas/notes")).json()).lastRun;
      if (last.state !== "running") break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(last.state, "completed"); assert.equal(last.learned, 1);
    assert.equal((await call("/api/personas/settings", { method: "PUT", body: JSON.stringify({ enabled: false, hour: 9, minute: 30, perRun: 2 }) })).status, 200);
    assert.deepEqual((await (await call("/api/personas/notes")).json()).settings, { enabled: false, hour: 9, minute: 30, perRun: 2 });
    assert.equal((await call("/api/personas/settings", { method: "PUT", body: JSON.stringify({ perRun: 0 }) })).status, 400);
    // a corrupt settings file fails closed (never silently re-enables paid studies)
    await writeFile(path.join(tmp, "personas", "settings.json"), "{not json", "utf8");
    assert.equal((await (await call("/api/personas/notes")).json()).settings.enabled, false);
    await writeFile(path.join(tmp, "personas", "settings.json"), JSON.stringify({ perRun: 99 }), "utf8");
    assert.equal((await (await call("/api/personas/notes")).json()).settings.enabled, false);
    // ordinary chats are still kind "chat"
    const chat = await (await call("/api/history/sessions", { method: "POST", body: "{}" })).json();
    assert.equal(chat.kind, "chat");
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});
