import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const script = await readFile(new URL("../public/theme.js", import.meta.url), "utf8");
function harness(initial, blocked = false) {
  const handlers = {}, attrs = {}, warnings = [];
  const root = { dataset: {} };
  const storage = { getItem: () => { if (blocked) throw new Error("blocked"); return initial; },
    setItem: (key, value) => { if (blocked) throw new Error("blocked"); storage.saved = [key, value]; } };
  const button = { setAttribute: (key, value) => { attrs[key] = value; }, addEventListener: (key, fn) => { handlers[key] = fn; } };
  vm.runInNewContext(script, { localStorage: storage,
    document: { documentElement: root, getElementById: () => button, addEventListener: (key, fn) => { handlers[key] = fn; } },
    addEventListener: (key, fn) => { handlers[key] = fn; }, console: { warn: (...args) => warnings.push(args) },
  });
  return { root, button, storage, handlers, attrs, warnings };
}

test("theme applies before DOM ready, toggles, persists and synchronizes other tabs", () => {
  const h = harness("dark");
  assert.equal(h.root.dataset.theme, "dark");
  h.handlers.DOMContentLoaded();
  assert.equal(h.attrs["aria-pressed"], "true");
  h.handlers.click();
  assert.equal(h.root.dataset.theme, "light");
  assert.deepEqual(h.storage.saved, ["dm.theme", "light"]);
  h.handlers.storage({ storageArea: h.storage, key: "dm.theme", newValue: "dark" });
  assert.equal(h.root.dataset.theme, "dark");
  h.handlers.storage({ storageArea: h.storage, key: null, newValue: null });
  assert.equal(h.root.dataset.theme, "light");
  assert.equal(harness("invalid").root.dataset.theme, "light");
});

test("blocked storage leaves the toggle usable and reports the persistence failure", () => {
  const h = harness(null, true);
  h.handlers.DOMContentLoaded();
  h.handlers.click();
  assert.equal(h.root.dataset.theme, "dark");
  assert.equal(h.warnings.length, 2);
  assert.match(h.button.title, /could not be saved/);
});

test("Edge: dark theme covers all pages, persists, supports keyboard and fits mobile headers", {
  skip: process.env.DM_TEST_EDGE !== "1", timeout: 90000,
}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dm-theme-"));
  process.env.DM_DATA_DIR = tmp;
  process.env.DM_DISABLE_AZURE_DISCOVERY = "1";
  process.env.DM_DISABLE_MCP = "1";
  const { createServer, setSdkClientFactoryForTests, setAzTokenRunnerForTests } = await import("../server.mjs");
  setAzTokenRunnerForTests(async () => { throw new Error("Test: no Azure"); });
  setSdkClientFactoryForTests(() => ({ async listModels() { return [{ id: "test-model" }]; }, async stop() {} }));
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const { server } = createServer({ port, token: "theme-test", enableStudyScheduler: false, enableAutomationScheduler: false });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const base = `http://127.0.0.1:${port}`;
    await page.goto(base + "/automations.html");
    const toggle = page.getByRole("button", { name: "Dark theme", exact: true });
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    for (const route of ["/", "/team.html", "/office.html", "/automations.html"]) {
      await page.goto(base + route);
      assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", route);
      assert.equal(await page.getByRole("button", { name: "Dark theme", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(17, 23, 32)");
      await page.setViewportSize({ width: 390, height: 844 });
      const visibleHeader = await page.locator(".topbar").evaluate(el => {
        return [...el.querySelectorAll(".nav a, #themeToggle")].every(item => {
          const r = item.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.width > 0 && r.height > 0;
        });
      });
      assert.ok(visibleHeader, `${route}: every menu link and theme control stays on screen`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const colors = await page.locator(".automation-builder").evaluate(panel => {
      const read = el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor]; };
      const textarea = panel.querySelector("textarea");
      return [read(panel), read(textarea), read(panel.querySelector("button.primary")),
        [getComputedStyle(textarea, "::placeholder").color, getComputedStyle(textarea).backgroundColor]];
    });
    const lum = color => {
      const rgb = color.match(/\d+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    for (const [fg, bg] of colors) assert.ok((Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05) >= 4.5, `${fg} on ${bg} is readable`);
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    const other = await context.newPage();
    await other.goto(base + "/automations.html");
    await toggle.click();
    await other.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal(await other.getByRole("button", { name: "Dark theme", exact: true }).getAttribute("aria-pressed"), "false");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});
