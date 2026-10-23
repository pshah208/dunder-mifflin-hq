import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";

test("Edge: Office resumes across Chat, gathers cross-team stakeholders and reconciles completed work", {
  skip: process.env.DM_TEST_EDGE !== "1", timeout: 120000,
}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-office-navigation-"));
  process.env.DM_DATA_DIR = tmp;
  process.env.DM_DISABLE_AZURE_DISCOVERY = "1";
  process.env.DM_DISABLE_MCP = "1";
  const { createServer, setSdkClientFactoryForTests, setAzTokenRunnerForTests } = await import("../server.mjs");
  setAzTokenRunnerForTests(async () => { throw new Error("Test: Azure disabled"); });
  setSdkClientFactoryForTests(() => ({ async listModels() { return [{ id: "test-model" }]; }, async stop() {} }));
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const { server } = createServer({ port, token: "office-test", enableStudyScheduler: false, enableAutomationScheduler: false });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const nav = name => page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name, exact: true });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const participants = ["finance-analyst", "renewals-desk", "automation-engineer", "cloud-ai-architect", "qa-reviewer", "compliance-officer"];
    const events = [
      { t: "start", runId: "office-run" },
      ...participants.map((agent, i) => ({ t: "agent_start", runId: "office-run", callId: `c${i}`, agent, summary: "Synthetic cross-team task" })),
    ];
    let busy = true;
    await page.route("**/api/live", route => route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ t: "snapshot", busy, activeRuns: busy ? [{ runId: "office-run" }] : [], events: busy ? events : [] }) + "\n",
    }));
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const read = () => page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      return JSON.parse(sessionStorage.getItem("dm-office-scene-v1"));
    });
    const openOffice = async () => {
      await page.goto(base + "/office.html");
      await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
      await page.clock.runFor(100);
      await page.waitForFunction(() => document.querySelector("#workingCount").textContent === "7");
    };
    await openOffice();
    await page.clock.runFor(700);
    const before = new Map((await read()).sims);
    const michael = before.get("regional-manager");
    assert.ok(michael.path.length, "Michael actually walks toward the gathering");
    assert.equal(michael.target, "6.00,1.88");
    await nav("Chat").click();
    await page.waitForURL(base + "/");
    await nav("Office").click();
    await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    const after = new Map((await read()).sims);
    for (const [id, s] of before) {
      assert.deepEqual([after.get(id).x, after.get(id).y, after.get(id).target, after.get(id).path],
        [s.x, s.y, s.target, s.path], `${id} resumes without a desk reset`);
    }
    await page.clock.runFor(22000);
    const gathered = new Map((await read()).sims);
    for (const id of ["regional-manager", ...participants]) {
      const s = gathered.get(id);
      assert.equal(s.path.length, 0, `${id} arrives physically`);
      assert.ok(s.x > 3.2 && s.x < 6.3 && s.y > .2 && s.y < 3.45, `${id} is at the conference table`);
      assert.equal(s.pose, "talk");
    }
    events.push({ t: "agent_end", runId: "office-run", callId: "c0", agent: participants[0], ok: true });
    await page.reload();
    await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    await page.clock.runFor(100);
    await page.waitForFunction(() => document.querySelector("#workingCount").textContent === "6");
    assert.equal(new Map((await read()).sims).get("finance-analyst").target, gathered.get("finance-analyst").target,
      "finished stakeholder stays for Michael's synthesis without an active badge");
    assert.equal(await page.locator('.sim[data-agent="finance-analyst"].active').count(), 0);
    await nav("Chat").click();
    busy = false;
    await nav("Office").click();
    await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    await page.clock.runFor(100);
    await page.waitForFunction(() => document.querySelector("#workingCount").textContent === "0");
    const done = new Map((await read()).sims);
    assert.equal(done.get("regional-manager").target, "1.60,1.15");
    assert.ok(done.get("regional-manager").x > 3, "finished work walks home rather than teleporting");

    // Exercise actual idle outings and restore a held seat/path, not just active task destinations.
    for (let i = 0; i < 30; i++) {
      await page.clock.fastForward(2500);
      if ((await read()).lounge.visits.length) break;
    }
    const resting = await read();
    assert.ok(resting.lounge.visits.length, "idle agents leave their desks");
    await nav("Chat").click();
    await nav("Office").click();
    await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    const resumed = await read();
    assert.deepEqual(resumed.lounge.occ, resting.lounge.occ);
    assert.deepEqual(resumed.lounge.visits.map(([id, v]) => [id, v.kind, v.idx, v.spots]),
      resting.lounge.visits.map(([id, v]) => [id, v.kind, v.idx, v.spots]));
    await page.locator("#demoBtn").click();
    await page.waitForFunction(() => document.querySelector("#demoBtn").textContent.includes("Stop demo"));
    await page.clock.runFor(4000);
    const demoBefore = await read();
    await nav("Chat").click();
    await nav("Office").click();
    await page.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    const demoAfter = await read();
    assert.equal(demoAfter.demoElapsed, demoBefore.demoElapsed, "demo resumes its timeline, not its opening");
    assert.deepEqual(demoAfter.sims.map(([id, s]) => [id, s.x, s.y, s.path]),
      demoBefore.sims.map(([id, s]) => [id, s.x, s.y, s.path]));
    await page.locator("#demoBtn").click();
    assert.deepEqual(errors, []);

    // Embedded/background browsers may defer RAF. Characters still need a complete first paint.
    const deferred = await browser.newPage();
    await deferred.addInitScript(() => { window.requestAnimationFrame = () => 1; });
    await deferred.goto(base + "/office.html");
    await deferred.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    const transforms = await deferred.locator(".sim").evaluateAll(nodes => nodes.map(n => n.getAttribute("transform")));
    assert.equal(new Set(transforms).size, 15, "all characters are positioned before the first animation callback");
    assert.ok(transforms.every(Boolean), "no avatars remain stacked at the SVG origin");
    assert.equal(await deferred.locator(".sim-label").evaluateAll(nodes => nodes.filter(n => n.style.left && n.style.top).length), 15);
    await deferred.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    await deferred.addInitScript(() => {
      const saved = JSON.parse(sessionStorage.getItem("dm-office-scene-v1"));
      const michael = saved.sims.find(([id]) => id === "regional-manager")[1];
      michael.x = 5; michael.y = 5; michael.path = [];
      sessionStorage.setItem("dm-office-scene-v1", JSON.stringify(saved));
    });
    await deferred.reload();
    await deferred.waitForSelector('.sim[data-agent="regional-manager"]', { state: "attached" });
    assert.equal(await deferred.locator('.sim[data-agent="regional-manager"]').getAttribute("transform"), "translate(0.0,160.0)",
      "restored positions are painted synchronously too");
    await deferred.evaluate(() => dispatchEvent(new ErrorEvent("error", {
      filename: location.origin + "/office.js", message: "Synthetic renderer failure",
    })));
    assert.equal(await deferred.locator("#officeError").isVisible(), true);
    assert.match(await deferred.locator("#officeError").textContent(), /Synthetic renderer failure/);
    await deferred.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
