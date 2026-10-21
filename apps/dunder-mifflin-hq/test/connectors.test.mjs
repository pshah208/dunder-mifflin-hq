import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";

const originalData = process.env.DM_DATA_DIR;
const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-hq-connectors-"));
process.env.DM_DATA_DIR = tmp;
const {
  expandConfigString,
  loadConnectors,
  requiresOutboundApproval,
  isReadOnlyMcpRequest,
  isServerConfirmedMcpRequest,
  summarizeElicitation,
  coerceElicitationContent,
  getConnectorToken,
  connectorStatus,
  setAzTokenRunnerForTests,
  buildConnectorsPromptBlock,
  buildSdkSessionConfig,
  loadSdkCustomAgents,
} = await import("../server.mjs");

// Never call the real Azure CLI from tests: connectors that need a token report "sign-in needed".
setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });

test.after(async () => {
  if (originalData === undefined) delete process.env.DM_DATA_DIR;
  else process.env.DM_DATA_DIR = originalData;
  await rm(tmp, { recursive: true, force: true });
});

test("expandConfigString resolves HOME, env vars and nested defaults", () => {
  const env = { A: "alpha" };
  assert.equal(expandConfigString("${HOME}/x", env, "/h"), "/h/x");
  assert.equal(expandConfigString("${env:A}/y", env, "/h"), "alpha/y");
  assert.equal(expandConfigString("${env:B|${HOME}/def}/z", env, "/h"), "/h/def/z");
  assert.equal(expandConfigString("${env:B}", env, "/h"), null);
  assert.equal(expandConfigString("plain", env, "/h"), "plain");
  assert.equal(expandConfigString("${env:ProgramFiles(x86)|C:/Program Files (x86)}/Microsoft/Edge", {}, "/h"),
    "C:/Program Files (x86)/Microsoft/Edge");
  assert.equal(expandConfigString("${env:ProgramFiles(x86)}", { "ProgramFiles(x86)": "D:\\Apps" }, "/h"), "D:\\Apps");
});

test("loadConnectors marks missing installs unavailable and expands configs", async () => {
  const cfg = path.join(tmp, "mcp.json");
  await writeFile(cfg, JSON.stringify({
    servers: {
      a: { label: "A", provides: ["mail"], config: { command: "npx", args: ["${env:ARG|def}"] } },
      b: { label: "B", requiresPaths: ["${HOME}/missing.mjs"], config: { command: "node" } },
      c: { label: "C", requiresEnv: ["NEED"], config: { command: "${env:NEED}" } },
      d: { label: "D", enabled: false, config: { command: "x" } },
    },
  }));
  const out = await loadConnectors({ configPath: cfg, env: {}, home: "/h", exists: () => false });
  assert.deepEqual(Object.keys(out.mcpServers), ["a"]);
  assert.deepEqual(out.mcpServers.a.args, ["def"]);
  const by = Object.fromEntries(out.connectors.map(c => [c.name, c]));
  assert.equal(by.a.available, true);
  assert.match(by.b.reason, /not installed/);
  assert.match(by.c.reason, /set NEED/);
  assert.match(by.d.reason, /disabled/);
  const withEnv = await loadConnectors({ configPath: cfg, env: { NEED: "tool.exe" }, home: "/h", exists: () => true });
  assert.equal(withEnv.mcpServers.c.command, "tool.exe");
  assert.ok(withEnv.mcpServers.b);
});

test("loadConnectors honours DM_DISABLE_MCP and a missing file", async () => {
  assert.equal((await loadConnectors({ configPath: path.join(tmp, "nope.json"), env: {} })).connectors.length, 0);
  assert.equal((await loadConnectors({ configPath: path.join(tmp, "nope.json"), env: { DM_DISABLE_MCP: "1" } })).disabled, true);
});

test("bundled mcp-servers.json declares M365 and MSX connectors", async () => {
  const raw = JSON.parse(await readFile(path.resolve("mcp-servers.json"), "utf8"));
  assert.ok(raw.servers.workiq.provides.includes("Outlook email"));
  assert.ok(raw.servers.workiq.provides.includes("SharePoint"));
  assert.ok(raw.servers.msx.provides.includes("Opportunities"));
  const team = JSON.parse(await readFile(path.resolve("personas.json"), "utf8"));
  const ids = new Set(team.map(m => m.id));
  for (const s of Object.values(raw.servers)) for (const id of s.usedBy) assert.ok(ids.has(id), `unknown agent ${id}`);
});

test("side-effecting MCP tools always need approval unless explicitly opted out", () => {
  assert.equal(requiresOutboundApproval({ kind: "mcp", readOnly: false }, {}), true);
  assert.equal(requiresOutboundApproval({ kind: "mcp" }, {}), true);
  assert.equal(requiresOutboundApproval({ kind: "mcp", readOnly: true }, {}), false);
  assert.equal(requiresOutboundApproval({ kind: "shell" }, {}), false);
  assert.equal(requiresOutboundApproval({ kind: "mcp", readOnly: false }, { DM_AUTOPILOT_MCP_WRITES: "1" }), false);
});

test("connectors prompt block lists availability and the outbound rule", async () => {
  const block = await buildConnectorsPromptBlock({ connectors: [
    { name: "workiq", label: "M365", available: true, provides: ["Outlook email"] },
    { name: "msx", label: "MSX", available: false, reason: "not installed", provides: ["Opportunities"] },
  ] });
  assert.match(block, /\[CONNECTORS\]/);
  assert.match(block, /workiq \(M365\): available/);
  assert.match(block, /msx \(MSX\): UNAVAILABLE — not installed/);
  assert.match(block, /require an explicit user approval/);
});

test("session config attaches available MCP servers and the Office roster", async () => {
  const cfg = await buildSdkSessionConfig({ handlers: {} });
  assert.equal(cfg.agent, "regional-manager");
  assert.ok(cfg.mcpServers?.workiq, "workiq attached");
  assert.ok(cfg.mcpServers?.["ms-learn"], "ms-learn attached");
  const agents = await loadSdkCustomAgents();
  const team = JSON.parse(await readFile(path.resolve("personas.json"), "utf8"));
  assert.deepEqual(agents.map(a => a.name).sort(), team.map(m => m.id).sort());
  for (const m of team) assert.equal(agents.find(a => a.name === m.id).model, m.model, `${m.id} model matches personas.json`);
  const avatars = await readdir(path.resolve("public", "avatars"));
  for (const m of team) assert.ok(avatars.includes(`${m.id}.svg`), `${m.id} avatar`);
});

test("allowlisted read-only MCP tools run without a click; writes still need one", () => {
  const ro = { workiq: ["ask", "fetch"], "ms-learn": ["*"] };
  assert.equal(isReadOnlyMcpRequest({ kind: "mcp", serverName: "workiq", toolName: "ask", readOnly: false }, ro), true);
  assert.equal(isReadOnlyMcpRequest({ kind: "mcp", serverName: "workiq", toolName: "workiq-fetch" }, ro), true);
  assert.equal(isReadOnlyMcpRequest({ kind: "mcp", serverName: "workiq", toolName: "do_action" }, ro), false);
  assert.equal(isReadOnlyMcpRequest({ kind: "mcp", serverName: "ms-learn", toolName: "anything" }, ro), true);
  assert.equal(isReadOnlyMcpRequest({ kind: "mcp", serverName: "msx", toolName: "dataverse_write" }, ro), false);
  assert.equal(isReadOnlyMcpRequest({ kind: "shell", serverName: "workiq", toolName: "ask" }, ro), false);
  assert.equal(requiresOutboundApproval({ kind: "mcp", serverName: "workiq", toolName: "ask" }, {}, ro), false);
  assert.equal(requiresOutboundApproval({ kind: "mcp", serverName: "workiq", toolName: "create_entity" }, {}, ro), true);
});

test("bundled config never allowlists write tools", async () => {
  const raw = JSON.parse(await readFile(path.resolve("mcp-servers.json"), "utf8"));
  for (const [name, s] of Object.entries(raw.servers)) {
    for (const tool of s.readOnlyTools || []) assert.ok(!/write|create|update|delete|send|post|do_action|accept_eula|uat_request|login|config/i.test(tool) || tool === "*", `${name}.${tool}`);
  }
  assert.ok(raw.servers.workiq.readOnlyTools.includes("ask"));
  assert.ok(!raw.servers.msx.readOnlyTools.includes("dataverse_write"));
});
test("MSX dataverse_write is gated by the server's own confirmation, nothing else is", () => {
  const confirmed = { msx: ["dataverse_write"] }, ro = { msx: ["get_milestones"] };
  const write = { kind: "mcp", serverName: "msx", toolName: "dataverse_write", readOnly: false };
  assert.equal(isServerConfirmedMcpRequest(write, confirmed), true);
  assert.equal(isServerConfirmedMcpRequest({ ...write, toolName: "msx-dataverse_write" }, confirmed), true);
  assert.equal(isServerConfirmedMcpRequest({ ...write, toolName: "uat_request" }, confirmed), false);
  assert.equal(isServerConfirmedMcpRequest({ ...write, serverName: "workiq" }, confirmed), false);
  assert.equal(requiresOutboundApproval(write, {}, ro, confirmed), false, "no second HQ click on top of the MSX card");
  assert.equal(requiresOutboundApproval({ ...write, toolName: "uat_request" }, {}, ro, confirmed), true, "other MSX writes still need an HQ click");
});

test("bundled MSX connector loads plugin skills and only self-confirms dataverse_write", async () => {
  const raw = JSON.parse(await readFile(path.resolve("mcp-servers.json"), "utf8"));
  assert.deepEqual(raw.servers.msx.confirmedTools, ["dataverse_write"]);
  assert.ok(raw.servers.msx.skillDirectories.some(d => d.endsWith("/skills")));
  assert.ok(raw.servers.msx.usedBy.includes("office-administrator"));
  const cfg = path.join(tmp, "skills.json");
  await writeFile(cfg, JSON.stringify({ servers: { msx: { skillDirectories: ["${HOME}/plugin/skills", "${HOME}/missing"], confirmedTools: ["dataverse_write"], config: { command: "node" } } } }));
  const out = await loadConnectors({ configPath: cfg, env: {}, home: "/h", exists: p => p === "/h/plugin/skills" });
  assert.deepEqual(out.skillDirectories, ["/h/plugin/skills"], "missing skill folders are skipped");
  assert.deepEqual(out.confirmedTools, { msx: ["dataverse_write"] });
});

test("elicitation forms are summarised for the browser and answers are coerced to the schema", () => {
  const s = summarizeElicitation({ message: "Create task?", elicitationSource: "msx", requestedSchema: { type: "object", required: ["confirm"], properties: {
    confirm: { type: "boolean", title: "Confirm" }, n: { type: "integer" }, pick: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } } } });
  assert.equal(s.message, "Create task?"); assert.equal(s.source, "msx"); assert.equal(s.mode, "form");
  assert.deepEqual(s.fields.map(f => [f.name, f.type, f.required]), [["confirm", "boolean", true], ["n", "integer", false], ["pick", "string", false]]);
  assert.deepEqual(s.fields[2].enum, ["a", "b"]);
  assert.deepEqual(coerceElicitationContent(s.fields, { confirm: "true", n: "4.7", pick: "zzz", extra: 1 }), { confirm: true, n: 4 });
});

test("session config enables the elicitation bridge and plugin skills", async () => {
  const cfg = await buildSdkSessionConfig({ handlers: { onElicitationRequest: async () => ({ action: "decline" }) } });
  assert.equal(typeof cfg.onElicitationRequest, "function");
  const src = await readFile(path.resolve("server.mjs"), "utf8");
  assert.match(src, /if \(ctx\.mode === "plan"\) return \{ action: "decline" \};/, "plan mode never confirms a write");
  assert.match(src, /onPermissionRequest,\n?\s*onElicitationRequest,/);
  assert.ok(!/action: "accept"/.test(src.slice(src.indexOf("const onElicitationRequest"), src.indexOf("const onExitPlanModeRequest"))), "never auto-accepts");
  // Interactive mode must not stack an HQ click on top of the server's card, but Plan mode must still reject the write first.
  const perm = src.slice(src.indexOf("const onPermissionRequest"), src.indexOf("const onUserInputRequest"));
  assert.ok(perm.indexOf('if (ctx.mode === "plan")') < perm.indexOf("isServerConfirmedMcpRequest(request)"), "plan check runs before the server-confirmed shortcut");
  assert.match(perm, /if \(!request\.managedApprovalRequired && isServerConfirmedMcpRequest\(request\)\) return \{ kind: "approve-once" \};/);
});

test("discover picks the first existing executable and exposes it as ${var:NAME}", async () => {
  const cfg = path.join(tmp, "discover.json");
  await writeFile(cfg, JSON.stringify({ servers: {
    snap: { discover: { EXE: ["${env:SNAP_EXE}", "${HOME}/Downloads/a.exe", "${HOME}/Downloads/b.exe"] }, requiresPaths: ["${HOME}/data/snap.db"],
      config: { command: "${var:EXE}", args: ["mcp", "--data-dir", "${HOME}/data"] } },
    missing: { discover: { EXE: ["${HOME}/nope.exe"] }, discoverHint: "install it", config: { command: "${var:EXE}" } },
  } }));
  const have = new Set(["/h/Downloads/b.exe", "/h/data/snap.db"]);
  const out = await loadConnectors({ configPath: cfg, env: {}, home: "/h", exists: p => have.has(p) });
  assert.equal(out.mcpServers.snap.command, "/h/Downloads/b.exe");
  assert.deepEqual(out.mcpServers.snap.args, ["mcp", "--data-dir", "/h/data"]);
  const missing = out.connectors.find(c => c.name === "missing");
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not found \(looked for nope\.exe; install it\)/);
  const viaEnv = await loadConnectors({ configPath: cfg, env: { SNAP_EXE: "/opt/snap.exe" }, home: "/h", exists: p => p === "/opt/snap.exe" || have.has(p) });
  assert.equal(viaEnv.mcpServers.snap.command, "/opt/snap.exe", "an explicit env var wins");
});

test("bundled config: MSXi Snap is auto-discovered and Power BI uses the corp-tenant Azure CLI token", async () => {
  const raw = JSON.parse(await readFile(path.resolve("mcp-servers.json"), "utf8"));
  const snap = raw.servers["msxi-snap"];
  assert.ok(!snap.requiresEnv, "no env var needed any more");
  assert.equal(snap.config.command, "${var:MSXI_SNAP_EXE}");
  assert.ok(snap.discover.MSXI_SNAP_EXE.some(p => p.endsWith("msxi-snap-desktop-windows-arm64.exe")));
  assert.deepEqual(snap.readOnlyTools, ["*"]);
  const pbi = raw.servers["powerbi-remote"];
  assert.equal(pbi.config.url, "https://api.fabric.microsoft.com/v1/mcp/powerbi");
  assert.deepEqual(pbi.auth, { type: "azure-cli", tenant: "72f988bf-86f1-41af-91ab-2d7cd011db47", resource: "https://api.fabric.microsoft.com" });
  assert.deepEqual(pbi.readOnlyTools, ["*"]);
  for (const id of ["finance-analyst"]) { assert.ok(snap.usedBy.includes(id)); assert.ok(pbi.usedBy.includes(id)); }
});

test("Azure CLI tokens: cached until near expiry, failures cached briefly, inputs validated", async () => {
  let calls = 0, lastArgs = null;
  setAzTokenRunnerForTests(async (args) => { calls++; lastArgs = args; return { accessToken: "tok-" + calls, expires_on: Math.floor(Date.now() / 1000) + 3600 }; });
  const auth = { type: "azure-cli", tenant: "72f988bf-86f1-41af-91ab-2d7cd011db47", resource: "https://api.fabric.microsoft.com" };
  assert.equal(await getConnectorToken(auth), "tok-1");
  assert.equal(await getConnectorToken(auth), "tok-1", "cached");
  assert.equal(calls, 1);
  assert.deepEqual(lastArgs, ["account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "-o", "json", "--tenant", "72f988bf-86f1-41af-91ab-2d7cd011db47"]);
  await assert.rejects(getConnectorToken({ ...auth, tenant: "x; rm -rf /" }), /invalid tenant/);
  await assert.rejects(getConnectorToken({ ...auth, resource: "http://evil" }), /invalid resource/);
  let failCalls = 0;
  setAzTokenRunnerForTests(async () => { failCalls++; throw Object.assign(new Error("AADSTS50020: wrong tenant"), { signIn: true }); });
  await assert.rejects(getConnectorToken(auth), /AADSTS50020/);
  await assert.rejects(getConnectorToken(auth), /AADSTS50020/);
  assert.equal(failCalls, 1, "a failure isn't retried on every request");
});

test("connector status attaches the Bearer header when signed in, reports sign-in when not, and never blocks long", async () => {
  const loaded = { mcpServers: { pbi: { type: "http", url: "https://example.test/mcp" }, other: { command: "x" } }, auth: { pbi: { type: "azure-cli", tenant: "72f988bf-86f1-41af-91ab-2d7cd011db47", resource: "https://api.fabric.microsoft.com" } },
    connectors: [{ name: "pbi", label: "PBI", provides: [], usedBy: [], available: true, signInHint: "az login" }, { name: "other", label: "O", provides: [], usedBy: [], available: true }] };
  setAzTokenRunnerForTests(async () => ({ accessToken: "secret-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }));
  const ok = await connectorStatus(loaded);
  assert.equal(ok.mcpServers.pbi.headers.Authorization, "Bearer secret-token");
  assert.equal(ok.connectors.find(c => c.name === "pbi").signedIn, true);
  assert.ok(!("headers" in loaded.mcpServers.pbi), "the cached config is never mutated");
  setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("AADSTS50020: wrong tenant"), { signIn: true }); });
  const bad = await connectorStatus(loaded);
  assert.ok(!bad.mcpServers.pbi, "an unauthenticated remote server isn't attached");
  assert.ok(bad.mcpServers.other);
  const c = bad.connectors.find(x => x.name === "pbi");
  assert.equal(c.available, false); assert.equal(c.needsSignIn, true); assert.match(c.reason, /sign-in needed: AADSTS50020.*az login/);
  setAzTokenRunnerForTests(() => new Promise(() => {}));
  const t0 = Date.now();
  const slow = await connectorStatus(loaded, { waitMs: 50 });
  assert.ok(Date.now() - t0 < 1000, "a hanging az never stalls a run");
  assert.equal(slow.connectors.find(x => x.name === "pbi").checking, true);
  setAzTokenRunnerForTests(async () => { throw Object.assign(new Error("test: Azure CLI disabled"), { signIn: true }); });
});
test("Customer360 routes to Dwight using shared Edge and a user-supplied read-only view", async () => {
  const raw = JSON.parse(await readFile(new URL("../mcp-servers.json", import.meta.url), "utf8"));
  const browser = raw.servers["powerbi-browser"];
  assert.ok(browser.usedBy.includes("sales-lead"));
  assert.ok(browser.usedBy.includes("finance-analyst"));
  assert.ok(browser.config.tools.includes("browser_snapshot"));
  assert.ok(!browser.config.tools.includes("browser_run_code"));
  assert.ok(!browser.config.tools.includes("browser_evaluate"));
  const dwight = await readFile(new URL("../../../.github/agents/sales-lead.agent.md", import.meta.url), "utf8");
  assert.match(dwight, /user's supplied Customer360 view link/);
  assert.match(dwight, /If none is available, ask for it/);
  assert.doesNotMatch(dwight, /https:\/\/[^\s)]+[?&](?:appid|viewid)=/i);
  assert.doesNotMatch(dwight, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i);
  assert.match(dwight, /msp_customer360/);
  assert.match(dwight, /No Create, Edit, Save, Delete/);
  assert.match(dwight, /Never guess the plural entity set/);
  const michael = await readFile(new URL("../../../.github/agents/regional-manager.agent.md", import.meta.url), "utf8");
  assert.match(michael, /Customer360.*Dwight/);
});
