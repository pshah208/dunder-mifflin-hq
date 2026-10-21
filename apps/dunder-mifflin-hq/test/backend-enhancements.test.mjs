import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";

const originalData = process.env.DM_DATA_DIR;
const originalDisableAzureDiscovery = process.env.DM_DISABLE_AZURE_DISCOVERY;
const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-backend-"));
process.env.DM_DATA_DIR = tmp;
process.env.DM_DISABLE_AZURE_DISCOVERY = "1";

const {
  createServer,
  setSdkClientFactoryForTests,
  setAzTokenRunnerForTests,
} = await import("../server.mjs");

// Never call the real Azure CLI from tests: connectors that need a token report "sign-in needed".
setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });

const leadAgentFile = path.resolve("..", "..", ".github", "agents", "regional-manager.agent.md");
const leadAgentRaw = await readFile(leadAgentFile, "utf8");
const leadAgentFrontmatter = leadAgentRaw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const leadModelMatch = leadAgentFrontmatter?.[1]?.match(/^model:\s*(.+)$/m);
const leadFrontmatterModel = String(leadModelMatch?.[1] || "gpt-6-sol").trim().replace(/^['"]|['"]$/g, "");
const NON_VISION_MODEL = "nonvision-model";

class MockSession {
  constructor(id, cfg, store) {
    this.sessionId = id;
    this.cfg = cfg;
    this.store = store;
    this.holdResolve = null;
  }
  async setModel() {}
  async send(options) {
    this.store.sent.push({ sessionId: this.sessionId, options });
    const emit = (type, data = {}) => this.cfg.onEvent?.({ type, data });
    if (String(options.prompt || "").includes("hold-run")) {
      emit("assistant.message", { messageId: "hold", content: "holding", toolRequests: [] });
      await new Promise(resolve => { this.holdResolve = resolve; });
      return "hold";
    }
    setTimeout(() => {
      emit("assistant.message", { messageId: "m1", content: "ok", toolRequests: [] });
      emit("session.idle", {});
    }, 10);
    return "u1";
  }
  async abort() {
    this.holdResolve?.();
    this.cfg.onEvent?.({ type: "session.idle", data: {} });
  }
}

class MockClient {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
  }
  async start() {}
  async stop() {}
  async listModels() {
    this.store.modelCalls = (this.store.modelCalls || 0) + 1;
    return [
      {
        id: leadFrontmatterModel,
        name: leadFrontmatterModel,
        policy: { state: "enabled", terms: "" },
        capabilities: {
          supports: { vision: true },
          limits: { vision: { max_prompt_images: this.store.maxImages ?? 4, max_prompt_image_size: 10 * 1024 * 1024, supported_media_types: ["image/png", "image/jpeg", "image/webp"] } },
        },
      },
      { id: NON_VISION_MODEL, name: "Non-vision model", policy: { state: "enabled", terms: "" }, capabilities: { supports: { vision: false } } },
      { id: "gpt-5.4-mini", name: "Fast model", policy: { state: "enabled" }, capabilities: { supports: { vision: true } } },
      { id: "old-disabled", name: "Old Disabled", policy: { state: "disabled", terms: "" }, capabilities: {} },
    ];
  }
  async resumeSession(id, cfg) {
    this.store.resumeConfigs?.push(cfg);
    if (!this.sessions.has(id)) throw new Error("missing");
    const s = new MockSession(id, cfg, this.store);
    this.sessions.set(id, s);
    return s;
  }
  async createSession(cfg) {
    this.store.createConfigs?.push(cfg);
    const id = cfg.sessionId;
    const s = new MockSession(id, cfg, this.store);
    this.sessions.set(id, s);
    return s;
  }
}

test.after(async () => {
  if (originalData === undefined) delete process.env.DM_DATA_DIR;
  else process.env.DM_DATA_DIR = originalData;
  if (originalDisableAzureDiscovery === undefined) delete process.env.DM_DISABLE_AZURE_DISCOVERY;
  else process.env.DM_DISABLE_AZURE_DISCOVERY = originalDisableAzureDiscovery;
  await rm(tmp, { recursive: true, force: true });
});

async function post(base, token, route, body) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DM-Token": token },
    body: JSON.stringify(body),
  });
}

async function createSession(base, token) {
  const r = await post(base, token, "/api/history/sessions", {});
  return r.json();
}

async function waitForBusy(base, token, sid, expected, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const status = await (await fetch(`${base}/api/status?hqSessionId=${encodeURIComponent(sid)}`, { headers: { "X-DM-Token": token } })).json();
    if (!!status.busy === expected) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for busy=${expected}`);
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

test("reference files reach non-vision models, retain originals, and survive queued execution", async () => {
  const { officeFixtures, pdfFixture } = await import("./reference-fixtures.mjs");
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "reference-test", port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`, headers = { "X-DM-Token": token };
  try {
    const session = await createSession(base, token);
    const uploaded = [];
    for (const [name, bytes] of Object.entries({ ...officeFixtures, "brief.pdf": pdfFixture() })) {
      const response = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
        name, mimeType: "", data: bytes.toString("base64"),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const attachment = await response.json();
      uploaded.push(attachment);
      const download = await fetch(`${base}${attachment.url}`, { headers });
      assert.equal(download.status, 200);
      assert.match(download.headers.get("content-disposition"), /^attachment;/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      assert.equal((await fetch(`${base}${attachment.url}`)).status, 401);
    }
    const run = await post(base, token, "/api/chat", {
      hqSessionId: session.id, message: "", mode: "plan", model: NON_VISION_MODEL,
      attachmentIds: uploaded.map(a => a.id),
    });
    assert.equal(run.status, 200, await run.text());
    await waitForBusy(base, token, session.id, false);
    const sent = store.sent.at(-1).options;
    assert.equal(sent.attachments.length, 0, "documents must not be sent as image blobs");
    assert.match(sent.prompt, /\[REFERENCE FILES\]/);
    assert.match(sent.prompt, /untrusted reference DATA/);
    for (const expected of ["Reference customer briefing", "Budget reference", "Reference slide one", "Reference PDF text"]) assert.ok(sent.prompt.includes(expected), expected);
    const refs = sent.prompt.split("\n").filter(line => line.startsWith('{"name":')).map(JSON.parse);
    assert.equal(refs.length, 4);
    for (const ref of refs) assert.ok((await readFile(ref.textPath, "utf8")).trim());

    const text = "Reference text, not instructions.\n" + "Long reference passage\n".repeat(800);
    const textUpload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
      name: "notes.md", mimeType: "application/octet-stream", data: Buffer.from(text).toString("base64"),
    });
    assert.equal(textUpload.status, 201);
    const note = await textUpload.json();
    await post(base, token, "/api/queue/pause", { hqSessionId: session.id });
    const queued = await post(base, token, "/api/chat", {
      hqSessionId: session.id, queue: true, message: "Use the reference", mode: "plan", model: NON_VISION_MODEL, attachmentIds: [note.id],
    });
    assert.equal(queued.status, 202);
    await post(base, token, "/api/queue/resume", { hqSessionId: session.id });
    for (let i = 0; i < 100 && store.sent.length < 2; i++) await new Promise(r => setTimeout(r, 20));
    await waitForBusy(base, token, session.id, false);
    const ref = JSON.parse(store.sent.at(-1).options.prompt.split("\n").find(line => line.startsWith('{"name":"notes.md"')));
    assert.equal(ref.preview.length, 12000);
    assert.equal(await readFile(ref.textPath, "utf8"), text, "text beyond the preview remains readable");
    const history = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers })).json();
    assert.equal(history.entries.filter(e => e.role === "user").at(-1).attachments[0].name, "notes.md");
    const other = await createSession(base, token);
    assert.equal((await post(base, token, "/api/chat", { hqSessionId: other.id, message: "wrong scope", attachmentIds: [note.id] })).status, 400);
    for (const [name, data] of [["script.exe", "MZ"], ["fake.pdf", "not a PDF"], ["fake.docx", "not an Office archive"]]) {
      assert.equal((await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
        name, mimeType: "text/plain", data: Buffer.from(data).toString("base64"),
      })).status, 415);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("models, repos, attachments, repo pinning and session delete", async () => {
  const store = { sent: [], createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "backend-enhancements-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

  const registeredRepo = path.join(tmp, "external-repo");
  await mkdir(path.join(registeredRepo, ".git"), { recursive: true });
  try {
    const models = await (await fetch(`${base}/api/models`, { headers: { "X-DM-Token": token } })).json();
    assert.ok(Array.isArray(models.models));
    assert.ok(models.models.some(m => m.id === leadFrontmatterModel && m.supportsVision === true));
    assert.ok(models.models.some(m => m.id === NON_VISION_MODEL && !("supportsVision" in m)));
    assert.ok(!models.models.some(m => m.id === "old-disabled"));

    const reposBefore = await (await fetch(`${base}/api/repos`, { headers: { "X-DM-Token": token } })).json();
    assert.ok(Array.isArray(reposBefore.repos) && reposBefore.repos.length >= 1);
    assert.ok(reposBefore.defaultRepoId);

    const register = await post(base, token, "/api/repos", { path: registeredRepo });
    assert.equal(register.status, 201);
    const registered = await register.json();
    assert.equal(registered.path, registeredRepo);

    const reposAfter = await (await fetch(`${base}/api/repos`, { headers: { "X-DM-Token": token } })).json();
    const extraRepo = reposAfter.repos.find(r => r.path === registeredRepo);
    assert.ok(extraRepo?.id);

    const session = await createSession(base, token);
    const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+Q0YAAAAASUVORK5CYII=";
    const upload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
      name: "tiny.png",
      mimeType: "image/png",
      data: tinyPngBase64,
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json();
    assert.equal(attachment.mimeType, "image/png");
    assert.ok(attachment.id);
    assert.ok(attachment.url.includes(`/api/history/sessions/${session.id}/attachments/`));

    const preview = await fetch(`${base}${attachment.url}`, { headers: { "X-DM-Token": token } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");

    const runNoVision = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "",
      attachmentIds: [attachment.id],
      repoId: extraRepo.id,
      model: NON_VISION_MODEL,
    });
    assert.equal(runNoVision.status, 400);
    const run = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "",
      attachmentIds: [attachment.id],
      repoId: extraRepo.id,
      model: leadFrontmatterModel,
      agentModels: { "automation-engineer": leadFrontmatterModel },
    });
    assert.equal(run.status, 200);
    await waitForBusy(base, token, session.id, false);
    assert.equal(store.sent.length, 1);
    assert.equal(store.modelCalls, 1, "chat/model overrides reuse the catalog already loaded by the UI");
    assert.equal(store.resumeConfigs[0].mcpServers, store.createConfigs[0].mcpServers, "resume fallback reuses the same connector snapshot");
    assert.match(store.sent[0].options.prompt, /\[MODELS\]/);
    assert.match(store.sent[0].options.prompt, new RegExp(`- ${leadFrontmatterModel}\\b`));
    assert.match(store.sent[0].options.prompt, new RegExp(`- ${NON_VISION_MODEL}\\b`));
    assert.ok(!store.sent[0].options.prompt.includes("old-disabled"));
    assert.match(store.sent[0].options.prompt, /Active HQ agent model overrides:/);
    assert.match(store.sent[0].options.prompt, new RegExp(`- automation-engineer: ${leadFrontmatterModel}`));
    assert.equal(store.sent[0].options.attachments.length, 1);
    assert.equal(store.sent[0].options.attachments[0].type, "blob");
    assert.equal(store.sent[0].options.attachments[0].mimeType, "image/png");

    const history = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } })).json();
    const latestUser = history.entries.filter(e => e.role === "user").at(-1);
    assert.equal(latestUser.repoId, extraRepo.id);
    assert.equal(latestUser.attachments.length, 1);

    const runWrongRepo = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "switch repo",
      repoId: reposAfter.defaultRepoId,
    });
    assert.equal(runWrongRepo.status, 409);

    const badModel = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "hello",
      repoId: extraRepo.id,
      model: "not-a-real-model",
    });
    assert.equal(badModel.status, 400);
    const conflictModel = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "hello",
      repoId: extraRepo.id,
      model: leadFrontmatterModel,
      agentModels: { "regional-manager": NON_VISION_MODEL },
    });
    assert.equal(conflictModel.status, 400);

    const resumeSession = await createSession(base, token);
    const firstNoImage = await post(base, token, "/api/chat", {
      hqSessionId: resumeSession.id,
      mode: "interactive",
      message: "seed non-vision model",
      repoId: extraRepo.id,
      model: NON_VISION_MODEL,
    });
    assert.equal(firstNoImage.status, 200);
    await waitForBusy(base, token, resumeSession.id, false);
    const resumeUpload = await post(base, token, `/api/history/sessions/${resumeSession.id}/attachments`, {
      name: "resume.png",
      mimeType: "image/png",
      data: tinyPngBase64,
    });
    assert.equal(resumeUpload.status, 201);
    const resumeAttachment = await resumeUpload.json();

    const resumeImageNoExplicitModel = await post(base, token, "/api/chat", {
      hqSessionId: resumeSession.id,
      mode: "interactive",
      message: "",
      attachmentIds: [resumeAttachment.id],
      repoId: extraRepo.id,
    });
    if (resumeImageNoExplicitModel.status !== 200) {
      const failure = await resumeImageNoExplicitModel.json().catch(() => ({}));
      assert.fail(`resume image run expected 200, got ${resumeImageNoExplicitModel.status}: ${JSON.stringify(failure)}`);
    }
    await waitForBusy(base, token, resumeSession.id, false);
    const latestResumeCfg = store.resumeConfigs.at(-1);
    assert.equal(latestResumeCfg?.model, leadFrontmatterModel);
    assert.ok(store.sent.length >= 3);
    for (const sent of store.sent) {
      assert.match(sent.options.prompt, /\[MODELS\]/);
      assert.match(sent.options.prompt, new RegExp(`- ${leadFrontmatterModel}\\b`));
      assert.match(sent.options.prompt, new RegExp(`- ${NON_VISION_MODEL}\\b`));
      assert.ok(!sent.options.prompt.includes("old-disabled"));
    }

    const holding = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "hold-run",
      repoId: extraRepo.id,
    });
    assert.equal(holding.status, 200);
    await waitForBusy(base, token, session.id, true);
    const deletingWhileBusy = await fetch(`${base}/api/history/sessions/${session.id}`, {
      method: "DELETE",
      headers: { "X-DM-Token": token },
    });
    assert.equal(deletingWhileBusy.status, 409);
    await post(base, token, "/api/stop", { hqSessionId: session.id });
    await waitForBusy(base, token, session.id, false, 8000);

    const deleted = await fetch(`${base}/api/history/sessions/${session.id}`, {
      method: "DELETE",
      headers: { "X-DM-Token": token },
    });
    assert.equal(deleted.status, 200);
    const deletedBody = await deleted.json();
    assert.equal(deletedBody.deleted, true);
    assert.match(deletedBody.sdkTranscriptNote, /may persist/i);
    const afterDeleteGet = await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } });
    assert.equal(afterDeleteGet.status, 404);
    const attachmentPath = path.join(tmp, "history", "attachments", session.id);
    assert.equal(existsSync(attachmentPath), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("rejects invalid attachment magic bytes", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "attachment-validation-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await createSession(base, token);
    const badUpload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
      name: "fake.png",
      mimeType: "image/png",
      data: Buffer.from("not-an-image", "utf8").toString("base64"),
    });
    assert.equal(badUpload.status, 415);
    const badJson = await badUpload.json();
    assert.match(badJson.error, /mime does not match image bytes/i);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("accepts attachment payload bodies larger than 1MB up to image limits", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "large-body-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await createSession(base, token);
    const big = Buffer.alloc(1_200_000, 0x20);
    big[0] = 0xff; big[1] = 0xd8; // SOI
    big[2] = 0xff; big[3] = 0xe0; // APP0 marker
    big[4] = 0x00; big[5] = 0x10; // segment length
    big[big.length - 2] = 0xff; big[big.length - 1] = 0xd9; // EOI
    const upload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
      name: "big.jpg",
      mimeType: "image/jpeg",
      data: big.toString("base64"),
    });
    assert.equal(upload.status, 201);
    const created = await upload.json();
    assert.equal(created.mimeType, "image/jpeg");
    assert.ok(created.size > 1_000_000);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("rejects malformed PNG signature payload", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "bad-png-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await createSession(base, token);
    const fakePng = Buffer.alloc(80, 0x00);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(fakePng, 0);
    // Deliberately not setting IHDR chunk marker at offset 12.
    const upload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
      name: "fake-struct.png",
      mimeType: "image/png",
      data: fakePng.toString("base64"),
    });
    assert.equal(upload.status, 415);
    const body = await upload.json();
    assert.match(body.error, /mime does not match image bytes/i);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("CSP allows blob image previews and keeps script-src restrictive", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "csp-header-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/`, { headers: { "X-DM-Token": token } });
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy") || "";
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not allow unsafe-inline");
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("text-only chat fails open when listModels is unavailable and no model overrides are set", async () => {
  const store = { sent: [] };
  class NoListModelsClient extends MockClient {
    async listModels() { throw new Error("models unavailable"); }
  }
  setSdkClientFactoryForTests(() => new NoListModelsClient(store));
  const token = "listmodels-outage-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const session = await createSession(base, token);
    const ok = await post(base, token, "/api/chat", {
      hqSessionId: session.id,
      mode: "interactive",
      message: "text only no model",
    });
    assert.equal(ok.status, 200);
    await waitForBusy(base, token, session.id, false);
    assert.ok(store.sent.length >= 1);
    const prompt = store.sent.at(-1).options.prompt;
    assert.match(prompt, /\[MODELS\]/);
    assert.ok(
      /Catalog status: stale cached enabled list/.test(prompt)
      || /Model catalog unavailable from SDK listModels/.test(prompt),
      "catalog error context should be explicit"
    );
  } finally {
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const status = await (await fetch(`${base}/api/status`, { headers: { "X-DM-Token": token } })).json();
        for (const sid of status.activeSessions || []) {
          await post(base, token, "/api/stop", { hqSessionId: sid });
        }
        if (!status.busy && (!status.activeSessions || status.activeSessions.length === 0)) break;
        await new Promise(r => setTimeout(r, 50));
      }
    } catch {
      // best effort
    }
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("lists local directories with filters, sorting, parent, and git flags", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "fs-dirs-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(path.join(tmp, "fsdirs-"));
  try {
    await mkdir(path.join(root, "Zoo"));
    await mkdir(path.join(root, "alpha"));
    await mkdir(path.join(root, "Beta"));
    await mkdir(path.join(root, "repo-a", ".git"), { recursive: true });
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, ".hidden"));
    await writeFile(path.join(root, "file.txt"), "x", "utf8");
    await writeFile(path.join(root, ".git"), "gitdir: somewhere", "utf8");

    const response = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(root)}`, {
      headers: { "X-DM-Token": token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, await realpath(root));
    assert.equal(body.parent, path.dirname(await realpath(root)));
    assert.equal(body.isGitRepo, true);
    assert.ok(Array.isArray(body.roots));
    assert.ok(body.roots.length >= 1);
    assert.deepEqual(body.dirs.map(d => d.name), ["alpha", "Beta", "repo-a", "Zoo"]);
    assert.equal(body.dirs.every(d => !d.name.startsWith(".")), true);
    assert.equal(body.dirs.some(d => d.name === "node_modules"), false);
    assert.equal(body.dirs.some(d => d.name === "file.txt"), false);
    const repoA = body.dirs.find(d => d.name === "repo-a");
    assert.equal(repoA?.isGitRepo, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("fs dirs endpoint validates input and requires token", async () => {
  const store = { sent: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "fs-dirs-validation-token";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(path.join(tmp, "fsdirs-validate-"));
  try {
    const noToken = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(root)}`);
    assert.equal(noToken.status, 401);

    const relativePath = await fetch(`${base}/api/fs/dirs?path=relative-path`, {
      headers: { "X-DM-Token": token },
    });
    assert.equal(relativePath.status, 400);
    const relativeBody = await relativePath.json();
    assert.match(relativeBody.error, /absolute/i);

    const missingPath = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(path.join(root, "missing"))}`, {
      headers: { "X-DM-Token": token },
    });
    assert.equal(missingPath.status, 404);

    if (process.platform === "win32") {
      const slashRoot = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent("/")}`, {
        headers: { "X-DM-Token": token },
      });
      assert.equal(slashRoot.status, 200);
      const slashRootBody = await slashRoot.json();
      assert.match(slashRootBody.path, /^[A-Za-z]:\\/);

      const networkLikePaths = [
        "\\\\host\\share",
        "//host/share",
        "\\\\?\\C:\\",
      ];
      for (const p of networkLikePaths) {
        const unc = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(p)}`, {
          headers: { "X-DM-Token": token },
        });
        assert.equal(unc.status, 400);
        const uncBody = await unc.json();
        assert.match(uncBody.error, /network paths are not supported/i);
      }

      const repoUnc = await post(base, token, "/api/repos", { path: "\\\\localhost\\c$" });
      assert.equal(repoUnc.status, 400);
      const repoUncBody = await repoUnc.json();
      assert.match(repoUncBody.error, /network paths are not supported/i);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("speed lanes persist independently of permission mode and respect explicit lead models", async () => {
  const store = { sent: [], createConfigs: [], resumeConfigs: [] };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "speed-test";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await createSession(base, token);
    const run = async body => {
      const response = await post(base, token, "/api/chat", {
        hqSessionId: session.id, mode: "plan", message: "status", ...body,
      });
      assert.equal(response.status, 200, await response.text());
      await waitForBusy(base, token, session.id, false);
      return store.sent.at(-1).options;
    };
    assert.match((await run({ speed: "quick" })).prompt, /SPEED: QUICK/);
    assert.equal(store.createConfigs.at(-1).model, "claude-sonnet-5.5");
    let history = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(history.lastSpeed, "quick");
    assert.equal(history.lastMode, "plan");
    assert.equal(history.lastModel, null, "an automatic model never becomes a user override");
    assert.equal(history.entries.at(-1).runModel, "claude-sonnet-5.5");
    await run({ speed: "quick", model: "gpt-5.4-mini" });
    assert.equal(store.resumeConfigs.at(-1).model, "gpt-5.4-mini");
    await run({ speed: "quick", agentModels: { "regional-manager": NON_VISION_MODEL } });
    assert.equal(store.resumeConfigs.at(-1).customAgents.find(a => a.name === "regional-manager").model, NON_VISION_MODEL);
    assert.match((await run({ speed: "team" })).prompt, /SPEED: TEAM/);
    assert.match((await run({})).prompt, /SPEED: AUTO/);
    history = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } })).json();
    assert.equal(history.lastSpeed, "auto");
    assert.equal(history.lastModel, null);
    assert.equal(store.modelCalls, 1, "all lanes reuse the existing catalog");
    for (const speed of ["turbo", null, {}, ""]) {
      assert.equal((await post(base, token, "/api/chat", {
        hqSessionId: session.id, mode: "plan", message: "bad speed", speed,
      })).status, 400);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("multiple screenshots reach the SDK and history when the model permits only one inline", async () => {
  const store = { sent: [], maxImages: 1 };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "multi-screenshot-test";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await createSession(base, token);
    const attachments = [];
    for (let i = 1; i <= 4; i++) {
      const upload = await post(base, token, `/api/history/sessions/${session.id}/attachments`, {
        name: `screen-${i}.png`, mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+Q0YAAAAASUVORK5CYII=",
      });
      assert.equal(upload.status, 201);
      attachments.push(await upload.json());
    }
    for (const speed of ["quick", "auto", "team"]) {
      const response = await post(base, token, "/api/chat", {
        hqSessionId: session.id, message: "compare all screenshots", mode: "plan", speed,
        attachmentIds: attachments.map(a => a.id),
      });
      assert.equal(response.status, 200, await response.text());
      await waitForBusy(base, token, session.id, false);
      const sent = store.sent.at(-1).options;
      assert.equal(sent.attachments.length, 1);
      assert.equal(sent.attachments[0].displayName, "screen-1.png");
      assert.match(sent.prompt, /4 screenshots supplied/);
      assert.match(sent.prompt, /opened individually with the view tool/);
      const files = sent.prompt.split("\n").filter(l => l.startsWith('{"name":"screen-')).map(l => JSON.parse(l));
      assert.equal(files.length, 3, "no screenshot is silently dropped");
      for (const [i, file] of files.entries()) {
        assert.equal(file.name, `screen-${i + 2}.png`);
        assert.ok(existsSync(file.path));
        assert.ok(file.path.startsWith(path.join(tmp, "history", "attachments", session.id)));
      }
    }
    const history = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } })).json();
    for (const entry of history.entries.filter(e => e.role === "user")) assert.equal(entry.attachments.length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});

test("Edge composer supports all speed choices, multiple picker/pasted screenshots and history restore", {
  skip: process.env.DM_TEST_EDGE !== "1", timeout: 90000,
}, async () => {
  const { chromium } = await import("playwright");
  const store = { sent: [], maxImages: 1 };
  setSdkClientFactoryForTests(() => new MockClient(store));
  const token = "composer-test";
  const port = await allocatePort();
  const { server } = createServer({ port, token });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const session = await createSession(base, token);
    let releaseHistory;
    const historyGate = new Promise(resolve => { releaseHistory = resolve; });
    let firstHistory = true;
    await page.route(`${base}/api/history/sessions/${session.id}`, async route => {
      if (firstHistory) { firstHistory = false; await historyGate; }
      await route.continue();
    });
    await page.goto(`${base}/?session=${session.id}`);
    await page.locator('input[name="speed"][value="auto"]:checked').waitFor({ state: "attached" });
    await page.waitForFunction(() => !document.querySelector("#send").disabled
      && document.querySelector("#leadModel").options.length > 1);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+Q0YAAAAASUVORK5CYII=", "base64");
    await page.locator("#attachInput").setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: png },
      { name: "second.png", mimeType: "image/png", buffer: png },
    ]);
    assert.equal(await page.locator("#attachCount").textContent(), "2/4");
    await page.evaluate(base64 => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], "pasted.png", { type: "image/png" }));
      document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, png.toString("base64"));
    assert.equal(await page.locator("#attachCount").textContent(), "3/4");
    releaseHistory();
    await page.locator("#activity").getByText('opened conversation "New conversation"', { exact: true }).waitFor();
    assert.equal(await page.locator("#attachCount").textContent(), "3/4", "late history load preserves staged screenshots");
    await page.locator(".speed label").filter({ hasText: "Quick" }).click();
    await page.locator("#input").fill("Compare these screenshots");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#attachCount").textContent === "0/4");
    await waitForBusy(base, token, session.id, false);
    assert.match(store.sent.at(-1).options.prompt, /SPEED: QUICK/);
    assert.match(store.sent.at(-1).options.prompt, /3 screenshots supplied/);
    await page.reload();
    await page.locator('input[name="speed"][value="quick"]:checked').waitFor({ state: "attached" });
    assert.equal(await page.locator(".msg-image").count(), 3);
    for (const [label, speed] of [["Team", "TEAM"], ["Auto", "AUTO"]]) {
      await page.waitForFunction(() => !document.querySelector("#send").disabled);
      await page.locator(".speed label").filter({ hasText: label, exact: true }).click();
      await page.locator("#input").fill("Status");
      await page.locator("#send").click();
      await page.waitForFunction(() => document.querySelector("#input").value === "");
      await waitForBusy(base, token, session.id, false);
      assert.match(store.sent.at(-1).options.prompt, new RegExp(`SPEED: ${speed}`));
    }
    await page.locator("#input").fill("hold-run");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#send").textContent === "Queue for Michael" && !document.querySelector("#send").disabled);
    await page.locator("#attachInput").setInputFiles([
      { name: "queued-one.png", mimeType: "image/png", buffer: png },
      { name: "queued-two.png", mimeType: "image/png", buffer: png },
    ]);
    await page.locator("#input").fill("queued screenshot review");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#queueItems").children.length === 1 && document.querySelector("#attachCount").textContent === "0/4");
    assert.match(await page.locator("#queueItems").textContent(), /2 files/);
    assert.equal(store.sent.filter(s => s.options.prompt.endsWith("queued screenshot review")).length, 0);
    await page.locator("#input").fill("remove this queued item");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#queueItems").children.length === 2 && !document.querySelector("#send").disabled);
    await page.locator("#queueItems li").last().getByRole("button", { name: "Remove" }).click();
    await page.waitForFunction(() => document.querySelector("#queueItems").children.length === 1);
    await page.locator("#stop").click();
    await page.waitForFunction(() => document.querySelector("#queueStatus").textContent.includes("paused") && document.querySelector("#stop").hidden);
    await page.reload();
    await page.locator("#resumeQueue").waitFor({ state: "visible" });
    assert.match(await page.locator("#queueItems").textContent(), /queued screenshot review/);
    await page.locator("#input").fill("draft for later");
    await page.locator("#resumeQueue").click();
    await page.waitForFunction(() => document.querySelector("#queueItems").children.length === 0 && document.querySelector("#stop").hidden);
    await waitForBusy(base, token, session.id, false);
    assert.equal(store.sent.filter(s => s.options.prompt.endsWith("queued screenshot review")).length, 1);
    assert.equal(await page.locator("#input").inputValue(), "draft for later");
    const finalHistory = await (await fetch(`${base}/api/history/sessions/${session.id}`, { headers: { "X-DM-Token": token } })).json();
    const queuedEntries = finalHistory.entries.filter(e => e.role === "user" && e.text === "queued screenshot review");
    assert.equal(queuedEntries.length, 1);
    assert.equal(queuedEntries[0].attachments.length, 2);
    assert.ok(!finalHistory.entries.some(e => e.text === "remove this queued item"));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#leadModel").options.length > 1 && document.querySelector("#stop").hidden);
    await page.locator("#activity li").filter({ hasText: 'opened conversation "' }).first().waitFor();
    await page.locator("#leadModel").selectOption(NON_VISION_MODEL);
    const reference = Buffer.from("Synthetic reference: the launch code is GREEN-42.");
    await page.locator("#attachInput").setInputFiles([
      { name: "reference.md", mimeType: "text/markdown", buffer: reference },
      { name: "mixed.png", mimeType: "image/png", buffer: png },
    ]);
    assert.equal(await page.locator("#attachPreview .reference-label").textContent(), "reference.md");
    await page.locator("#input").fill("Summarize the reference");
    await page.locator("#send").click();
    await page.locator("#attachError").filter({ hasText: "cannot read images" }).waitFor();
    await page.getByRole("button", { name: "Remove mixed.png", exact: true }).click();
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#attachCount").textContent === "0/4");
    await waitForBusy(base, token, session.id, false);
    assert.match(store.sent.at(-1).options.prompt, /GREEN-42/);
    assert.equal(store.sent.at(-1).options.attachments.length, 0);
    await page.reload();
    const fileButton = page.getByRole("button", { name: "Download reference.md", exact: true });
    await fileButton.waitFor();
    const downloadPromise = page.waitForEvent("download");
    await fileButton.click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "reference.md");
    assert.deepEqual(await readFile(await download.path()), reference);
    await page.locator("#attachInput").setInputFiles([{ name: "bad.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }]);
    await page.locator("#attachError").filter({ hasText: "unsupported file type" }).waitFor();
    assert.equal(await page.locator("#attachCount").textContent(), "0/4");
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    setSdkClientFactoryForTests(null);
  }
});
