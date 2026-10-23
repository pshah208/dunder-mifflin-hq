import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MICHAEL, buildAliases, detectMentions, findMentions, isSocialRun, isReadTool, extractLines, buildScene, feedNote,
  sceneTimeline, sceneEndAt, HUDDLE_SPOTS, MAX_LINES, MAX_PARTICIPANTS, SCENE_MAX_MS, SCENE_MIN_MS } from "../public/office-social.js";
import { LOUNGE_SPOTS, LOUNGE_BOUNDS, PATH_BAND } from "../public/office-lounge.js";

const A = buildAliases();
const seen = (o = {}) => ({ observed: true, work: false, delegates: 0, ...o });

test("social run classification is conservative", () => {
  assert.equal(isSocialRun(seen(), { code: 0 }), true);
  assert.equal(isSocialRun(seen({ delegates: 1 })), false);
  assert.equal(isSocialRun(seen({ work: true })), false);
  assert.equal(isSocialRun(seen({ errored: true })), false);
  assert.equal(isSocialRun({ observed: false, work: false, delegates: 0 }), false);
  for (const t of ["view", "grep", "glob", "web_fetch"]) assert.equal(isReadTool(t), true);
  for (const t of ["edit", "powershell", "apply_patch", "", undefined]) assert.equal(isReadTool(t), false);
});

test("mentions use Dunder Mifflin aliases, boundaries and persona merge", () => {
  assert.deepEqual(detectMentions("Ask Jim, Pam, Dwight, Angela and Stanley", A), ["account-strategist", "office-administrator", "sales-lead", "finance-analyst"]);
  assert.equal(findMentions("Michael", A)[0].id, MICHAEL);
  assert.deepEqual(detectMentions("Ryanized and jammed are not aliases", A), []);
  const al = buildAliases([{ id: "automation-engineer", persona: "Darryl Philbin" }, { id: "qa-reviewer", persona: "Creed Bratton" }]);
  assert.deepEqual(detectMentions("Darryl and Creed", al), ["automation-engineer", "qa-reviewer"]);
  assert.equal(detectMentions("Jim Pam Dwight Angela Stanley Kevin", A).length, MAX_PARTICIPANTS);
});

test("quoted lines are attributed without copied show catchphrases", () => {
  const txt = 'Jim said, "The customer needs fewer forms and one good joke." Pam: "I can make that readable." Dwight replied, "Readable is acceptable if security remains intense." Michael: "Great, friendship and paper."';
  const lines = extractLines(txt, A);
  assert.deepEqual(lines.map(l => l.id), ["account-strategist", "office-administrator", "sales-lead", MICHAEL]);
  const scene = buildScene(txt, A);
  assert.deepEqual(scene.participants, [MICHAEL, "account-strategist", "office-administrator", "sales-lead"]);
  assert.equal(scene.quoted, true);
  assert.ok(scene.lines.length <= MAX_LINES);
  for (const l of scene.lines) assert.ok(!/that's what she said|bears|beets|battlestar/i.test(l.text));
});

test("fallback banter, feed notes and timeline are bounded", () => {
  const pool = { [MICHAEL]: ["Team moment."], "summarizer": ["Snack-sized recap."], "communications": ["I have gossip-shaped context."] };
  const s = buildScene("Kevin and Kelly should hear this.", A, { pool, rng: () => 0 });
  assert.deepEqual(s.lines.map(l => l.text), ["Team moment.", "Snack-sized recap.", "I have gossip-shaped context."]);
  assert.equal(feedNote([MICHAEL, "summarizer"], { [MICHAEL]: "Michael", summarizer: "Kevin" }), "Michael and Kevin are chatting in Café Disco");
  const tl = sceneTimeline([{ id: MICHAEL, text: "x" }, { id: "summarizer", text: "y" }], [MICHAEL, "summarizer"], { rng: () => 0 });
  assert.deepEqual(tl.steps.filter(s => s.kind === "say").map(s => s.at), [0, 3500]);
  assert.equal(sceneEndAt(2000, tl.end), SCENE_MIN_MS);
  assert.equal(sceneEndAt(30000, 30000), SCENE_MAX_MS);
});

test("social huddle spots sit in lounge areas and office wiring skips replay/demo/hidden", async () => {
  for (const [x, y] of HUDDLE_SPOTS) {
    assert.ok(x >= LOUNGE_BOUNDS.x0 && x <= LOUNGE_BOUNDS.x1 && y >= LOUNGE_BOUNDS.y0 && y <= LOUNGE_BOUNDS.y1);
    assert.ok(y < PATH_BAND.y0 || y > PATH_BAND.y1);
    for (const s of LOUNGE_SPOTS) assert.ok(Math.hypot(s.x - x, s.y - y) > 0.35);
  }
  const js = await readFile(path.resolve("public", "office.js"), "utf8");
  const block = js.slice(js.indexOf("// ---------- Social scene"), js.indexOf("// Idle life:"));
  assert.ok(!/\.active\s*=/.test(block));
  assert.ok(block.includes("state.replaying") && block.includes('state.source === "demo"') && block.includes("document.hidden"));
  assert.ok(block.includes("lounge.preempt"));
});

test("meeting tasks are recognised by Michael's prefix, not by any mention of ideas", async () => {
  const { isMeetingSummary, stripMeetingPrefix } = await import("../public/office-social.js");
  for (const yes of ["Meeting: brainstorm launch ideas", "meeting - kickoff", "Brainstorm: names for the pilot", "Conference room: QBR prep", "  MEETING — roadmap"]) assert.ok(isMeetingSummary(yes), yes);
  for (const no of ["Draft meeting notes", "Ideas for the deck", "Summarize the brainstorm thread", "", null]) assert.ok(!isMeetingSummary(no), String(no));
  assert.equal(stripMeetingPrefix("Meeting: brainstorm launch ideas"), "brainstorm launch ideas");
  const js = await readFile(path.resolve("public", "office.js"), "utf8");
  assert.match(js, /if \(meeting\.size\) goTo\(r, \.\.\.CONF_HEAD, "talk"\);/, "Michael runs meetings from the head of the table");
  assert.match(js, /if \(meeting\.has\(id\)\) \{\s+goTo\(s, \.\.\.confSeat\(\), "talk"\);/, "attendees walk to the conference room");
  assert.match(js, /summary: "Meeting: brainstorm launch ideas"/, "the demo shows a meeting");
});

test("character study in the Office: students read in the Break Room, learned lines join banter, study chats stay hidden", async () => {
  const js = await readFile(path.resolve("public", "office.js"), "utf8");
  assert.match(js, /run\.study = ev\.kind === "study";/);
  assert.match(js, /if \(studying\.has\(id\)\) goTo\(s, \.\.\.STUDY_SPOTS\[studyIdx\+\+ % STUDY_SPOTS\.length\], "read"\);/);
  assert.match(js, /case "persona_notes_updated":/);
  assert.match(js, /banter\.solo = mergeLearnedLines\(BANTER_SOLO, learned\)/);
  assert.match(js, /if \(s\.pose === "read" \|\| state\.studying\.has\(s\.m\.id\)\) text = STUDY_CHATTER/, "a student (even Michael) never echoes the raw study brief");
  const plan = js.slice(js.indexOf("function plan()"), js.indexOf("// ---------- Meetings"));
  assert.ok(!/\.active\s*=\s*true/.test(plan));
  const css = await readFile(path.resolve("public", "styles.css"), "utf8");
  assert.match(css, /\.office-page \.sim\.pose-read \.book \{ display: inline; \}/);
  const app = await readFile(path.resolve("public", "app.js"), "utf8");
  assert.match(app, /s\.kind !== "study" \|\| showStudyRuns\(\) \|\| s\.id === state\.sessionId/);
  const team = await readFile(path.resolve("public", "team.html"), "utf8");
  for (const id of ["studyEnabled", "studyTime", "studyPerRun", "studyNow", "studyProgress", "studyNext"]) assert.ok(team.includes(`id="${id}"`), id);
  const tjs = await readFile(path.resolve("public", "team.js"), "utf8");
  assert.match(tjs, /data-study="/, "every card can start its own study");
  assert.match(tjs, /rel="noopener noreferrer"/);
});
