// Character study (downtime): when nobody is working, a few agents read public pages about their own character from
// NBC's The Office, and Michael hands back short, paraphrased notes. Notes are display-only (Org chart, Office banter);
// they are never injected into work prompts, so web content cannot steer real work. Pure and DOM-free (unit-tested).

export const DEFAULT_STUDY_SETTINGS = Object.freeze({ enabled: true, hour: 15, minute: 0, perRun: 3 });
const BLOCK_SCAN_BYTES = 200 * 1024;
const BLOCK_MAX_BYTES = 60 * 1024;
const MAX_URL_LENGTH = 2048;
const LIMITS = Object.freeze({ summary: 400, traits: 6, trait: 140, quips: 5, quip: 140, sources: 4 });

const trimTo = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

// ---------- Public-web URL check (used for study sources and for the study run's web fetches) ----------
function parseIpv4(host) {
  const parts = String(host || "").split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(p => (/^\d+$/.test(p) && Number(p) <= 255 ? Number(p) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}
function parseIpv6ToBytes(host) {
  const value = String(host || "").toLowerCase();
  if (!value || value.includes(".") || value.split("::").length > 2) return null;
  const [headRaw, tailRaw = ""] = value.split("::");
  const head = headRaw ? headRaw.split(":").filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(":").filter(Boolean) : [];
  if ([...head, ...tail].some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const missing = 8 - (head.length + tail.length);
  if ((!value.includes("::") && missing !== 0) || missing < 0) return null;
  const groups = value.includes("::") ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  return groups.flatMap(g => { const n = Number.parseInt(g, 16); return [(n >> 8) & 0xff, n & 0xff]; });
}
function isBlockedIpv4([a, b]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function isBlockedIpv6(host) {
  const bytes = parseIpv6ToBytes(host);
  if (!bytes) return false;
  if (bytes.every(x => x === 0)) return true; // ::
  if (bytes.slice(0, 15).every(x => x === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  const mapped = bytes.slice(0, 12).every((x, i) => (i < 10 ? x === 0 : x === 0xff));
  return mapped && isBlockedIpv4(bytes.slice(12));
}
/** Only public http(s) pages: no localhost, private/link-local IPs, metadata endpoints or credentialed URLs. */
export function isAllowedStudyUrl(rawUrl) {
  const value = String(rawUrl || "");
  if (!value || value.length > MAX_URL_LENGTH) return { allowed: false, reason: "URL must be <= 2048 chars." };
  let u;
  try { u = new URL(value); } catch { return { allowed: false, reason: "invalid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allowed: false, reason: "only http(s) is allowed." };
  if (u.username || u.password) return { allowed: false, reason: "credentialed URLs are not allowed." };
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) return { allowed: false, reason: "missing hostname." };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { allowed: false, reason: "local/internal hosts are not allowed." };
  const v4 = parseIpv4(host);
  if ((v4 && isBlockedIpv4(v4)) || isBlockedIpv6(host)) return { allowed: false, reason: "private/link-local/loopback/unspecified IPs are not allowed." };
  return { allowed: true };
}

/**
 * Permission policy for a study run (read-only research): local reads and public web pages only. No shell, writes,
 * Azure, or MCP connectors, so a study can never touch your mail, chats, MSX or files.
 */
export function studyPermissionDecision(request) {
  if (request?.managedApprovalRequired) return { kind: "reject", feedback: "Character study is unattended; managed approvals are denied." };
  if (request?.kind === "url") {
    const v = isAllowedStudyUrl(request.url);
    return v.allowed ? { kind: "approve-once" } : { kind: "reject", feedback: `Character study URL denied: ${v.reason}` };
  }
  if (request?.kind === "read") return { kind: "approve-once" };
  if (request?.kind === "mcp") return { kind: "reject", feedback: "Character study policy: connectors (mail, Teams, MSX, files) are off limits." };
  return { kind: "reject", feedback: "Character study is read-only research: denied." };
}

export function validateStudySettings(input) {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const pick = k => (obj[k] == null ? DEFAULT_STUDY_SETTINGS[k] : obj[k]);
  const enabled = Boolean(pick("enabled"));
  const hour = Number(pick("hour")), minute = Number(pick("minute")), perRun = Number(pick("perRun"));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw Object.assign(new Error("hour must be an integer 0-23"), { status: 400 });
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw Object.assign(new Error("minute must be an integer 0-59"), { status: 400 });
  if (!Number.isInteger(perRun) || perRun < 1 || perRun > 6) throw Object.assign(new Error("perRun must be an integer 1-6"), { status: 400 });
  return { enabled, hour, minute, perRun };
}

/** Rotate fairly: never-studied agents first, then the stalest notes; ties keep roster order. */
export function pickStudents(allIds, notes, n) {
  const order = new Map(allIds.map((id, i) => [id, i]));
  const ts = id => (notes && notes[id]?.updatedAt ? Date.parse(notes[id].updatedAt) || 0 : -1);
  return [...allIds].sort((a, b) => (ts(a) - ts(b)) || (order.get(a) - order.get(b))).slice(0, Math.max(0, n));
}

/** Only free agents may study; working agents are never pulled off real work. */
export function studyIsDue({ now, settings, lastSlotIso, busy }) {
  if (!settings?.enabled || busy) return null;
  const slot = new Date(now);
  slot.setHours(settings.hour, settings.minute, 0, 0);
  if (new Date(now).getTime() < slot.getTime()) return null;
  if (lastSlotIso && String(lastSlotIso) === slot.toISOString()) return null;
  return slot;
}

export function buildStudyMessage(playbook, students, byId) {
  const lines = [String(playbook || "").trim(), "", "[STUDENTS]"];
  for (const id of students) {
    const p = byId[id] || {};
    lines.push(`- ${id}: ${p.persona || id} from "${p.show || "The Office"}"`);
  }
  lines.push("[/STUDENTS]");
  return lines.join("\n");
}

function sanitizeSources(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const url = trimTo(raw?.url, MAX_URL_LENGTH);
    if (!url || !isAllowedStudyUrl(url).allowed) continue;
    const u = new URL(url);
    out.push({ title: trimTo(raw?.title, 140) || u.hostname, url: u.toString() });
    if (out.length >= LIMITS.sources) break;
  }
  return out;
}

const cleanList = (items, max, len) => [...new Set((Array.isArray(items) ? items : []).map(x => trimTo(x, len)).filter(Boolean))].slice(0, max);

export function parseStudyNotes(text, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const tail = String(text || "").slice(-BLOCK_SCAN_BYTES);
  const re = /```persona-notes-json\s*([\s\S]*?)```/gi;
  let m, block = null;
  while ((m = re.exec(tail))) block = m[1];
  if (!block) return { notes: {}, error: "no persona-notes-json block" };
  if (Buffer.byteLength(block, "utf8") > BLOCK_MAX_BYTES) return { notes: {}, error: "persona-notes-json too large" };
  let parsed;
  try { parsed = JSON.parse(block); } catch { return { notes: {}, error: "malformed persona-notes-json block" }; }
  if (!Array.isArray(parsed)) return { notes: {}, error: "persona-notes-json block is not an array" };
  const notes = {};
  for (const raw of parsed) {
    const id = trimTo(raw?.agent, 60);
    if (!known.has(id) || notes[id]) continue;
    const sources = sanitizeSources(raw?.sources);
    if (!sources.length) continue; // every note must be grounded in at least one public page
    const traits = cleanList(raw?.traits, LIMITS.traits, LIMITS.trait);
    const quips = cleanList(raw?.quips, LIMITS.quips, LIMITS.quip);
    const summary = trimTo(raw?.summary, LIMITS.summary);
    if (!summary && !traits.length) continue;
    notes[id] = { summary, traits, quips, sources };
  }
  return { notes, error: null };
}

export function mergeStudyNotes(existing, incoming, nowIso, runId) {
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [id, note] of Object.entries(incoming || {})) {
    next[id] = { ...note, updatedAt: nowIso, runId: runId || null, studies: (next[id]?.studies || 0) + 1 };
  }
  return next;
}
