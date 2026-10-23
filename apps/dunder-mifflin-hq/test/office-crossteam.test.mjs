import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SALES_IDS, ENGINEERING_IDS, REVIEW_IDS, teamOf, MICHAEL, LINE_CHARS, MICHAEL_GREETINGS, ENGINEERING_REPLIES, ENGINEERING_WORK_LINES,
  SALES_QUIPS, PAIR_BANTER, HANDOFF_LINES, pickScene, pickGreeting, pickHuddleLine, pickPair, pairKey, pickHandoff } from "../public/office-crossteam.js";

const rd = f => readFile(path.resolve("public", f), "utf8");
const lines = o => Object.values(o).flat();

test("team mapping uses sales, engineering and review ids", () => {
  assert.deepEqual(SALES_IDS, ["regional-manager", "sales-lead", "account-strategist", "office-administrator", "finance-analyst", "renewals-desk", "relationship-manager", "communications", "summarizer"]);
  assert.deepEqual(ENGINEERING_IDS, ["cloud-ai-architect", "product-manager", "automation-engineer", "presentation-designer"]);
  assert.deepEqual(REVIEW_IDS, ["qa-reviewer", "compliance-officer"]);
  for (const id of SALES_IDS) assert.equal(teamOf(id), "sales", id);
  for (const id of ENGINEERING_IDS) assert.equal(teamOf(id), "engineering", id);
  for (const id of REVIEW_IDS) assert.equal(teamOf(id), "review", id);
  assert.equal(teamOf("nobody"), null);
  assert.equal(new Set([...SALES_IDS, ...ENGINEERING_IDS, ...REVIEW_IDS]).size, 15);
});

test("line pools cover all active personas and stay original/bounded", () => {
  for (const id of ENGINEERING_IDS) for (const pool of [ENGINEERING_REPLIES, ENGINEERING_WORK_LINES, HANDOFF_LINES]) assert.ok(pool[id]?.length >= 2, `${id} missing lines`);
  for (const id of SALES_IDS) assert.ok(SALES_QUIPS[id]?.length >= 2, `${id} missing quip`);
  assert.ok(MICHAEL_GREETINGS.length >= 4 && PAIR_BANTER.length >= 6);
  const all = [...MICHAEL_GREETINGS, ...lines(ENGINEERING_REPLIES), ...lines(ENGINEERING_WORK_LINES), ...lines(SALES_QUIPS), ...lines(HANDOFF_LINES), ...PAIR_BANTER.flatMap(p => p.lines)];
  for (const l of all) { assert.ok(l.trim()); assert.ok(l.length <= LINE_CHARS, l); assert.ok(!/that's what she said|bears|beets|battlestar/i.test(l)); }
});

test("scene selection and pickers route Michael to the warehouse", () => {
  assert.equal(pickScene(["cloud-ai-architect", "automation-engineer"]).kind, "engineering");
  const mixed = pickScene(["account-strategist", "cloud-ai-architect", MICHAEL]);
  assert.equal(mixed.kind, "mixed"); assert.deepEqual(mixed.sales, ["account-strategist"]); assert.deepEqual(mixed.engineering, ["cloud-ai-architect"]);
  assert.equal(pickScene(["sales-lead", "finance-analyst"]).kind, "none");
  const g = pickGreeting(["cloud-ai-architect", "product-manager"], () => 0);
  assert.equal(g[0].id, MICHAEL); assert.equal(g[1].id, "cloud-ai-architect");
  assert.notEqual(pickHuddleLine(["cloud-ai-architect", "automation-engineer"], "cloud-ai-architect").id, "cloud-ai-architect");
  const pair = pickPair(["account-strategist"], ["product-manager"], () => 0);
  assert.deepEqual(pair.map(x => x.id), ["account-strategist", "product-manager"]);
  assert.equal(pairKey(pair), "account-strategist|product-manager");
  assert.ok(pickHandoff("automation-engineer", () => 0).includes("Michael"));
  assert.equal(pickHandoff("sales-lead"), null);
});

test("office wiring uses Dunder Mifflin tokens, rooms, new ids and no old theme references", async () => {
  const [js, html] = await Promise.all([rd("office.js"), rd("office.html")]);
  assert.match(js, /teamOf\(a\.agent\) === "engineering"/);
  assert.match(js, /is heading over to brief/);
  assert.match(js, /const SEATS = \{\r?\n  sales:/);
  assert.match(js, /"cloud-ai-architect"/);
  assert.match(html, /meta name="dm-token" content="__DM_TOKEN__"/);
  assert.match(js, /X-DM-Token/);
  assert.match(js + html, /Dunder Mifflin/);
});
