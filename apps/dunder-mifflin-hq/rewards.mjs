// Dunder Mifflin HQ — reward ledger, per-agent scorecard and Dundie awards.
// Pure functions only: the server persists the ledger and calls these to score it.
// The ledger stores ids, verdicts and feedback flags — never message text, customer data or personal data.

export const LEAD_ID = "regional-manager";
export const TOBY_ID = "compliance-officer";
export const LEDGER_LIMIT = 2000;
export const HALF_LIFE_DAYS = 30;
export const RE_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

// Points per signal. A 👎 or a Toby rejection costs more than a 👍 earns, so speed never beats getting it right.
export const WEIGHTS = Object.freeze({ up: 2, down: -3, used: 3, approved: 2, rejected: -2, failed: -1 });

const MAX_AGENTS_PER_RUN = 20;
const uniq = arr => [...new Set(arr)];
const isId = id => typeof id === "string" && RE_AGENT_ID.test(id);

// Toby ends each review with one line: `TOBY VERDICT: APPROVED` or `TOBY VERDICT: REJECTED — reason`,
// optionally naming whose work it was: `TOBY VERDICT: REJECTED (for: product-manager, sales-lead) — reason`.
// "CHANGES REQUIRED" counts as a rejection: the work could not ship as written.
const RE_VERDICT = /^[\s>*_`#-]*TOBY\s+VERDICT\s*[:\-–—]\s*[*_`]*\s*(APPROVED?|REJECTED?|CHANGES\s+REQUIRED)\b(.*)$/gim;
export function parseTobyVerdicts(text) {
  const out = [];
  for (const m of String(text || "").matchAll(RE_VERDICT)) {
    const verdict = /^APPROVE/i.test(m[1]) ? "approved" : "rejected";
    const forMatch = /\bfor\s*:\s*([a-z0-9 ,\-]+)/i.exec(m[2] || "");
    const forIds = forMatch ? uniq(forMatch[1].split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(isId)) : [];
    out.push({ verdict, for: forIds });
  }
  return out;
}

// Follows one run's reduced live events: who took part, who failed, and Toby's latest verdict.
export function createRunTracker() {
  const agents = new Set([LEAD_ID]);
  const failed = new Set();
  const verdictsByMessage = new Map(); // de-duplicates a message seen as both delta-final and message
  return {
    observe(ev, agentId = null) {
      if (!ev || typeof ev !== "object") return;
      if ((ev.t === "delegate" || ev.t === "agent_start") && isId(ev.agent) && agents.size < MAX_AGENTS_PER_RUN) agents.add(ev.agent);
      if (ev.t === "agent_end" && isId(ev.agent) && ev.ok === false && !ev.cancelled) failed.add(ev.agent);
      if (ev.t === "message") {
        const verdicts = parseTobyVerdicts(ev.text);
        if (verdicts.length) {
          verdictsByMessage.delete(`${agentId || "lead"}:${ev.id}`); // keep insertion order = latest last
          verdictsByMessage.set(`${agentId || "lead"}:${ev.id}`, verdicts.at(-1));
        }
      }
    },
    snapshot() {
      // A verdict only counts when Toby actually took part in the run, so nobody can award themselves his seal.
      const last = agents.has(TOBY_ID) ? [...verdictsByMessage.values()].at(-1) || null : null;
      return { agents: [...agents], failed: [...failed].filter(id => agents.has(id)), toby: last };
    },
  };
}

export function buildRunRecord({ sessionId, runId, at = new Date().toISOString(), mode = null, snapshot }) {
  const snap = snapshot || { agents: [LEAD_ID], failed: [], toby: null };
  const agents = uniq([LEAD_ID, ...(snap.agents || []).filter(isId)]).slice(0, MAX_AGENTS_PER_RUN);
  return {
    id: `${sessionId}:${runId}`,
    sessionId,
    runId,
    at,
    mode,
    agents,
    failed: (snap.failed || []).filter(id => agents.includes(id)),
    toby: snap.toby && agents.includes(TOBY_ID)
      ? { verdict: snap.toby.verdict === "approved" ? "approved" : "rejected", for: (snap.toby.for || []).filter(id => agents.includes(id) && id !== TOBY_ID) }
      : null,
    rating: null,
    usedAsWritten: false,
    ratedAt: null,
  };
}

export function validateFeedback(body = {}) {
  const out = {};
  if ("rating" in body) {
    if (![null, "up", "down"].includes(body.rating)) throw Object.assign(new Error("rating must be up, down or null"), { status: 400 });
    out.rating = body.rating;
  }
  if ("usedAsWritten" in body) {
    if (typeof body.usedAsWritten !== "boolean") throw Object.assign(new Error("usedAsWritten must be true or false"), { status: 400 });
    out.usedAsWritten = body.usedAsWritten;
  }
  if (!Object.keys(out).length) throw Object.assign(new Error("nothing to record"), { status: 400 });
  return out;
}

export function applyFeedback(record, patch, at = new Date().toISOString()) {
  return { ...record, ...patch, ratedAt: at };
}

export function upsertRecord(ledger, record, limit = LEDGER_LIMIT) {
  const list = (Array.isArray(ledger) ? ledger : []).filter(r => r?.id !== record.id);
  list.push(record);
  return list.slice(-limit);
}

// Who a Toby verdict is about: the named agents, else the specialists whose work he reviewed, else Michael's own draft.
export function tobySubjects(record) {
  if (!record?.toby) return [];
  if (record.toby.for?.length) return record.toby.for;
  const specialists = record.agents.filter(id => id !== LEAD_ID && id !== TOBY_ID);
  return specialists.length ? specialists : [LEAD_ID];
}

// Signals one record gives each agent: [{ id, kind }] where kind is a WEIGHTS key.
export function recordSignals(record) {
  const out = [];
  if (!record || !Array.isArray(record.agents)) return out;
  for (const id of record.agents) {
    if (record.rating === "up") out.push({ id, kind: "up" });
    if (record.rating === "down") out.push({ id, kind: "down" });
    if (record.usedAsWritten) out.push({ id, kind: "used" });
  }
  for (const id of tobySubjects(record)) out.push({ id, kind: record.toby.verdict === "approved" ? "approved" : "rejected" });
  for (const id of record.failed || []) out.push({ id, kind: "failed" });
  return out;
}

const POSITIVE = new Set(["up", "used", "approved"]);
const NEGATIVE = new Set(["down", "rejected", "failed"]);
const blankStats = id => ({ id, score: 0, runs: 0, up: 0, down: 0, used: 0, approved: 0, rejected: 0, failed: 0, positives: 0, negatives: 0, streak: 0, reliability: 0.5, confidence: "none" });

// Time-decayed scorecard: recent work counts more (half-life HALF_LIFE_DAYS) so an agent can recover from a bad week.
export function scoreAgents(ledger, { now = Date.now(), halfLifeDays = HALF_LIFE_DAYS, ids = null } = {}) {
  const stats = new Map();
  const get = id => { if (!stats.has(id)) stats.set(id, blankStats(id)); return stats.get(id); };
  if (ids) ids.forEach(get);
  const records = [...(Array.isArray(ledger) ? ledger : [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const r of records) {
    const ageDays = Math.max(0, (now - Date.parse(r.at || 0)) / 86_400_000);
    const decay = Number.isFinite(ageDays) ? 0.5 ** (ageDays / halfLifeDays) : 0;
    for (const id of r.agents || []) if (!ids || ids.includes(id)) get(id).runs++;
    const byAgent = new Map();
    for (const { id, kind } of recordSignals(r)) {
      if (ids && !ids.includes(id)) continue;
      const s = get(id);
      s[kind]++;
      s.score += WEIGHTS[kind] * decay;
      if (!byAgent.has(id)) byAgent.set(id, { pos: false, neg: false });
      if (POSITIVE.has(kind)) { s.positives++; byAgent.get(id).pos = true; }
      if (NEGATIVE.has(kind)) { s.negatives++; byAgent.get(id).neg = true; }
    }
    // Streak = consecutive rewarded runs with no 👎, rejection or failure.
    for (const [id, o] of byAgent) { const s = get(id); s.streak = o.neg ? 0 : (o.pos ? s.streak + 1 : s.streak); }
  }
  for (const s of stats.values()) {
    const n = s.positives + s.negatives;
    s.reliability = (s.positives + 1) / (n + 2); // Laplace-smoothed: one lucky 👍 is not 100%
    s.confidence = n === 0 ? "none" : n < 3 ? "low" : n < 10 ? "medium" : "high";
    s.score = Math.round(s.score * 10) / 10;
  }
  return [...stats.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// The Dundies: original, light-hearted categories. Each has a minimum so one data point never wins a trophy.
export const DUNDIE_CATEGORIES = Object.freeze([
  { id: "mvp", icon: "🏆", title: "Dundie MVP", blurb: "Highest overall score", min: s => s.score > 0 && s.positives >= 2, value: s => s.score, unit: "pts" },
  { id: "used", icon: "📋", title: "The Ctrl+C, Ctrl+V Dundie", blurb: "Most answers used exactly as written", min: s => s.used >= 1, value: s => s.used, unit: "used as written" },
  { id: "toby", icon: "✅", title: "Toby's Seal of Approval", blurb: "Best approval rate from Toby", min: s => s.approved + s.rejected >= 2 && s.approved >= 1, value: s => s.approved / (s.approved + s.rejected), unit: "approved", pct: true },
  { id: "fan", icon: "👍", title: "Fan Favorite Dundie", blurb: "Most thumbs up from you", min: s => s.up >= 1, value: s => s.up, unit: "👍" },
  { id: "streak", icon: "🔥", title: "Hottest Streak in the Office", blurb: "Longest current run without a 👎 or rejection", min: s => s.streak >= 3, value: s => s.streak, unit: "in a row" },
  { id: "drawing-board", icon: "📝", title: "Back to the Drawing Board", blurb: "Most ideas sent back by Toby (it builds character)", min: s => s.rejected >= 2, value: s => s.rejected, unit: "rejected" },
]);

export function pickDundies(scorecard) {
  const awards = [];
  for (const c of DUNDIE_CATEGORIES) {
    const eligible = scorecard.filter(c.min);
    if (!eligible.length) continue;
    const best = eligible.sort((a, b) => c.value(b) - c.value(a) || b.score - a.score || a.id.localeCompare(b.id))[0];
    const v = c.value(best);
    awards.push({ category: c.id, icon: c.icon, title: c.title, blurb: c.blurb, winner: best.id, value: c.pct ? Math.round(v * 100) : Math.round(v * 10) / 10, unit: c.pct ? `% ${c.unit}` : c.unit });
  }
  return awards;
}

export function summarizeLedger(ledger) {
  const list = Array.isArray(ledger) ? ledger : [];
  return {
    runs: list.length,
    rated: list.filter(r => r.rating).length,
    up: list.filter(r => r.rating === "up").length,
    down: list.filter(r => r.rating === "down").length,
    usedAsWritten: list.filter(r => r.usedAsWritten).length,
    tobyApproved: list.filter(r => r.toby?.verdict === "approved").length,
    tobyRejected: list.filter(r => r.toby?.verdict === "rejected").length,
  };
}

// Compact routing hint for Michael. Scores only break ties between specialists who already fit the task;
// they never skip reviews, approvals, citations or freshness warnings.
export function buildScorecardPromptBlock(scorecard, { minSignals = 3, max = 8 } = {}) {
  const rated = scorecard.filter(s => s.positives + s.negatives >= minSignals).slice(0, max);
  if (!rated.length) return "";
  const lines = ["[SCORECARD]"];
  for (const s of rated) {
    lines.push(`- ${s.id}: reliability ${Math.round(s.reliability * 100)}% (${s.confidence}, ${s.positives + s.negatives} signals); used-as-written ${s.used}; Toby ${s.approved}✓/${s.rejected}✗`);
  }
  lines.push("Use this only as a tie-breaker when several specialists fit. Never skip Toby/Creed reviews, approvals, sources or freshness warnings to chase a score. Don't mention scores unless the user asks.");
  lines.push("[/SCORECARD]");
  return lines.join("\n");
}
