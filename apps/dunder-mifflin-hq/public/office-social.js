// Dunder Mifflin HQ Office: "social scene" detection (DOM-free, unit-tested in Node).
// A non-work chat (no delegation, no write/shell tools) that mentions teammates becomes a short, decorative break-room chat.

export const MICHAEL = "regional-manager";
export const MAX_PARTICIPANTS = 4; // besides Michael
export const MAX_LINES = 6;
export const LINE_CHARS = 70;
export const TEXT_CAP = 4000;

export const DEFAULT_ALIASES = Object.freeze({
  "regional-manager": ["Michael", "Michael Scott"],
  "sales-lead": ["Dwight", "Dwight Schrute"],
  "account-strategist": ["Jim", "Jim Halpert"],
  "office-administrator": ["Pam", "Pam Beesly"],
  "finance-analyst": ["Angela", "Angela Martin"],
  "renewals-desk": ["Stanley", "Stanley Hudson"],
  "relationship-manager": ["Phyllis", "Phyllis Vance"],
  "communications": ["Kelly", "Kelly Kapoor"],
  "summarizer": ["Kevin", "Kevin Malone"],
  "cloud-ai-architect": ["Oscar", "Oscar Martinez"],
  "product-manager": ["Ryan", "Ryan Howard"],
  "automation-engineer": ["Darryl", "Darryl Philbin"],
  "presentation-designer": ["Andy", "Andy Bernard"],
  "qa-reviewer": ["Creed", "Creed Bratton"],
  "compliance-officer": ["Toby", "Toby Flenderson"],
});

const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildAliases(team = [], base = DEFAULT_ALIASES) {
  const names = new Map();
  const put = (alias, id) => { const k = String(alias || "").trim().toLowerCase(); if (k && !names.has(k)) names.set(k, id); };
  for (const [id, list] of Object.entries(base)) list.forEach(a => put(a, id));
  for (const m of team || []) {
    if (!m?.id || !m.persona) continue;
    const clean = String(m.persona).replace(/['"‘’“”][^'"‘’“”]*['"‘’“”]/g, " ").replace(/\s+/g, " ").trim();
    put(clean, m.id);
    put(clean.split(" ")[0], m.id);
  }
  const alts = [...names.keys()].sort((a, b) => b.length - a.length).map(rx).join("|");
  const re = alts ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})(?![\\p{L}\\p{N}_])`, "giu") : null;
  return { names, re, label: alts };
}

export function findMentions(text, aliases) {
  const out = [];
  if (!aliases?.re) return out;
  const re = new RegExp(aliases.re.source, aliases.re.flags);
  let m;
  while ((m = re.exec(String(text || "")))) out.push({ id: aliases.names.get(m[0].toLowerCase()), index: m.index, end: m.index + m[0].length });
  return out.filter(x => x.id);
}

export function detectMentions(text, aliases) {
  const ids = [];
  for (const m of findMentions(text, aliases)) if (m.id !== MICHAEL && !ids.includes(m.id)) ids.push(m.id);
  return ids.slice(0, MAX_PARTICIPANTS);
}

const READ_TOOLS = new Set(["view", "grep", "glob", "read", "read_file", "ls", "list_dir", "web_search", "web_fetch", "report_intent", "think"]);
export const isReadTool = name => READ_TOOLS.has(String(name || "").toLowerCase());

export function isSocialRun(run, end = {}) {
  if (!run || run.errored || !run.observed || run.work) return false;
  const code = end?.code ?? end?.exitCode;
  if (code !== undefined && code !== null && code !== 0) return false;
  return (run.delegates || 0) === 0;
}
export function stripMarkdown(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+•]\s+|\d+[.)]\s+)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function shorten(s, n = LINE_CHARS) {
  s = stripMarkdown(s);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

const SAY = "(?:said|says|say|replied|replies|answered|answers|added|adds|texted|told me|whispered|muttered|deadpanned|shrugged)";
const QUOTE_RE = /["“]([^"“”]{2,400})["”]/g;

export function extractLines(raw, aliases, allowed = null) {
  const text = String(raw || "").replace(/```[\s\S]*?```/g, " ").replace(/(\*\*|__|\*|_)/g, "").replace(/\r/g, "");
  const quotes = [];
  let m;
  const q = new RegExp(QUOTE_RE.source, "g");
  while ((m = q.exec(text))) quotes.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
  const masked = text.split("");
  for (const k of quotes) for (let i = k.start; i < k.end; i++) masked[i] = " ";
  const maskedText = masked.join("");
  const mentions = findMentions(maskedText, aliases);
  const labelAlt = `(?:${aliases?.label || "(?!)"}|me|i)`;
  const labelRe = new RegExp(`(?:^|[\\s(\\-•>])(${labelAlt})\\s*(?:\\([^)]{0,24}\\))?\\s*[:：]\\s*$`, "iu");
  const afterRe = new RegExp(`^[\\s,;:—-]{0,4}(${aliases?.label || "(?!)"})\\s+${SAY}\\b`, "iu");
  const idOf = s => (/^(me|i)$/i.test(s) ? MICHAEL : aliases.names.get(String(s).toLowerCase()));

  const out = [];
  for (const k of quotes) {
    const before = text.slice(Math.max(0, k.start - 60), k.start);
    let id = null;
    const lm = labelRe.exec(before);
    if (lm) id = idOf(lm[1]);
    if (!id) {
      const am = afterRe.exec(text.slice(k.end, k.end + 60));
      if (am) id = idOf(am[1]);
    }
    if (!id) {
      const prev = [...mentions].reverse().find(x => x.end <= k.start && k.start - x.end <= 200);
      if (prev) id = prev.id;
    }
    if (!id || (allowed && !allowed.has(id))) continue;
    const line = shorten(k.body);
    if (line.length < 2) continue;
    out.push({ id, text: line });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

const SOLO_FALLBACK = ["Coffee first. Then regional management.", "I am making this a team moment."];

export function buildScene(text, aliases, o = {}) {
  const rng = o.rng || Math.random, pool = o.pool || {};
  const ok = o.available || (() => true);
  const others = detectMentions(text, aliases).filter(ok);
  const participants = [MICHAEL, ...others];
  const allowed = new Set(participants);
  let lines = extractLines(text, aliases, allowed);
  const quoted = lines.length > 0;
  if (!quoted) {
    const pick = id => { const l = pool[id] || (id === MICHAEL ? SOLO_FALLBACK : null); return l?.length ? l[Math.floor(rng() * l.length) % l.length] : null; };
    lines = participants.map(id => ({ id, text: pick(id) })).filter(l => l.text).map(l => ({ ...l, text: shorten(l.text) }));
    if (others.length === 0) lines = lines.slice(0, 1);
  }
  return { participants, lines: lines.slice(0, MAX_LINES), solo: others.length === 0, quoted };
}

export function feedNote(participants, names, { cafe = true } = {}) {
  const n = participants.map(id => names[id] || id);
  const list = n.length <= 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  return n.length <= 1 ? `${list} is grabbing a quiet coffee${cafe ? " in the break room" : ""}` : `${list} are chatting${cafe ? " in Café Disco" : ""}`;
}

export const LINE_MS = 3500;
export const REACTIONS = Object.freeze(["💬", "☕", "😂", "🥨", "💖", "🙄"]);
export const SCENE_MIN_MS = 25000, SCENE_MAX_MS = 40000, SOLO_MS = 9000, LINGER_MS = 3000;

export function sceneTimeline(lines, participants, { lineMs = LINE_MS, rng = Math.random } = {}) {
  const steps = [];
  lines.forEach((l, i) => {
    const at = i * lineMs;
    steps.push({ at, id: l.id, text: l.text, ms: lineMs - 100, kind: "say" });
    const listeners = participants.filter(p => p !== l.id);
    if (i % 2 === 0 && listeners.length) {
      const who = listeners[Math.floor(rng() * listeners.length) % listeners.length];
      steps.push({ at: at + 1500, id: who, text: REACTIONS[Math.floor(rng() * REACTIONS.length) % REACTIONS.length], ms: 1400, kind: "react" });
    }
  });
  return { steps, end: lines.length * lineMs };
}
export function sceneEndAt(talkAt, timelineEnd, solo = false) {
  const natural = talkAt + timelineEnd + LINGER_MS;
  return solo ? Math.min(SCENE_MAX_MS, Math.max(SOLO_MS, natural)) : Math.min(SCENE_MAX_MS, Math.max(SCENE_MIN_MS, natural));
}

// Michael marks meeting/brainstorm tasks with a "Meeting:" (or "Brainstorm:") prefix in the delegated task's description;
// the Office then walks everyone in that meeting to the conference room. Plain mentions of "ideas" don't count.
export const MEETING_PREFIX = /^\s*(meeting|brainstorm|conference room)\s*[:\u2014\u2013-]\s*/i;
export const isMeetingSummary = s => MEETING_PREFIX.test(String(s || ""));
export const stripMeetingPrefix = s => String(s || "").replace(MEETING_PREFIX, "");

// Dedicated social spots: break room + Café Disco, finite and off the main warehouse walkway.
export const HUDDLE_SPOTS = Object.freeze([
  [9.0, 14.45], [11.0, 13.85], [10.2, 9.4], [11.35, 10.35], [13.65, 10.0],
].map(p => Object.freeze(p)));
