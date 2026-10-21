import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canUseFolder, canBrowse, parentDir, browseStartPath, breadcrumbs, fsDirsUrl } from "../public/ui-logic.js";

test("Use this folder is enabled only for a git repository", () => {
  assert.equal(canUseFolder({ path: "C:\\code\\app", isGitRepo: true }), true);
  assert.equal(canUseFolder({ path: "C:\\code", isGitRepo: false }), false);
  assert.equal(canUseFolder(null), false);
  assert.equal(canUseFolder({ isGitRepo: true }), false);
});

test("Browse follows the pinned lock", () => {
  assert.equal(canBrowse({ pinned: true }), false);
  assert.equal(canBrowse({ pinned: false }), true);
});

test("start path is the selected repo's parent; breadcrumbs and URL helpers", () => {
  const repos = [{ id: "r1", path: "C:\\code\\my-repo" }, { id: "r2", path: "/home/me/app" }];
  assert.equal(browseStartPath(repos, "r1"), "C:\\code");
  assert.equal(browseStartPath(repos, "r2"), "/home/me");
  assert.equal(browseStartPath(repos, ""), "");
  assert.equal(parentDir("C:\\code"), "C:\\");
  assert.deepEqual(breadcrumbs("C:\\code\\x").map(c => c.path), ["C:\\", "C:\\code", "C:\\code\\x"]);
  assert.equal(fsDirsUrl(""), "/api/fs/dirs");
  assert.equal(fsDirsUrl("C:\\a b"), "/api/fs/dirs?path=C%3A%5Ca%20b");
});

test("chat UI has no repository picker, folder browser or Azure target", async () => {
  const src = await readFile(path.resolve("public", "app.js"), "utf8");
  const html = await readFile(path.resolve("public", "index.html"), "utf8");
  for (const id of ["repo", "repoPath", "repoAdd", "repoBrowse", "folderDlg", "sub", "rg", "resources", "targetSummary"]) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(!/api\/azure\//.test(src), "no Azure discovery calls from the chat page");
  assert.ok(!src.includes("/api/fs/dirs") && !src.includes('"/api/repos", { method: "POST"'));
  assert.match(src, /function target\(\) \{ return \{\}; \}/);
  assert.ok(html.includes('id="connectors"') && html.includes('id="activity"') && html.includes('id="pending"'));
});
test("folder browser CSS is global-safe and Office rules stay scoped after the marker", async () => {
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.ok(css.indexOf(".folder-dlg") < css.indexOf("/* Office: cafe & lounge"));
  const tail = css.slice(css.indexOf("/* Office: cafe & lounge"));
  const bad = tail.split("}").map(r => r.split("{")[0].trim()).filter(sel => sel && !sel.startsWith("@") && !sel.startsWith("/*") && !/^(\d+%|from|to)$/.test(sel) && !sel.split(",").every(s => s.trim().startsWith(".office-page")));
  assert.deepEqual(bad, []);
});
