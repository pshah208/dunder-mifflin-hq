import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const appPath = path.resolve("public", "app.js");
const stylesPath = path.resolve("public", "styles.css");

test("newChat opens created session and switches live scope", async () => {
  const src = await readFile(appPath, "utf8");
  assert.ok(src.includes("await openSession(created.id)"), "newChat should call openSession(created.id)");
});

test("new parallel opens same-origin new-session URL", async () => {
  const src = await readFile(appPath, "utf8");
  assert.ok(src.includes('u.searchParams.set("new", "1")'), "parallel launch should set ?new=1");
  assert.ok(!src.includes('window.open("about:blank"'), "parallel launch should not open about:blank");
});

test("pending UX shows kind-specific labels and jump link", async () => {
  const src = await readFile(appPath, "utf8");
  assert.ok(src.includes("function kindLabel("), "kind label helper should exist");
  assert.ok(src.includes("function jumpToPending(") && src.includes("function addQuestionCard("), "pending panel helper and inline question cards should exist");
});

test("office bubble animation styles stay scoped to office-page", async () => {
  const css = await readFile(stylesPath, "utf8");
  assert.ok(
    css.includes(".office-page .bubble {"),
    "expected scoped office bubble block",
  );
  assert.ok(
    !/^\s*\.bubble\s*\{[^}]*\bposition\s*:\s*absolute\b[^}]*\bopacity\s*:\s*0\b[^}]*\}/ms.test(css),
    "global .bubble must not carry office absolute/opacity styles",
  );
});
