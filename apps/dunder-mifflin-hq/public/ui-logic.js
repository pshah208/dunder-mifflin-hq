// Pure, DOM-free logic for Dunder Mifflin HQ chat. Imported by app.js and unit-tested in Node.

// ---------- Attachments ----------
import { IMAGE_TYPES, supportsAttachment } from "./attachment-types.js";
export const ATTACH_LIMITS = Object.freeze({
  maxCount: 4,
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  types: IMAGE_TYPES,
});

const mb = n => `${Math.round(n / 1024 / 1024)} MB`;

/** existing/incoming: [{name,size,type}]. Returns {accepted, errors}; never exceeds limits. */
export function validateAttachments(existing, incoming, limits = ATTACH_LIMITS) {
  const accepted = [];
  const errors = [];
  let count = existing.length;
  let total = existing.reduce((n, f) => n + (f.size || 0), 0);
  for (const f of incoming) {
    const label = f.name || "image";
    if (!supportsAttachment(f)) errors.push(`${label}: unsupported file type. Use PNG, JPEG or WebP images; PDF, DOCX, XLSX, PPTX, text, CSV or source files.`);
    else if (!(f.size > 0)) errors.push(`${label}: the file is empty.`);
    else if (f.size > limits.maxBytes) errors.push(`${label}: larger than ${mb(limits.maxBytes)}.`);
    else if (count >= limits.maxCount) errors.push(`${label}: at most ${limits.maxCount} files per message.`);
    else if (total + f.size > limits.maxTotalBytes) errors.push(`${label}: would exceed ${mb(limits.maxTotalBytes)} total.`);
    else { accepted.push(f); count += 1; total += f.size; }
  }
  return { accepted, errors };
}

// ---------- Pane layout ----------
export const PANE = Object.freeze({ min: 200, max: 520, compact: 56, def: { left: 270, right: 320 } });
export const PANE_STATES = ["open", "compact", "hidden"];

export function clampWidth(w, min = PANE.min, max = PANE.max) {
  const n = Number(w);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** dir: +1 for the left pane (ArrowRight grows), -1 for the right pane (ArrowLeft grows). Returns new width or null. */
export function resizeByKey(key, shiftKey, width, dir, min = PANE.min, max = PANE.max) {
  const step = shiftKey ? 48 : 16;
  let next;
  if (key === "ArrowRight") next = width + step * dir;
  else if (key === "ArrowLeft") next = width - step * dir;
  else if (key === "Home") next = min;
  else if (key === "End") next = max;
  else return null;
  return clampWidth(next, min, max);
}

export const COLLAPSIBLE_TEAMS = ["sales", "engineering"];
/** Stable, DOM-safe id for a team's member list. */
export function teamMembersId(team) { return "roster-members-" + String(team).toLowerCase().replace(/[^a-z0-9_-]+/g, "-"); }

export function sanitizeUiPrefs(raw) {
  let p = {};
  try { p = typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch { p = {}; }
  if (!p || typeof p !== "object") p = {};
  const state = v => (PANE_STATES.includes(v) ? v : "open");
  return {
    leftW: clampWidth(p.leftW) ?? PANE.def.left,
    rightW: clampWidth(p.rightW) ?? PANE.def.right,
    left: state(p.left),
    right: state(p.right),
    resourcesOpen: p.resourcesOpen !== false,
    focus: p.focus === true,
    collapsedTeams: Array.isArray(p.collapsedTeams) ? COLLAPSIBLE_TEAMS.filter(t => p.collapsedTeams.includes(t)) : [],
  };
}

/** Column width (px) a pane occupies in the layout. */
export function paneColumn(state, width) {
  return state === "hidden" ? 0 : state === "compact" ? PANE.compact : width;
}

// ---------- Prompt history (Up / Down in the composer) ----------
export function caretOnFirstLine(value, start) { return value.lastIndexOf("\n", start - 1) === -1 || start === 0; }
export function caretOnLastLine(value, end) { return value.indexOf("\n", end) === -1; }

export class PromptHistory {
  constructor(prompts = []) { this.reset(prompts); }
  reset(prompts = []) {
    this.items = prompts.filter(p => typeof p === "string" && p.trim());
    this.index = null; // null = not browsing
    this.draft = "";
    this.shown = "";
  }
  push(text) {
    if (text && text.trim()) this.items.push(text);
    this.index = null; this.draft = ""; this.shown = "";
  }
  get browsing() { return this.index !== null; }
  /** Plain Up/Down with a collapsed selection only, never during IME composition. */
  eligible(ev, ta) {
    if (ev.isComposing || ev.keyCode === 229) return false;
    if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return false;
    return ta.selectionStart === ta.selectionEnd;
  }
  /** Returns the new textarea value, or null to let the browser handle the key normally. */
  up(ev, ta) {
    if (ev.key !== "ArrowUp" || !this.eligible(ev, ta) || !this.items.length) return null;
    if (this.browsing && ta.value !== this.shown) this.index = null; // user edited the recalled text: it is a new draft
    if (!this.browsing) {
      if (ta.value !== "" ) return null; // never hijack Up inside a non-empty draft
      this.draft = ta.value;
      this.index = this.items.length - 1;
    } else {
      if (!caretOnFirstLine(ta.value, ta.selectionStart)) return null;
      if (this.index === 0) return null;
      this.index -= 1;
    }
    this.shown = this.items[this.index];
    return this.shown;
  }
  down(ev, ta) {
    if (ev.key !== "ArrowDown" || !this.eligible(ev, ta) || !this.browsing) return null;
    if (ta.value !== this.shown) { this.index = null; return null; }
    if (!caretOnLastLine(ta.value, ta.selectionEnd)) return null;
    if (this.index < this.items.length - 1) {
      this.index += 1;
      this.shown = this.items[this.index];
      return this.shown;
    }
    const draft = this.draft;
    this.index = null; this.draft = ""; this.shown = "";
    return draft;
  }
}

// ---------- Autopilot confirmation grants (per conversation, per window, scoped to target) ----------
const GRANT_KEY = "dm.autopilot.v1";
const NONCE_KEY = "dm.window.nonce";

export function scopeKey(t = {}) {
  return JSON.stringify([t.repoId || "", t.subscription || "", t.resourceGroup || ""]);
}

function randomId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * window.open() copies sessionStorage into the new window, which would let a parallel window inherit a grant.
 * The nonce is mirrored in window.name (which a new window does NOT inherit for target=_blank). If the two
 * disagree this is a clone: wipe all grants and mint a fresh nonce. Reloads keep both, so grants survive them.
 */
export function initWindowScope(storage, win) {
  const stored = storage.getItem(NONCE_KEY);
  if (stored && win.name === stored) return stored;
  storage.removeItem(GRANT_KEY);
  clearWindowConversationState(storage);
  const fresh = randomId();
  storage.setItem(NONCE_KEY, fresh);
  win.name = fresh;
  return fresh;
}

export class AutopilotGrants {
  constructor(storage) { this.storage = storage; }
  read() {
    try {
      const v = JSON.parse(this.storage.getItem(GRANT_KEY) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }
  write(v) { this.storage.setItem(GRANT_KEY, JSON.stringify(v)); }
  isGranted(sessionId, target) {
    if (!sessionId) return false;
    const all = this.read();
    if (all[sessionId] === scopeKey(target)) return true;
    if (sessionId in all) { delete all[sessionId]; this.write(all); } // target changed: grant no longer valid
    return false;
  }
  grant(sessionId, target) { if (sessionId) this.write({ ...this.read(), [sessionId]: scopeKey(target) }); }
  revoke(sessionId) { const all = this.read(); delete all[sessionId]; this.write(all); }
  clearAll() { this.storage.removeItem(GRANT_KEY); }
}

export function autopilotExpected(t = {}) { return t.resourceGroup || "AUTOPILOT"; }

// ---------- Window-scoped current conversation (sessionStorage only: never shared across windows) ----------
export const SESSION_KEY = "dm.window.session";
export const DRAFT_PREFIX = "dm.draft.";
export const getWindowSession = storage => storage.getItem(SESSION_KEY) || "";
export const setWindowSession = (storage, id) => { if (id) storage.setItem(SESSION_KEY, id); };
export function clearWindowConversationState(storage) {
  storage.removeItem(SESSION_KEY);
  const n = typeof storage.length === "number" && storage.key ? storage.length : 0;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(storage.key(i));
  keys.filter(k => k && k.startsWith(DRAFT_PREFIX)).forEach(k => storage.removeItem(k));
}
/** Which conversation should the chat page open? Explicit ?new=1 wins, then ?session=, then this window's last one. */
export function resolveStartSession({ urlSession, wantsNew, stored }) {
  if (wantsNew) return { mode: "new", id: "" };
  const id = urlSession || stored || "";
  return id ? { mode: "existing", id } : { mode: "create", id: "" };
}
/** Add ?session=<id> to an internal page link (keeps any existing query/hash). */
export function withSession(href, id) {
  if (!id) return href;
  const u = new URL(href, "http://x.invalid");
  u.searchParams.delete("new");
  u.searchParams.set("session", id);
  return u.pathname + u.search + u.hash;
}
export const saveDraft = (storage, id, text) => { if (!id) return; if (text) storage.setItem(DRAFT_PREFIX + id, text); else storage.removeItem(DRAFT_PREFIX + id); };
export const loadDraft = (storage, id) => (id ? storage.getItem(DRAFT_PREFIX + id) || "" : "");
// ---------- Folder browser (Local repository) ----------
/** "Use this folder" is only offered for a git repository. */
export const canUseFolder = listing => !!listing && listing.isGitRepo === true && !!listing.path;
/** Browse follows the same lock as Add: a conversation pinned to a repository cannot switch. */
export const canBrowse = ({ pinned } = {}) => !pinned;
/** Parent directory of a path (Windows or POSIX); "" when there is none. */
export function parentDir(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (i <= 0) return /^[A-Za-z]:$/.test(s.slice(0, i + 1)) || i === 0 ? (s.slice(0, i + 1) || "") : "";
  const head = s.slice(0, i);
  return /^[A-Za-z]:$/.test(head) ? head + s[i] : head;
}
/** Where the browser opens: the selected repo's parent folder, else "" so the server picks its default. */
export function browseStartPath(repos, repoId) {
  const r = (repos || []).find(x => x.id === repoId);
  return r?.path ? parentDir(r.path) : "";
}
/** Breadcrumb segments [{ name, path }] for an absolute path. */
export function breadcrumbs(p) {
  const s = String(p || ""); if (!s) return [];
  const sep = s.includes("\\") ? "\\" : "/";
  const parts = s.split(/[\\/]+/).filter(Boolean);
  const out = [];
  let acc = /^[A-Za-z]:$/.test(parts[0] || "") ? "" : (s.startsWith(sep) ? sep : "");
  parts.forEach((name, i) => {
    acc = i === 0 ? (/^[A-Za-z]:$/.test(name) ? name + sep : acc + name) : (acc.endsWith(sep) ? acc : acc + sep) + name;
    out.push({ name, path: acc });
  });
  return out;
}
export const fsDirsUrl = p => `/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ""}`;
// ---- Agent instance tracking and in-flight dedupe (pure helpers) ----
const agentOf = v => (typeof v === "string" ? v : v?.agent);
/** Which key of an instances Map (callId -> agent | {agent}) does an agent_end refer to? With a callId only an exact match counts
 *  (never another live call of the same agent); the name fallback is only for ends that carry no callId at all. */
export function findEndKey(map, callId, agent) {
  if (callId) return map.has(callId) ? callId : null;
  if (!agent) return null;
  for (const [k, v] of map) if (agentOf(v) === agent) return k;
  return null;
}
/** Is any instance of this agent still active? */
export const isAgentActive = (map, agent) => { for (const v of map.values()) if (agentOf(v) === agent) return true; return false; };
/** Tracks ids with a request in flight so several UI surfaces can't submit the same answer at once. */
export class InFlight {
  #ids = new Set();
  begin(id) { if (this.#ids.has(id)) return false; this.#ids.add(id); return true; }
  end(id) { this.#ids.delete(id); }
  has(id) { return this.#ids.has(id); }
}
/** Reconnect delay (ms) with exponential backoff, capped. */
export const backoffMs = (attempt, base = 1000, max = 15000) => Math.min(max, base * 2 ** Math.max(0, attempt));

/** Ids of live (not done) cards that the server no longer lists as pending. Fresh cards get a grace period unless authoritative. */
export function staleCardIds(cards, pendingIds, now, { authoritative = false, graceMs = 3000 } = {}) {
  const live = new Set(pendingIds);
  const out = [];
  for (const [id, c] of cards) if (!c.done && !live.has(id) && (authoritative || now - c.at > graceMs)) out.push(id);
  return out;
}

/**
 * MCP elicitation (a server asking the human to confirm, e.g. an MSX write preview).
 * Initial form values: booleans start unchecked so a confirmation is always a deliberate click.
 */
export function elicitationInitialValues(fields = []) {
  const out = {};
  for (const f of fields) {
    if (f.type === "boolean") out[f.name] = false;
    else if (f.type === "array") out[f.name] = Array.isArray(f.default) ? [...f.default] : [];
    else if (f.default != null) out[f.name] = f.default;
    else if (Array.isArray(f.enum) && f.enum.length) out[f.name] = f.enum[0];
    else out[f.name] = "";
  }
  return out;
}
/** Names of required fields that are still empty (an unchecked required box counts as empty). */
export function elicitationMissing(fields = [], values = {}) {
  return fields.filter(f => f.required).filter(f => {
    const v = values[f.name];
    if (f.type === "boolean") return v !== true;
    if (f.type === "array") return !Array.isArray(v) || !v.length;
    return v == null || String(v).trim() === "";
  }).map(f => f.name);
}
