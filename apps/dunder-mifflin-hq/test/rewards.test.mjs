import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LEAD_ID, TOBY_ID, WEIGHTS, applyFeedback, buildRunRecord, buildScorecardPromptBlock, createRunTracker, parseTobyVerdicts,
  pickDundies, recordSignals, scoreAgents, summarizeLedger, tobySubjects, upsertRecord, validateFeedback,
} from "../rewards.mjs";
import { awardBadges, dundieListHtml, feedbackReaction, leaderboardRows } from "../public/office-dundies.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const daysAgo = d => new Date(NOW - d * 86_400_000).toISOString();
const rec = (over = {}) => ({ ...buildRunRecord({ sessionId: "s", runId: over.runId || Math.random().toString(36).slice(2), at: over.at || daysAgo(0), snapshot: { agents: over.agents || [LEAD_ID], failed: over.failed || [], toby: over.toby || null } }), ...over });

test("parses Toby's verdict lines, including markdown and CHANGES REQUIRED as a rejection", () => {
  assert.deepEqual(parseTobyVerdicts("All good.\nTOBY VERDICT: APPROVED"), [{ verdict: "approved", for: [] }]);
  assert.deepEqual(parseTobyVerdicts("**TOBY VERDICT:** REJECTED — shares pricing"), [{ verdict: "rejected", for: [] }]);
  assert.deepEqual(parseTobyVerdicts("> Toby verdict - changes required"), [{ verdict: "rejected", for: [] }]);
  assert.deepEqual(parseTobyVerdicts("TOBY VERDICT: REJECTED (for: product-manager, Sales-Lead) — risky"), [{ verdict: "rejected", for: ["product-manager", "sales-lead"] }]);
  assert.deepEqual(parseTobyVerdicts("Toby said the verdict was approved"), [], "prose mentions are not verdicts");
  assert.deepEqual(parseTobyVerdicts(""), []);
});

test("run tracker credits participants and ignores a verdict unless Toby took part", () => {
  const t = createRunTracker();
  t.observe({ t: "delegate", agent: "product-manager" });
  t.observe({ t: "message", id: "m1", text: "TOBY VERDICT: APPROVED" });
  assert.equal(t.snapshot().toby, null, "Michael can't award Toby's seal without Toby");
  t.observe({ t: "agent_start", agent: TOBY_ID });
  t.observe({ t: "message", id: "t1", text: "TOBY VERDICT: REJECTED — no" }, "sub-toby");
  t.observe({ t: "message", id: "m2", text: "Toby re-reviewed the fix.\n- TOBY VERDICT: APPROVED" });
  t.observe({ t: "agent_end", agent: "product-manager", ok: false, error: "x" });
  t.observe({ t: "agent_end", agent: TOBY_ID, ok: false, cancelled: true });
  const snap = t.snapshot();
  assert.deepEqual(snap.agents.sort(), [TOBY_ID, "product-manager", LEAD_ID].sort());
  assert.deepEqual(snap.failed, ["product-manager"], "cancelled is not a failure");
  assert.deepEqual(snap.toby, { verdict: "approved", for: [] }, "the latest verdict wins");
  t.observe({ t: "delegate", agent: "../../etc" });
  assert.ok(!t.snapshot().agents.includes("../../etc"), "agent ids are validated");
});

test("Toby's verdict credits named agents, else reviewed specialists, else Michael — never Toby himself", () => {
  assert.deepEqual(tobySubjects(rec({ agents: [LEAD_ID, TOBY_ID, "product-manager", "sales-lead"], toby: { verdict: "approved", for: ["sales-lead"] } })), ["sales-lead"]);
  assert.deepEqual(tobySubjects(rec({ agents: [LEAD_ID, TOBY_ID, "product-manager"], toby: { verdict: "rejected", for: [] } })), ["product-manager"]);
  assert.deepEqual(tobySubjects(rec({ agents: [LEAD_ID, TOBY_ID], toby: { verdict: "approved", for: [] } })), [LEAD_ID]);
  const named = buildRunRecord({ sessionId: "s", runId: "r", snapshot: { agents: [TOBY_ID, "communications"], failed: [], toby: { verdict: "approved", for: [TOBY_ID, "not-in-run", "communications"] } } });
  assert.deepEqual(named.toby.for, ["communications"], "verdict subjects must have taken part, and Toby can't approve himself");
});

test("feedback validation rejects anything but up/down/null and booleans", () => {
  assert.deepEqual(validateFeedback({ rating: "up" }), { rating: "up" });
  assert.deepEqual(validateFeedback({ rating: null, usedAsWritten: true }), { rating: null, usedAsWritten: true });
  for (const bad of [{}, { rating: "meh" }, { usedAsWritten: "yes" }, { rating: 1 }]) assert.throws(() => validateFeedback(bad), e => e.status === 400);
});

test("signals: thumbs and used-as-written credit every participant; failures only the failed agent", () => {
  const r = applyFeedback(rec({ agents: [LEAD_ID, "finance-analyst"], failed: ["finance-analyst"] }), { rating: "up", usedAsWritten: true });
  const kinds = recordSignals(r).map(s => `${s.id}:${s.kind}`).sort();
  assert.deepEqual(kinds, ["finance-analyst:failed", "finance-analyst:up", "finance-analyst:used", `${LEAD_ID}:up`, `${LEAD_ID}:used`].sort());
});

test("a thumbs down costs more than a thumbs up earns, and old work decays", () => {
  assert.ok(Math.abs(WEIGHTS.down) > WEIGHTS.up, "speed never beats accuracy");
  const ledger = [
    applyFeedback(rec({ agents: [LEAD_ID, "sales-lead"], at: daysAgo(0) }), { rating: "up" }),
    applyFeedback(rec({ agents: [LEAD_ID, "renewals-desk"], at: daysAgo(60) }), { rating: "up" }),
  ];
  const card = Object.fromEntries(scoreAgents(ledger, { now: NOW }).map(s => [s.id, s]));
  assert.equal(card["sales-lead"].score, 2);
  assert.equal(card["renewals-desk"].score, 0.5, "60 days at a 30-day half-life is a quarter");
});

test("reliability is smoothed and streaks reset on a 👎 or a Toby rejection", () => {
  const ledger = [
    applyFeedback(rec({ agents: [LEAD_ID, "communications"], at: daysAgo(5) }), { rating: "up" }),
    applyFeedback(rec({ agents: [LEAD_ID, "communications"], at: daysAgo(4) }), { rating: "down" }),
    applyFeedback(rec({ agents: [LEAD_ID, "communications"], at: daysAgo(3) }), { usedAsWritten: true }),
    rec({ agents: [LEAD_ID, "communications"], at: daysAgo(2) }), // unrated: neutral, keeps the streak
    applyFeedback(rec({ agents: [LEAD_ID, "communications"], at: daysAgo(1) }), { rating: "up" }),
  ];
  const kelly = scoreAgents(ledger, { now: NOW }).find(s => s.id === "communications");
  assert.equal(kelly.streak, 2);
  assert.equal(kelly.runs, 5);
  assert.equal(kelly.reliability, (3 + 1) / (4 + 2));
  const one = scoreAgents([applyFeedback(rec({ agents: [LEAD_ID] }), { rating: "up" })], { now: NOW })[0];
  assert.ok(one.reliability < 1, "one lucky 👍 is not 100%");
  assert.equal(one.confidence, "low");
});

test("Dundies need a minimum track record and pick clear winners", () => {
  assert.deepEqual(pickDundies(scoreAgents([applyFeedback(rec(), { rating: "up" })], { now: NOW })).map(a => a.category), ["fan"], "one 👍 earns Fan Favorite only");
  const ledger = [];
  for (let i = 0; i < 3; i++) ledger.push(applyFeedback(rec({ agents: [LEAD_ID, TOBY_ID, "product-manager"], toby: { verdict: "approved", for: ["product-manager"] }, at: daysAgo(i) }), { usedAsWritten: true }));
  for (let i = 0; i < 2; i++) ledger.push(rec({ agents: [LEAD_ID, TOBY_ID, "sales-lead"], toby: { verdict: "rejected", for: ["sales-lead"] }, at: daysAgo(i) }));
  const awards = Object.fromEntries(pickDundies(scoreAgents(ledger, { now: NOW })).map(a => [a.category, a]));
  assert.equal(awards.toby.winner, "product-manager");
  assert.equal(awards.toby.value, 100);
  assert.equal(awards["drawing-board"].winner, "sales-lead");
  assert.equal(awards.streak.winner, "product-manager");
  assert.ok(awards.mvp && awards.used);
  assert.deepEqual(summarizeLedger(ledger), { runs: 5, rated: 0, up: 0, down: 0, usedAsWritten: 3, tobyApproved: 3, tobyRejected: 2 });
});

test("scorecard prompt block only lists agents with enough signals and keeps the guardrail", () => {
  assert.equal(buildScorecardPromptBlock(scoreAgents([applyFeedback(rec(), { rating: "up" })], { now: NOW })), "", "no block from thin data");
  const ledger = [1, 2, 3].map(d => applyFeedback(rec({ agents: [LEAD_ID, "finance-analyst"], at: daysAgo(d) }), { rating: "up" }));
  const block = buildScorecardPromptBlock(scoreAgents(ledger, { now: NOW }));
  assert.match(block, /^\[SCORECARD\]/);
  assert.match(block, /finance-analyst: reliability 80%/);
  assert.match(block, /tie-breaker/);
  assert.match(block, /Never skip Toby\/Creed reviews, approvals/);
});

test("ledger upsert replaces by id and caps its size", () => {
  let ledger = [];
  for (let i = 0; i < 5; i++) ledger = upsertRecord(ledger, { id: `s:${i}` }, 3);
  assert.deepEqual(ledger.map(r => r.id), ["s:2", "s:3", "s:4"]);
  ledger = upsertRecord(ledger, { id: "s:3", rating: "up" }, 3);
  assert.deepEqual(ledger.map(r => r.id), ["s:2", "s:4", "s:3"]);
});

test("Office Dundies board escapes names and badges winners", () => {
  const team = [{ id: "product-manager", persona: "Ryan <Howard>", color: "#123456", initials: "RH" }];
  const awards = [{ category: "fan", icon: "👍", title: "Fan Favorite Dundie", blurb: "b", winner: "product-manager", value: 3, unit: "👍" }];
  const html = dundieListHtml(awards, team);
  assert.match(html, /Ryan &lt;Howard&gt;/);
  assert.ok(!html.includes("<Howard>"));
  assert.deepEqual(awardBadges(awards), { "product-manager": ["👍"] });
  assert.equal(leaderboardRows([{ id: "x", score: 0, positives: 0, negatives: 0 }], team), "", "silent agents are not ranked");
  assert.match(leaderboardRows([{ id: "product-manager", score: 2, reliability: 0.67, confidence: "low", positives: 1, negatives: 0, up: 1, down: 0, used: 0, approved: 0, rejected: 0, streak: 1 }], team), /67%/);
});

test("Office reacts only to the feedback that changed", () => {
  assert.equal(feedbackReaction({ rating: "up", usedAsWritten: true, changed: ["rating"], agents: [LEAD_ID] }).feed[0], "👍");
  assert.equal(feedbackReaction({ rating: null, usedAsWritten: true, changed: ["usedAsWritten"], agents: [LEAD_ID, "summarizer"] }).feed[0], "📋");
  assert.equal(feedbackReaction({ rating: null, usedAsWritten: false, changed: ["usedAsWritten"], agents: [LEAD_ID] }), null);
  assert.equal(feedbackReaction({ rating: null, changed: ["rating"], agents: [LEAD_ID] }), null);
});

test("Toby and Michael are instructed to emit and relay the verdict line the ledger parses", async () => {
  const toby = await readFile(new URL("../../../.github/agents/compliance-officer.agent.md", import.meta.url), "utf8");
  const michael = await readFile(new URL("../../../.github/agents/regional-manager.agent.md", import.meta.url), "utf8");
  const example = /`(TOBY VERDICT: [^`]+)`/.exec(toby)?.[1];
  assert.ok(example, "Toby documents the verdict line");
  assert.equal(parseTobyVerdicts(example).length, 1, "the documented format is what the parser reads");
  assert.match(michael, /TOBY VERDICT:/);
  assert.match(michael, /\[SCORECARD\]/);
});
