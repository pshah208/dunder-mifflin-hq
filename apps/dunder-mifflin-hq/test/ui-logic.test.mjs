import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  validateAttachments, resizeByKey, clampWidth, sanitizeUiPrefs, paneColumn,
  PromptHistory, AutopilotGrants, initWindowScope, scopeKey,
  resolveStartSession, withSession, getWindowSession, setWindowSession, saveDraft, loadDraft,
} from "../public/ui-logic.js";

const MB = 1024 * 1024;
const img = (name, size = 1000, type = "image/png") => ({ name, size, type });
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; };

test("attachments: type, size, count and total limits", () => {
  assert.equal(validateAttachments([], [img("a.png")]).accepted.length, 1);
  assert.match(validateAttachments([], [img("a.gif", 10, "image/gif")]).errors[0], /PNG, JPEG or WebP/);
  assert.match(validateAttachments([], [img("big.png", 10 * MB + 1)]).errors[0], /10 MB/);
  assert.equal(validateAttachments([], [img("ten.png", 10 * MB)]).accepted.length, 1);
  const five = validateAttachments([], [1, 2, 3, 4, 5].map(i => img(`${i}.jpg`, 100, "image/jpeg")));
  assert.equal(five.accepted.length, 4); assert.match(five.errors[0], /at most 4/);
  const total = validateAttachments([], [img("a", 10 * MB), img("b", 10 * MB), img("c", 1)]);
  assert.equal(total.accepted.length, 2); assert.match(total.errors[0], /20 MB/);
  assert.match(validateAttachments([], [img("e", 0)]).errors[0], /empty/);
});

test("pane resize: keyboard steps, direction, clamping", () => {
  assert.equal(resizeByKey("ArrowRight", false, 300, 1), 316);
  assert.equal(resizeByKey("ArrowLeft", false, 300, 1), 284);
  assert.equal(resizeByKey("ArrowLeft", false, 300, -1), 316); // right pane grows leftwards
  assert.equal(resizeByKey("ArrowRight", true, 300, 1), 348);
  assert.equal(resizeByKey("Home", false, 300, 1), 200);
  assert.equal(resizeByKey("End", false, 300, 1), 520);
  assert.equal(resizeByKey("ArrowRight", false, 515, 1), 520);
  assert.equal(resizeByKey("Tab", false, 300, 1), null);
  assert.equal(clampWidth("abc"), null);
});

test("ui prefs sanitize corrupt or hostile storage", () => {
  assert.deepEqual(sanitizeUiPrefs("{not json"), sanitizeUiPrefs({}));
  const p = sanitizeUiPrefs({ leftW: 99999, rightW: 1, left: "evil", right: "compact", resourcesOpen: false, focus: true });
  assert.equal(p.leftW, 520); assert.equal(p.rightW, 200); assert.equal(p.left, "open"); assert.equal(p.right, "compact");
  assert.equal(p.resourcesOpen, false); assert.equal(p.focus, true);
  assert.equal(paneColumn("hidden", 300), 0); assert.equal(paneColumn("compact", 300), 56); assert.equal(paneColumn("open", 300), 300);
});

const ta = (value, start = value.length, end = start) => ({ value, selectionStart: start, selectionEnd: end });
const key = (k, extra = {}) => ({ key: k, ...extra });

test("prompt history: Up recalls newest, Down walks forward and restores empty draft", () => {
  const h = new PromptHistory(["one", "two"]);
  assert.equal(h.up(key("ArrowUp"), ta("")), "two");
  assert.equal(h.up(key("ArrowUp"), ta("two", 0)), "one");
  assert.equal(h.up(key("ArrowUp"), ta("one", 0)), null); // oldest: browser default
  assert.equal(h.down(key("ArrowDown"), ta("one")), "two");
  assert.equal(h.down(key("ArrowDown"), ta("two")), "");
  assert.equal(h.browsing, false);
  assert.equal(h.down(key("ArrowDown"), ta("")), null);
});

test("prompt history: does not hijack drafts, multiline, selections, modifiers or IME", () => {
  const h = new PromptHistory(["old"]);
  assert.equal(h.up(key("ArrowUp"), ta("typing a draft", 3)), null);
  assert.equal(h.up(key("ArrowUp", { shiftKey: true }), ta("")), null);
  assert.equal(h.up(key("ArrowUp", { isComposing: true }), ta("")), null);
  assert.equal(h.up(key("ArrowUp", { keyCode: 229 }), ta("")), null);
  assert.equal(h.up(key("ArrowUp"), ta("", 0, 0)), "old");
  const h2 = new PromptHistory(["a\nb", "c"]);
  h2.up(key("ArrowUp"), ta("")); // c
  assert.equal(h2.up(key("ArrowUp"), ta("c", 1)), "a\nb");
  // caret on 2nd line of a recalled multiline prompt: Up/Down move the caret normally
  assert.equal(h2.up(key("ArrowUp"), ta("a\nb", 3)), null);
  assert.equal(h2.down(key("ArrowDown"), ta("a\nb", 0)), null);
  assert.equal(h2.down(key("ArrowDown"), ta("a\nb", 3)), "c");
  assert.equal(h2.up(key("ArrowUp"), ta("c", 1, 0)), null); // selection range
});

test("prompt history: editing a recalled prompt makes it a new draft; histories are per conversation", () => {
  const h = new PromptHistory(["old"]);
  h.up(key("ArrowUp"), ta(""));
  assert.equal(h.down(key("ArrowDown"), ta("old edited")), null);
  assert.equal(h.browsing, false);
  const a = new PromptHistory(["a1"]), b = new PromptHistory(["b1"]);
  assert.equal(a.up(key("ArrowUp"), ta("")), "a1");
  assert.equal(b.up(key("ArrowUp"), ta("")), "b1");
  a.push("a2"); assert.equal(a.up(key("ArrowUp"), ta("")), "a2");
});

test("autopilot grants: scoped to conversation and repo/sub/RG, revocable, reset on change", () => {
  const g = new AutopilotGrants(mem());
  const t = { repoId: "r1", subscription: "s1", resourceGroup: "rg1" };
  assert.equal(g.isGranted("c1", t), false);
  g.grant("c1", t);
  assert.equal(g.isGranted("c1", t), true);
  assert.equal(g.isGranted("c2", t), false, "new conversation needs its own confirmation");
  assert.equal(g.isGranted("c1", { ...t, resourceGroup: "rg2" }), false);
  assert.equal(g.isGranted("c1", t), false, "target change clears the grant, switching back does not restore it");
  g.grant("c1", t); assert.equal(g.isGranted("c1", { ...t, repoId: "r2" }), false);
  g.grant("c1", t); g.revoke("c1"); assert.equal(g.isGranted("c1", t), false);
  assert.notEqual(scopeKey({ repoId: "a", subscription: "bc" }), scopeKey({ repoId: "ab", subscription: "c" }));
});

test("autopilot grants: a window opened by window.open (copied sessionStorage, empty window.name) does not inherit", () => {
  const store = mem();
  const win1 = { name: "" };
  initWindowScope(store, win1);
  const g1 = new AutopilotGrants(store);
  const t = { repoId: "r", subscription: "s", resourceGroup: "g" };
  g1.grant("c1", t);
  // reload of the same window keeps window.name and storage: grant survives
  initWindowScope(store, win1);
  assert.equal(g1.isGranted("c1", t), true);
  // cloned window: same sessionStorage contents, fresh window.name
  const clone = mem(); store._m.forEach((v, k) => clone._m.set(k, v));
  const win2 = { name: "" };
  initWindowScope(clone, win2);
  assert.equal(new AutopilotGrants(clone).isGranted("c1", t), false);
  assert.notEqual(win2.name, "");
  assert.equal(g1.isGranted("c1", t), true, "original window is unaffected");
});

test("source wiring: nonce guard, noopener, sibling delete buttons, no required textarea, office scoping", async () => {
  const dir = path.resolve("public");
  const [app, html, css, office] = await Promise.all(["app.js", "index.html", "styles.css", "office.js"].map(f => readFile(path.join(dir, f), "utf8")));
  assert.match(app, /initWindowScope\(sessionStorage, window\)/);
  assert.match(app, /window\.open\(u\.toString\(\), "_blank", "noopener"\)/);
  assert.match(app, /class="session-item[^"]*"[^>]*>[\s\S]*?<\/button>\s*<button type="button" class="icon-btn session-delete"/, "delete is a sibling of the select button");
  assert.ok(!/<textarea[^>]*\brequired\b/.test(html), "image-only messages must be allowed");
  assert.ok(!/<option>claude-/.test(html), "no hardcoded model options");
  for (const id of ["toggleTeam", "toggleTarget", "focusChat", "rzLeft", "rzRight", "connectors"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!html.includes('id="resCount"'), "no Azure resources list");
  assert.ok(!/headClip[\s\S]{0,40}r="19"/.test(office) && !/<circle cx="0" cy="-55" r="19"/.test(office), "coloured head disc removed");
  assert.ok(/stripAvatarBackground/.test(office));
});

test("office: avatar background stripping removes only the background disc and overlay", async () => {
  const src = await readFile(path.resolve("public", "office.js"), "utf8");
  const fn = src.match(/function stripAvatarBackground\(svg\) \{[\s\S]*?\n\}/)[0];
  const strip = new Function(`${fn}; return stripAvatarBackground;`)();
  const svg = await readFile(path.resolve("public", "avatars", "cloud-ai-architect.svg"), "utf8");
  const out = strip(svg);
  assert.ok(svg.includes('<rect width="128" height="128" fill="#2e8b57"/>'));
  assert.ok(!out.includes('<rect width="128" height="128"'));
  assert.ok(!out.includes('opacity=".08"'));
  for (const keep of ["<title>Oscar Martinez", "clip-path", "<path"]) assert.ok(out.includes(keep), keep);
});


test("navigation roundtrip: Chat -> Org chart -> Office -> Chat returns the same conversation and draft", () => {
  const store = mem(); const win = { name: "" };
  initWindowScope(store, win);
  // Chat creates conversation c1
  assert.equal(resolveStartSession({ urlSession: "", wantsNew: false, stored: getWindowSession(store) }).mode, "create");
  setWindowSession(store, "c1"); saveDraft(store, "c1", "half-typed prompt");
  // Same window navigates away and back (window.name and sessionStorage persist)
  for (const hop of ["/team.html", "/office.html"]) {
    initWindowScope(store, win);
    assert.equal(withSession(hop, getWindowSession(store)), `${hop}?session=c1`);
  }
  initWindowScope(store, win);
  const back = resolveStartSession({ urlSession: "", wantsNew: false, stored: getWindowSession(store) });
  assert.deepEqual(back, { mode: "existing", id: "c1" });
  assert.equal(loadDraft(store, "c1"), "half-typed prompt");
  // explicit id wins, ?new=1 alone creates new
  assert.equal(resolveStartSession({ urlSession: "c9", wantsNew: false, stored: "c1" }).id, "c9");
  assert.equal(resolveStartSession({ urlSession: "", wantsNew: true, stored: "c1" }).mode, "new");
});

test("parallel window keeps its own conversation: cloned sessionStorage is wiped of session, drafts and grants", () => {
  const a = mem(); const wa = { name: "" }; initWindowScope(a, wa);
  setWindowSession(a, "c1"); saveDraft(a, "c1", "draft");
  new AutopilotGrants(a).grant("c1", { repoId: "r" });
  const b = mem(); a._m.forEach((v, k) => b._m.set(k, v)); b.length = 0;
  const keys = [...b._m.keys()]; Object.defineProperty(b, "length", { get: () => keys.length }); b.key = i => keys[i];
  initWindowScope(b, { name: "" });
  assert.equal(getWindowSession(b), ""); assert.equal(loadDraft(b, "c1", ""), "");
  assert.equal(new AutopilotGrants(b).isGranted("c1", { repoId: "r" }), false);
  assert.equal(getWindowSession(a), "c1", "original window unaffected");
  assert.equal(withSession("/?new=1&x=1", "c2"), "/?x=1&session=c2");
});

test("pages load nav.js, chat persists session per window (not localStorage)", async () => {
  const dir = path.resolve("public");
  const [team, office, app, nav] = await Promise.all(["team.html", "office.html", "app.js", "nav.js"].map(f => readFile(path.join(dir, f), "utf8")));
  assert.match(team, /src="nav\.js"/); assert.match(office, /src="nav\.js"/);
  assert.match(app, /from "\.\/nav\.js"/);
  assert.match(app, /setWindowSession\(sessionStorage, id\)/);
  assert.ok(!/localStorage[^;]*(session|draft)/i.test(app.replace(/pp\.(ui|sub|rg|repo|agentModels)/g, "")), "current conversation/draft must not use localStorage");
  assert.match(nav, /updateNavLinks/);
});
test("hidden attribute always wins over author display rules (autopilot banner, previews, panes, resources, stop)", async () => {
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/m);
  // The banner and preview list set display:flex themselves, so they depend on that rule.
  assert.match(css, /\.autopilot-state\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.attach-preview\s*\{[^}]*display:\s*flex/);
  const html = await readFile(path.resolve("public", "index.html"), "utf8");
  assert.match(html, /id="autopilotState"[^>]*\bhidden\b/, "banner starts hidden");
});
test("QA regressions: send keeps draft until accepted, vision label, repo pin from response, delete race, live delete", async () => {
  const app = await readFile(path.resolve("public", "app.js"), "utf8");
  const send = app.slice(app.indexOf("async function send(e)"), app.indexOf("// ---------- Attachments"));
  const iChat = send.indexOf('api("/api/chat"');
  for (const late of ["history_(state.sessionId).push(message)", 'addUserMsg(message', '$("#input").value = ""', "state.attachments = state.attachments.filter(a => !items.includes(a))"]) {
    assert.ok(send.indexOf(late) > iChat, `${late} must happen only after /api/chat is accepted`);
  }
  assert.ok(!send.includes("state.attachments = []"), "new screenshots staged during upload are preserved");
  assert.match(app, /it\.uploadedId = r\.id/, "uploads are reused on retry");
  assert.match(send, /accepted\?\.repoId/);
  assert.match(send, /leadLacksVision\(\)/);
  assert.match(app, /m\.supportsVision \? "" : " \(no images\)"/);
  assert.ok(!/supportsVision === false/.test(app));
  assert.match(app, /else state\.repoId = state\.defaultRepoId;/);
  assert.match(app, /dlg\.addEventListener\("cancel", block\)/);
  assert.match(app, /case "session_deleted":/);
});
test("collapsedTeams pref is sanitized and team ids are stable", async () => {
  const { COLLAPSIBLE_TEAMS, teamMembersId } = await import("../public/ui-logic.js");
  assert.deepEqual(sanitizeUiPrefs({}).collapsedTeams, []);
  assert.deepEqual(sanitizeUiPrefs({ collapsedTeams: ["sales", "lead", "x"] }).collapsedTeams, ["sales"]);
  assert.deepEqual(sanitizeUiPrefs({ collapsedTeams: "bad" }).collapsedTeams, []);
  assert.deepEqual(COLLAPSIBLE_TEAMS, ["sales", "engineering"]);
  assert.equal(teamMembersId("Dunder Mifflin!"), "roster-members-dunder-mifflin-");
});

test("elicitation form: confirm boxes start unchecked and required fields block submit", async () => {
  const { elicitationInitialValues, elicitationMissing } = await import("../public/ui-logic.js");
  const fields = [{ name: "confirm", type: "boolean", required: true, default: true }, { name: "note", type: "string", required: false }, { name: "kind", type: "string", enum: ["x", "y"], required: true }];
  const v = elicitationInitialValues(fields);
  assert.deepEqual(v, { confirm: false, note: "", kind: "x" }, "a server default of true never pre-ticks the confirmation");
  assert.deepEqual(elicitationMissing(fields, v), ["confirm"]);
  v.confirm = true;
  assert.deepEqual(elicitationMissing(fields, v), []);
  const app = await readFile(path.resolve("public", "app.js"), "utf8");
  assert.match(app, /case "elicitation_required":/);
  assert.match(app, /"\/api\/elicitations\/respond"/);
});
