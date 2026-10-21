import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { loadConnectors, isReadOnlyMcpRequest, requiresOutboundApproval } from "../server.mjs";

const configPath = new URL("../mcp-servers.json", import.meta.url);

test("Power BI browser discovers Edge, uses an isolated persistent profile and only UI tools", async () => {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const def = raw.servers["powerbi-browser"];
  assert.deepEqual(def.usedBy, ["finance-analyst", "sales-lead"]);
  assert.ok(def.config.args.includes("msedge"));
  assert.ok(def.config.args.includes("--no-webmcp"));
  assert.ok(def.config.args.includes("--user-data-dir"));
  assert.ok(!def.config.args.includes("--headless"));
  for (const tool of ["browser_evaluate", "browser_run_code", "browser_file_upload"])
    assert.ok(!def.config.tools.includes(tool), `${tool} is not exposed`);
  const installed = await loadConnectors({
    configPath, env: { DM_EDGE_EXE: "C:\\Edge\\msedge.exe" }, home: "C:\\TestHome",
    exists: p => p === "C:\\Edge\\msedge.exe" || p.endsWith("/node_modules/@playwright/mcp/cli.js"),
  });
  const cfg = installed.mcpServers["powerbi-browser"];
  assert.ok(cfg);
  assert.equal(cfg.args[cfg.args.indexOf("--executable-path") + 1], "C:\\Edge\\msedge.exe");
  assert.match(cfg.args[cfg.args.indexOf("--user-data-dir") + 1], /edge-powerbi$/);
  assert.ok(!cfg.args.some(a => a.includes("${")), "all runtime paths expand");
  const missing = await loadConnectors({ configPath, env: {}, exists: () => false });
  assert.equal(missing.connectors.find(c => c.name === "powerbi-browser").available, false);
});

test("browser clicks and navigation require approval even with optimistic tool annotations", async () => {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const ro = { "powerbi-browser": raw.servers["powerbi-browser"].readOnlyTools };
  for (const toolName of ["browser_click", "browser_navigate", "browser_tabs", "browser_fill_form"]) {
    const request = { kind: "mcp", serverName: "powerbi-browser", toolName, readOnly: true };
    assert.equal(isReadOnlyMcpRequest(request, ro), false);
    assert.equal(requiresOutboundApproval(request, {}, ro), true);
  }
  assert.equal(isReadOnlyMcpRequest({
    kind: "mcp", serverName: "powerbi-browser", toolName: "powerbi-browser-browser_snapshot",
  }, ro), true);
});

test("Angela and Michael preserve UI-only report requests and manual sign-in", async () => {
  const angela = await readFile(new URL("../../../.github/agents/finance-analyst.agent.md", import.meta.url), "utf8");
  const michael = await readFile(new URL("../../../.github/agents/regional-manager.agent.md", import.meta.url), "utf8");
  assert.match(angela, /Do not substitute `ExecuteQuery`, DAX/);
  assert.match(angela, /Sign-in, MFA and consent are manual/);
  assert.match(angela, /report unreadable values as unknown/);
  assert.match(michael, /never substitute DAX/);
});

test("installed Edge MCP can navigate, select a slicer, click a toggle and read updated values", {
  skip: process.env.DM_TEST_EDGE !== "1", timeout: 90000,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hq-edge-test-"));
  const loaded = await loadConnectors({ configPath });
  const cfg = loaded.mcpServers["powerbi-browser"];
  assert.ok(cfg, "installed Edge and Playwright MCP are required");
  const args = [...cfg.args];
  args[args.indexOf("--user-data-dir") + 1] = path.join(dir, "profile");
  args[args.indexOf("--output-dir") + 1] = path.join(dir, "output");
  const fixture = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>HQ report fixture</title>
      <label>Territory <select onchange="document.getElementById('value').textContent=this.value">
      <option>All</option><option>West</option></select></label>
      <button onclick="this.textContent='Last month selected'">Last month</button>
      <p id="value">All</p>`);
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", b => { stderr += b; });
  lines.on("line", line => {
    const msg = JSON.parse(line);
    const handler = pending.get(msg.id);
    if (!handler) return;
    pending.delete(msg.id);
    msg.error ? handler.reject(new Error(JSON.stringify(msg.error))) : handler.resolve(msg.result);
  });
  child.on("error", err => { for (const p of pending.values()) p.reject(err); });
  child.on("exit", code => {
    for (const p of pending.values()) p.reject(new Error(`MCP exited ${code}: ${stderr}`));
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out: ${method}: ${stderr}`));
    }, 30000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: err => { clearTimeout(timer); reject(err); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  const call = async (name, arguments_ = {}) => {
    const result = await rpc("tools/call", { name, arguments: arguments_ });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "hq-edge-smoke", version: "1.0.0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await rpc("tools/list", {});
    for (const name of cfg.tools) assert.ok(tools.tools.some(t => t.name === name), `${name} exists`);
    await call("browser_navigate", { url: `http://127.0.0.1:${fixture.address().port}` });
    const page = await call("browser_snapshot");
    const selectRef = /combobox "Territory" \[ref=([^\]]+)\]/.exec(page)?.[1];
    assert.ok(selectRef, page);
    await call("browser_select_option", { target: selectRef, values: ["West"] });
    const snapshot = await call("browser_snapshot");
    const buttonRef = /button "Last month" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
    assert.ok(buttonRef, snapshot);
    await call("browser_click", { target: buttonRef });
    const updated = await call("browser_snapshot");
    assert.match(updated, /Last month selected/);
    assert.match(updated, /paragraph.*West/);
  } finally {
    try { await call("browser_close"); } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        await Promise.race([
          new Promise(resolve => child.once("exit", resolve)),
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]);
        if (child.exitCode === null) child.kill();
      }
      lines.close();
      fixture.closeAllConnections();
      await new Promise(resolve => fixture.close(resolve));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
});
