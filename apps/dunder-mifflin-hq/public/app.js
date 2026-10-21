import {
  ATTACH_LIMITS, validateAttachments, PANE, clampWidth, resizeByKey, sanitizeUiPrefs, paneColumn, COLLAPSIBLE_TEAMS, teamMembersId,
  PromptHistory, AutopilotGrants, initWindowScope, autopilotExpected,
  resolveStartSession, getWindowSession, setWindowSession, saveDraft, loadDraft,
  findEndKey, isAgentActive, staleCardIds, InFlight, backoffMs, elicitationInitialValues, elicitationMissing,
} from "./ui-logic.js";
import { updateNavLinks } from "./nav.js";
import { FILE_ACCEPT, isImageAttachment } from "./attachment-types.js";

const TOKEN = document.querySelector('meta[name="dm-token"]').content;
const LEAD_ID = "regional-manager";
const $ = s => document.querySelector(s);
const urlSessionId = () => new URL(location.href).searchParams.get("session");
const urlWantsNewSession = () => new URL(location.href).searchParams.get("new") === "1";
const state = {
  team: [],
  byId: {},
  // Explicit ?session= wins, else this window's last conversation (sessionStorage), so Chat -> Org chart -> Chat returns here.
  sessionId: resolveStartSession({ urlSession: urlSessionId(), wantsNew: urlWantsNewSession(), stored: getWindowSession(sessionStorage) }).id || null,
  subs: [],
  running: false,
  sending: false,
  queue: { items: [], paused: false },
  displayedUserRuns: new Set(),
  delegations: new Map(),
  startedDelegations: new Set(),
  bubbles: new Map(),
  abort: null,
  liveAbort: null,
  sessions: [],
  currentReplay: null,
  approvals: [],
  questions: [],
  elicitations: [],
  cards: new Map(),
  inflight: new InFlight(),
  lastSeq: 0,
  loadedEntryCount: 0,
  models: [],
  repos: [],
  repoId: "",
  repoPinned: false,
  defaultRepoId: "",
  attachments: [],
  blobUrls: [],
  histories: new Map(),
  ui: sanitizeUiPrefs(localStorage.getItem("dm.ui")),
  dundies: 0,
};
const WINDOW_NONCE = initWindowScope(sessionStorage, window);
const grants = new AutopilotGrants(sessionStorage);
const savePrefs = () => localStorage.setItem("dm.ui", JSON.stringify(state.ui));
const history_ = id => { if (!state.histories.has(id)) state.histories.set(id, new PromptHistory()); return state.histories.get(id); };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", "X-DM-Token": TOKEN, ...(opts.headers || {}) } });
  if (!r.ok) {
    const msg = r.headers.get("content-type")?.includes("json") ? ((await r.json()).error || r.statusText) : r.statusText;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r;
}

async function fetchBlobUrl(url) {
  const r = await fetch(url, { headers: { "X-DM-Token": TOKEN } });
  if (!r.ok) throw new Error(r.statusText || "image unavailable");
  const u = URL.createObjectURL(await r.blob());
  state.blobUrls.push(u);
  return u;
}
function releaseBlobUrls() { state.blobUrls.forEach(u => URL.revokeObjectURL(u)); state.blobUrls = []; }

function kindLabel(kind) {
  const k = String(kind || "").toLowerCase();
  return ({
    write: "Write approval needed",
    shell: "Shell approval needed",
    mcp: "MCP approval needed",
    network: "Network approval needed",
    domain: "Domain approval needed",
    read: "Read approval needed",
  }[k] || "Approval needed");
}

function requestSummary(req = {}) {
  return req.fileName || req.command || req.url || req.domain || req.toolName || "no explicit target";
}

function jumpToPending() {
  const panel = $("#pending");
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusTarget = panel.querySelector("button, input");
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

function renderPending() {
  const host = $("#pending");
  if (!host) return;
  const approvals = state.approvals.map(a => `
    <li>
      <div><b>${esc(kindLabel(a.request?.kind))}</b> · ${esc(a.approvalId.slice(0, 8))}</div>
      <div class="muted">${esc(requestSummary(a.request))}</div>
      <div class="muted">${esc(a.request?.intention || a.request?.toolName || a.request?.kind || "")}</div>
      <div class="pending-actions">
        <button type="button" data-approve="${esc(a.approvalId)}" class="primary">Approve</button>
        <button type="button" data-deny="${esc(a.approvalId)}" class="ghost">Deny</button>
      </div>
    </li>
  `).join("");
  const questions = state.questions.map(q => `
    <li>
      <div><b>Question</b> · ${esc(q.prompt)}</div>
      ${(q.choices || []).length ? `<div class="pending-actions">${q.choices.map(c => `<button type="button" data-choice-q="${esc(q.questionId)}" data-choice="${esc(c)}" class="${/\(Recommended\)/i.test(c) ? "primary" : "ghost"}">${esc(c)}</button>`).join("")}</div>` : ""}
      ${q.allowFreeform === false ? "" : `<div class="pending-actions">
        <input type="text" data-question-input="${esc(q.questionId)}" placeholder="Your answer" />
        <button type="button" data-answer="${esc(q.questionId)}" class="primary">Send answer</button>
      </div>`}
    </li>
  `).join("");
  const elicitations = state.elicitations.map(e => `
    <li>
      <div><b>Confirm ${esc(e.source || "connector")} change</b> · ${esc(e.elicitationId.slice(0, 8))}</div>
      <div class="muted">${esc(String(e.message || "").split("\n").find(l => l.trim()) || "")}</div>
      <div class="pending-actions"><button type="button" data-review-e="${esc(e.elicitationId)}" class="primary">Review in chat</button></div>
    </li>
  `).join("");
  host.innerHTML = approvals + questions + elicitations || `<li class="muted">No pending approvals or questions.</li>`;
  for (const id of [...state.approvals.map(a => a.approvalId), ...state.questions.map(q => q.questionId)]) if (state.inflight.has(id)) syncInflight(id);
  host.querySelectorAll("button[data-review-e]").forEach(btn => btn.addEventListener("click", () => {
    const c = state.cards.get(btn.dataset.reviewE); if (!c) return;
    c.el.scrollIntoView({ behavior: "smooth", block: "center" }); c.el.querySelector("input, select, button")?.focus({ preventScroll: true });
  }));
  host.querySelectorAll("button[data-approve]").forEach(btn => btn.addEventListener("click", () => {
    respondApproval(btn.dataset.approve, "approve").catch(e => {
      addEvent(`⚠ Approval response failed: ${esc(e.message)}`, "fail");
      activity(`approval response failed: ${e.message}`, "fail");
    });
  }));
  host.querySelectorAll("button[data-deny]").forEach(btn => btn.addEventListener("click", () => {
    respondApproval(btn.dataset.deny, "deny").catch(e => {
      addEvent(`⚠ Approval response failed: ${esc(e.message)}`, "fail");
      activity(`approval response failed: ${e.message}`, "fail");
    });
  }));
  host.querySelectorAll("button[data-choice]").forEach(btn => btn.addEventListener("click", () => {
    respondQuestion(btn.dataset.choiceQ, btn.dataset.choice).catch(e => addEvent(`⚠ Answer submit failed: ${esc(e.message)}`, "fail"));
  }));
  host.querySelectorAll("button[data-answer]").forEach(btn => btn.addEventListener("click", () => {
    const qid = btn.dataset.answer;
    const input = host.querySelector(`input[data-question-input="${CSS.escape(qid)}"]`);
    respondQuestion(qid, input?.value || "").catch(e => {
      addEvent(`⚠ Answer submit failed: ${esc(e.message)}`, "fail");
      activity(`answer failed: ${e.message}`, "fail");
    });
  }));
}

async function refreshPending({ authoritative = false } = {}) {
  if (!state.sessionId) return;
  const p = await (await api(`/api/pending?hqSessionId=${encodeURIComponent(state.sessionId)}`)).json();
  state.approvals = p.approvals || [];
  state.questions = p.questions || [];
  state.elicitations = p.elicitations || [];
  renderPending();
  for (const a of state.approvals) addApprovalCard(a);
  for (const q of state.questions) addQuestionCard(q);
  for (const e of state.elicitations) addElicitationCard(e);
  // A live card the server no longer lists was answered elsewhere (or timed out). Fresh cards get a short grace period to avoid racing
  // the live event, except right after a reconnect, when the pending list is authoritative.
  const pendingIds = [...state.approvals.map(a => a.approvalId), ...state.questions.map(q => q.questionId), ...state.elicitations.map(e => e.elicitationId)];
  for (const id of staleCardIds(state.cards, pendingIds, Date.now(), { authoritative })) resolveCard(id, "answered elsewhere");
}

async function respondOnce(id, path, body, doneText, label) {
  if (!state.sessionId) return;
  if (!state.inflight.begin(id)) return;
  syncInflight(id);
  try {
    await api(path, { method: "POST", body: JSON.stringify({ hqSessionId: state.sessionId, ...body }) });
    activity(label, "ok");
    resolveCard(id, doneText);
  } catch (e) {
    if (e.status === 404) { resolveCard(id, "answered elsewhere"); }
    else throw e;
  } finally {
    state.inflight.end(id); syncInflight(id);
  }
  await refreshPending().catch(() => {});
}
function syncInflight(id) {
  const busy = state.inflight.has(id), c = state.cards.get(id);
  if (c && !c.done) setCardBusy(c.el, busy);
  document.querySelectorAll("#pending button, #pending input").forEach(x => {
    const owner = x.dataset.approve || x.dataset.deny || x.dataset.choiceQ || x.dataset.answer || x.dataset.questionInput;
    if (owner === id) x.disabled = busy;
  });
}
async function respondApproval(approvalId, decision) {
  await respondOnce(approvalId, "/api/approvals/respond", { approvalId, decision }, decision === "approve" ? "approved" : "denied", `approval ${decision}: ${approvalId.slice(0, 8)}`);
}
async function respondQuestion(questionId, answer) {
  answer = String(answer || "").trim(); if (!answer) return;
  await respondOnce(questionId, "/api/questions/respond", { questionId, answer }, answer, `answered question ${questionId.slice(0, 8)}`);
}

// ---------- Inline question / approval cards (in the chat thread) ----------
function cardShell(id, kind) {
  const el = document.createElement("div");
  el.className = `qcard ${kind}`; el.dataset.cardId = id;
  el.setAttribute("role", "group"); el.setAttribute("aria-live", "polite");
  return el;
}
function collapseCard(el, text, cls = "") {
  el.classList.add("done"); if (cls) el.classList.add(cls);
  el.replaceChildren(Object.assign(document.createElement("div"), { className: "qcard-answer", textContent: text }));
}
function resolveCard(id, text) {
  const c = state.cards.get(id); if (!c || c.done) return;
  c.done = true;
  collapseCard(c.el, c.kind === "approval" || c.kind === "elicitation" ? (/^answered elsewhere$/.test(text) ? "Answered elsewhere" : `You ${text}`) : /^answered elsewhere$/.test(text) ? "Answered elsewhere" : `You answered: ${text}`);
}
function cardError(el, msg) {
  let err = el.querySelector(".qcard-error");
  if (!err) { err = document.createElement("div"); err.className = "qcard-error"; err.setAttribute("role", "alert"); el.append(err); }
  err.textContent = `Could not send: ${msg}`;
}
function setCardBusy(el, busy) { el.querySelectorAll("button, textarea").forEach(x => { x.disabled = busy; }); if (!busy) el.querySelector(".qcard-error")?.remove(); }
function registerCard(id, kind, el, done = false) {
  state.cards.set(id, { el, kind, done, at: Date.now() });
  $("#messages").append(el); scroll();
}
function addQuestionCard(q) {
  const id = q.questionId; if (!id || state.cards.has(id)) return null;
  const el = cardShell(id, "question");
  registerCard(id, "question", el);
  const prompt = document.createElement("div"); prompt.className = "qcard-prompt"; prompt.textContent = q.prompt || "";
  el.append(prompt);
  const submit = async answer => {
    answer = String(answer || "").trim(); if (!answer) return;
    try { await respondQuestion(id, answer); }
    catch (e) { cardError(el, e.message); }
  };
  let first = null;
  const choices = Array.isArray(q.choices) ? q.choices : [];
  if (choices.length) {
    const row = document.createElement("div"); row.className = "qcard-choices";
    for (const c of choices) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = c;
      b.className = /\(Recommended\)/i.test(c) ? "primary" : "ghost";
      b.addEventListener("click", () => submit(c)); row.append(b); first ||= b;
    }
    el.append(row);
  }
  if (q.allowFreeform !== false || !choices.length) {
    const ta = document.createElement("textarea"); ta.rows = 2; ta.className = "qcard-input";
    ta.placeholder = choices.length ? "Or type your own answer (Enter to send, Shift+Enter for newline)" : "Your answer (Enter to send, Shift+Enter for newline)";
    ta.setAttribute("aria-label", "Your answer");
    ta.addEventListener("keydown", e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); submit(ta.value); }
    });
    el.append(ta); first ||= ta;
  }
  scroll();
  first?.focus({ preventScroll: true });
  return el;
}
function addApprovalCard(a) {
  const id = a.approvalId; if (!id || state.cards.has(id)) return null;
  const el = cardShell(id, "approval");
  registerCard(id, "approval", el);
  const title = document.createElement("div"); title.className = "qcard-prompt"; title.textContent = kindLabel(a.request?.kind);
  const sum = document.createElement("div"); sum.className = "muted"; sum.textContent = requestSummary(a.request);
  const row = document.createElement("div"); row.className = "qcard-choices";
  const mk = (label, cls, decision) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.className = cls;
    b.addEventListener("click", async () => {
      try { await respondApproval(id, decision); }
      catch (e) { cardError(el, e.message); }
    });
    return b;
  };
  const ok = mk("Approve", "primary", "approve");
  row.append(ok, mk("Deny", "ghost", "deny"));
  el.append(title, sum, row); scroll();
  ok.focus({ preventScroll: true });
  return el;
}
async function respondElicitation(elicitationId, action, content) {
  await respondOnce(elicitationId, "/api/elicitations/respond", { elicitationId, action, content }, action === "accept" ? "confirmed" : "declined", `confirmation ${action}: ${elicitationId.slice(0, 8)}`);
}
// A connector asks you to confirm a write it previewed (e.g. MSX: create a task on a milestone). Never auto-accepted.
function addElicitationCard(e) {
  const id = e.elicitationId; if (!id || state.cards.has(id)) return null;
  const el = cardShell(id, "elicitation");
  registerCard(id, "elicitation", el);
  const title = document.createElement("div"); title.className = "qcard-prompt";
  title.textContent = `✋ ${e.source ? `${e.source}: ` : ""}confirm this change`;
  const preview = document.createElement("div"); preview.className = "qcard-preview"; preview.innerHTML = md(e.message || "");
  el.append(title, preview);
  const fields = Array.isArray(e.fields) ? e.fields : [];
  const values = elicitationInitialValues(fields);
  const form = document.createElement("div"); form.className = "qcard-fields";
  const row = document.createElement("div"); row.className = "qcard-choices";
  const ok = document.createElement("button"); ok.type = "button"; ok.className = "primary danger-btn"; ok.textContent = "Confirm change";
  const no = document.createElement("button"); no.type = "button"; no.className = "ghost"; no.textContent = "Cancel";
  const sync = () => { ok.disabled = elicitationMissing(fields, values).length > 0; };
  for (const f of fields) {
    const label = document.createElement("label"); label.className = `qcard-field ${f.type}`;
    let input;
    if (f.type === "boolean") {
      input = Object.assign(document.createElement("input"), { type: "checkbox", checked: false });
      input.addEventListener("change", () => { values[f.name] = input.checked; sync(); });
      label.append(input, document.createTextNode(` ${f.title}`));
    } else if (Array.isArray(f.enum) && f.type !== "array") {
      input = document.createElement("select");
      f.enum.forEach((v, i) => input.append(new Option(f.enumNames?.[i] || v, v)));
      input.value = values[f.name];
      input.addEventListener("change", () => { values[f.name] = input.value; sync(); });
      label.append(document.createTextNode(`${f.title} `), input);
    } else {
      input = Object.assign(document.createElement("input"), { type: f.type === "number" || f.type === "integer" ? "number" : "text", value: values[f.name] ?? "" });
      input.addEventListener("input", () => { values[f.name] = input.value; sync(); });
      label.append(document.createTextNode(`${f.title} `), input);
    }
    if (f.description) label.title = f.description;
    form.append(label);
  }
  ok.addEventListener("click", async () => { try { await respondElicitation(id, "accept", values); } catch (err) { cardError(el, err.message); } });
  no.addEventListener("click", async () => { try { await respondElicitation(id, "decline"); } catch (err) { cardError(el, err.message); } });
  row.append(ok, no);
  if (fields.length) el.append(form);
  el.append(row); sync(); scroll();
  (form.querySelector("input, select") || no).focus({ preventScroll: true });
  return el;
}
function addPersistedQuestion(entry) {
  const id = entry.questionId; if (!id || state.cards.has(id)) return;
  if (entry.answer == null && !entry.cancelled) { addQuestionCard({ questionId: id, prompt: entry.prompt, choices: entry.choices, allowFreeform: true }); return; }
  const el = cardShell(id, "question");
  const prompt = document.createElement("div"); prompt.className = "qcard-prompt"; prompt.textContent = entry.prompt || "";
  el.append(prompt);
  const ans = document.createElement("div"); ans.className = "qcard-answer";
  ans.textContent = entry.cancelled ? "Cancelled" : `You answered: ${entry.answer}`;
  el.classList.add("done"); el.append(ans);
  registerCard(id, "question", el, true);
}

// ---------- Safe mini-markdown ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1");
}
function md(src) {
  const parts = esc(src).split(/```[\w-]*\n?/);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2) { html += `<pre>${part}</pre>`; return; }
    const lines = part.split("\n"); let list = null; let table = [];
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r));
      html += "<table>" + rows.map((r, ri) => "<tr>" + r.replace(/^\||\|$/g, "").split("|")
        .map(c => ri === 0 ? `<th>${inline(c.trim())}</th>` : `<td>${inline(c.trim())}</td>`).join("") + "</tr>").join("") + "</table>";
      table = [];
    };
    for (const line of lines) {
      if (/^\s*\|/.test(line)) { flushList(); table.push(line.trim()); continue; } else flushTable();
      let m;
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushList(); html += `<p><b>${inline(m[1])}</b></p>`; }
      else if (line.trim()) { flushList(); html += `<p>${inline(line)}</p>`; }
      else flushList();
    }
    flushList(); flushTable();
  });
  return html;
}

// ---------- Team ----------
function persona(id) { return state.byId[id] || { persona: id || "Someone", initials: "??", color: "#888", title: id }; }
const TEAM_LABEL = { lead: "Regional Manager", sales: "Scranton Branch · Sales & Customer", engineering: "Dunder Mifflin Infinity · Engineering & Product", quality: "Quality Gates" };
function renderRoster() {
  $("#roster").innerHTML = ["lead", "sales", "engineering", "quality"].map(team => {
    const members = state.team.filter(m => m.team === team);
    if (!members.length) return "";
    const rows = members.map(m => `
    <li class="member" data-id="${esc(m.id)}" title="${esc(m.id)} · ${esc(m.show || "")}">
      ${avatarHtml(m)}
      <div><div class="name">${esc(m.persona)}</div><div class="role">${esc(m.title)}</div><div class="model">${esc(m.model)}</div></div>
      <span class="dot" aria-hidden="true"></span>
    </li>`).join("");
    if (!COLLAPSIBLE_TEAMS.includes(team)) return `<li class="team-label ${team}">${esc(TEAM_LABEL[team])}</li>` + rows;
    const open = !state.ui.collapsedTeams.includes(team), id = teamMembersId(team);
    return `<li class="team-label ${team}"><button type="button" class="team-toggle" data-team="${esc(team)}" aria-expanded="${open}" aria-controls="${id}"><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span>${esc(TEAM_LABEL[team])}</button></li>`
      + `<li class="team-members" id="${id}"${open ? "" : " hidden"}><ul class="roster-sub">${rows}</ul></li>`;
  }).join("");
  const lead = state.byId[LEAD_ID]; if (lead) $("#leadAvatar").src = lead.avatar;
}
function toggleTeam(team) {
  const set = new Set(state.ui.collapsedTeams);
  if (!set.delete(team)) set.add(team);
  state.ui.collapsedTeams = COLLAPSIBLE_TEAMS.filter(t => set.has(t)); savePrefs();
  const open = !set.has(team), btn = document.querySelector(`.team-toggle[data-team="${team}"]`);
  btn.setAttribute("aria-expanded", String(open)); btn.querySelector(".chev").textContent = open ? "▾" : "▸";
  document.getElementById(teamMembersId(team)).hidden = !open;
}
function setWorking(id, on) {
  const el = document.querySelector(`.member[data-id="${CSS.escape(id || "")}"]`);
  if (el) el.classList.toggle("working", on);
}

// ---------- Target ----------
// The chat UI no longer offers an Azure target or a repository picker: runs get no Azure target and use the
// server's default repository (this repo). The server API still accepts both for scripted use.
function target() { return {}; }

// ---------- Session history ----------
function setCurrentSession(id) {
  state.sessionId = id;
  setWindowSession(sessionStorage, id);
  updateNavLinks(id);
  const u = new URL(location.href);
  u.searchParams.set("session", id);
  history.replaceState(null, "", u.toString());
  renderSessions();
}

function formatTs(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}

// Character-study runs are background downtime conversations: hidden unless asked for (or currently open).
const showStudyRuns = () => localStorage.getItem("dm.showStudy") === "1";
const visibleSessions = () => state.sessions.filter(s => s.kind !== "study" || showStudyRuns() || s.id === state.sessionId);
function renderSessions() {
  const host = $("#sessions");
  if (!host) return;
  host.innerHTML = visibleSessions().map(s => `
    <li class="session-row">
      <button type="button" class="session-item ${s.id === state.sessionId ? "active" : ""}" data-session-id="${esc(s.id)}"${s.id === state.sessionId ? ' aria-current="true"' : ""}>
        <span class="t">${s.kind === "study" ? "📖 " : ""}${esc(String(s.title || "New conversation").replace(/^📖\s*/, ""))}</span>
        <span class="m">${esc(formatTs(s.updatedAt))}${s.lastError ? " · ⚠" : ""}</span>
      </button>
      <button type="button" class="icon-btn session-delete" data-delete-id="${esc(s.id)}" aria-label="Delete conversation: ${esc(s.title || "New conversation")}" title="Delete conversation"${s.id === state.sessionId && state.running ? " disabled" : ""}>🗑</button>
    </li>`).join("") || `<li class="muted">No saved conversations yet.</li>`;
  host.querySelectorAll("button[data-session-id]").forEach(btn => btn.addEventListener("click", async () => {
    if (state.running) return;
    await openSession(btn.dataset.sessionId);
  }));
  host.querySelectorAll("button[data-delete-id]").forEach(btn => btn.addEventListener("click", () => {
    deleteConversation(btn.dataset.deleteId).catch(e => activity(`delete failed: ${e.message}`, "fail"));
  }));
}

async function afterConversationGone(id) {
  grants.revoke(id); state.histories.delete(id); sessionStorage.removeItem(`dm.draft.${id}`);
  const wasCurrent = id === state.sessionId;
  await refreshSessions();
  if (!wasCurrent) return; // already switched (e.g. live event and local delete both fired)
  state.liveAbort?.abort();
  const next = state.sessions.find(s => s.kind !== "study");
  if (next) await openSession(next.id);
  else await newChat();
}

async function deleteConversation(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  if (id === state.sessionId && state.running) { activity("stop the running task before deleting this conversation", "fail"); return; }
  const dlg = $("#deleteDlg");
  const title = s.title || "New conversation";
  $("#deleteName").textContent = `"${title}"`;
  $("#deleteOk").textContent = `Delete "${title.slice(0, 40)}"`;
  $("#deleteError").hidden = true;
  let pending = false;
  const block = e => { if (pending) e.preventDefault(); };
  dlg.addEventListener("cancel", block);
  const cancelBtn = dlg.querySelector('button[value="cancel"]');
  dlg.showModal();
  const ok = await new Promise(res => {
    const onClose = () => res(false);
    dlg.addEventListener("close", onClose, { once: true });
    $("#deleteOk").onclick = async ev => {
      ev.preventDefault();
      pending = true; $("#deleteOk").disabled = true; cancelBtn.disabled = true;
      try {
        await api(`/api/history/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        dlg.removeEventListener("close", onClose);
        pending = false; dlg.close("ok"); res(true);
      } catch (e) {
        $("#deleteError").textContent = e.message; $("#deleteError").hidden = false;
      } finally { pending = false; $("#deleteOk").disabled = false; cancelBtn.disabled = false; }
    };
  });
  dlg.removeEventListener("cancel", block);
  if (!ok) return;
  activity(`deleted conversation "${title}"`, "ok");
  await afterConversationGone(id);
}

async function refreshSessions() {
  state.sessions = await (await api("/api/history/sessions")).json();
  renderSessions();
}

async function openSession(id, { restoreComposer = true } = {}) {
  const data = await (await api(`/api/history/sessions/${encodeURIComponent(id)}`)).json();
  const sameSession = state.sessionId === data.id;
  setCurrentSession(data.id);
  state.lastSeq = 0;
  state.loadedEntryCount = 0;
  $("#messages").querySelectorAll(".msg:not(.intro), .event, .qcard").forEach(n => n.remove());
  state.cards.clear();
  releaseBlobUrls();
  // Initial/history loads must not erase screenshots staged while the request was in flight.
  if (!sameSession) clearAttachments();
  if (!sameSession || !$("#input").value) $("#input").value = loadDraft(sessionStorage, data.id);
  history_(data.id).reset((data.entries || []).filter(e => e.role === "user").map(e => e.text || ""));
  for (const entry of data.entries || []) {
    if (entry.role === "user") addUserMsg(entry.text || "", entry.attachments || []);
    if (entry.role === "assistant") {
      if ((entry.text || "").trim()) {
        const bubble = addMsg("agent", md(entry.text));
        if (entry.runId && entry.state === "completed") addFeedbackBar(bubble.parentElement, data.id, entry);
      }
      if (entry.error) addEvent(`⚠ ${esc(entry.error)}`, "fail");
    }
    if (entry.role === "question") addPersistedQuestion(entry);
  }
  state.loadedEntryCount = (data.entries || []).length;
  state.displayedUserRuns = new Set((data.entries || []).filter(e => e.role === "user").map(e => e.runId));
  if (restoreComposer) {
    const speed = ["quick", "auto", "team"].includes(data.lastSpeed) ? data.lastSpeed : "auto";
    document.querySelector(`input[name="speed"][value="${speed}"]`).checked = true;
  }
  if (restoreComposer && data.lastMode && ["plan", "interactive", "autopilot"].includes(data.lastMode)) {
    const modeInput = document.querySelector(`input[name="mode"][value="${CSS.escape(data.lastMode)}"]`);
    if (modeInput) modeInput.checked = true;
  }
  // Backend reports repoId on session meta and/or on user entries; either means the conversation is pinned.
  const pinnedRepo = data.repoId || [...(data.entries || [])].reverse().find(e => e.role === "user" && e.repoId)?.repoId || "";
  state.repoPinned = !!pinnedRepo;
  if (pinnedRepo) state.repoId = pinnedRepo;
  else state.repoId = state.defaultRepoId;
  renderRepos();
  updateAutopilotState();
  {
    const modelSelect = $("#leadModel");
    if (restoreComposer && modelSelect && [...modelSelect.options].some(o => o.value === (data.lastModel || ""))) {
      modelSelect.value = data.lastModel || "";
    }
  }
  activity(`opened conversation "${data.title}"`);
  const status = await (await api(`/api/status?hqSessionId=${encodeURIComponent(state.sessionId)}`)).json();
  setRunning(!!status.busy);
  followLive();
  await refreshQueue();
  refreshPending().catch(() => {});
}

async function newChat() {
  const created = await (await api("/api/history/sessions", { method: "POST", body: JSON.stringify({}) })).json();
  await refreshSessions();
  await openSession(created.id);
  activity("new conversation");
}

async function refreshCurrentSessionFromHistory() {
  if (!state.sessionId) return;
  const data = await (await api(`/api/history/sessions/${encodeURIComponent(state.sessionId)}`)).json();
  const count = (data.entries || []).length;
  if (count <= state.loadedEntryCount) return;
  await openSession(state.sessionId, { restoreComposer: false });
}

async function newParallelSessionWindow() {
  const u = new URL(location.href);
  u.searchParams.delete("session");
  u.searchParams.set("new", "1");
  // noopener: a window opened with an opener inherits a COPY of sessionStorage, which would carry Autopilot grants.
  const w = window.open(u.toString(), "_blank", "noopener");
  if (!w && w !== null) {
    activity("popup blocked: allow popups to open parallel session window", "fail");
    return;
  }
  activity("opened parallel window");
}

// ---------- Chat rendering ----------
function scroll() { const m = $("#messages"); m.scrollTop = m.scrollHeight; }
function addMsg(role, html) {
  const div = document.createElement("div"); div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${html}</div>`; $("#messages").append(div); scroll(); return div.firstElementChild;
}
function addUserMsg(text, atts = []) {
  const bubble = addMsg("user", text ? md(text) : "");
  if (atts.length) {
    const row = document.createElement("div"); row.className = "msg-images";
    for (const a of atts) {
      if (!isImageAttachment(a)) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "ghost reference-file";
        button.textContent = `Download ${a.name || "reference file"}`;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const url = await fetchBlobUrl(a.url);
            const link = document.createElement("a"); link.href = url; link.download = a.name || "reference";
            document.body.append(link); link.click(); link.remove();
          } catch (err) { setAttachError(`Cannot download ${a.name}: ${err.message}`); }
          finally { button.disabled = false; }
        });
        row.append(button);
        continue;
      }
      const img = document.createElement("img");
      img.alt = a.name || "attached image"; img.className = "msg-image"; img.loading = "lazy";
      if (a.url) fetchBlobUrl(a.url).then(u => { img.src = u; }).catch(() => { img.replaceWith(Object.assign(document.createElement("span"), { className: "muted", textContent: `[image unavailable: ${a.name || "image"}]` })); });
      row.append(img);
    }
    bubble.append(row);
  }
  scroll();
  return bubble;
}
function addEvent(html, cls = "") {
  const div = document.createElement("div"); div.className = `event ${cls}`; div.innerHTML = html; $("#messages").append(div); scroll(); return div;
}

// Reward signals for one completed reply: 👍/👎, "used as written", plus Toby's verdict when he reviewed it.
function addFeedbackBar(msgEl, sessionId, entry) {
  const fb = { rating: entry.feedback?.rating || null, usedAsWritten: !!entry.feedback?.usedAsWritten };
  const bar = document.createElement("div"); bar.className = "feedback-bar";
  const toby = entry.feedback?.toby;
  const team = (entry.feedback?.agents || []).map(id => persona(id)?.persona?.split(" ")[0] || id);
  bar.innerHTML = `
    <button type="button" class="fb-btn" data-fb="up" title="Good answer — reward the agents who worked on it" aria-label="Thumbs up">👍</button>
    <button type="button" class="fb-btn" data-fb="down" title="Not good — counts against the agents who worked on it" aria-label="Thumbs down">👎</button>
    <button type="button" class="fb-btn fb-used" data-fb="used" title="I used this as written, without edits (the strongest reward)">📋 Used as written</button>
    ${toby ? `<span class="fb-toby ${toby.verdict}" title="Toby's compliance verdict counts toward the scorecard">${toby.verdict === "approved" ? "✅ Toby approved" : "⛔ Toby rejected"}</span>` : ""}
    ${team.length > 1 ? `<span class="fb-team muted" title="Agents credited for this reply">Credit: ${esc(team.join(", "))}</span>` : ""}
    <span class="fb-status muted" aria-live="polite"></span>`;
  const sync = () => {
    bar.querySelector('[data-fb="up"]').setAttribute("aria-pressed", String(fb.rating === "up"));
    bar.querySelector('[data-fb="down"]').setAttribute("aria-pressed", String(fb.rating === "down"));
    bar.querySelector('[data-fb="used"]').setAttribute("aria-pressed", String(fb.usedAsWritten));
  };
  sync();
  bar.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-fb]"); if (!btn || bar.dataset.busy) return;
    const kind = btn.dataset.fb;
    const patch = kind === "used" ? { usedAsWritten: !fb.usedAsWritten } : { rating: fb.rating === kind ? null : kind };
    bar.dataset.busy = "1";
    try {
      const saved = await (await api("/api/feedback", { method: "POST", body: JSON.stringify({ hqSessionId: sessionId, runId: entry.runId, ...patch }) })).json();
      fb.rating = saved.rating; fb.usedAsWritten = saved.usedAsWritten; sync();
      bar.querySelector(".fb-status").textContent = "Saved — the Dundies are updated";
      activity(`feedback recorded (${kind === "used" ? (fb.usedAsWritten ? "used as written" : "not used as written") : (fb.rating || "cleared")})`, "ok");
    } catch (err) {
      bar.querySelector(".fb-status").textContent = `Couldn't save: ${err.message}`;
    } finally { delete bar.dataset.busy; }
  });
  msgEl.classList.add("has-feedback");
  msgEl.append(bar);
  return bar;
}

function activity(text, cls = "") {
  const li = document.createElement("li"); li.className = cls; li.textContent = text;
  const ul = $("#activity"); ul.prepend(li); while (ul.children.length > 120) ul.lastChild.remove();
}
function avatarHtml(p) {
  return p.avatar ? `<img class="avatar" src="${esc(p.avatar)}" alt="" style="--c:${esc(p.color)}" />`
    : `<span class="avatar" style="--c:${esc(p.color)}">${esc(p.initials)}</span>`;
}

function onEvent(ev) {
  if (!ev || ev.t === "ping") return;
  if (typeof ev.seq === "number") {
    if (ev.seq <= state.lastSeq) return;
    state.lastSeq = ev.seq;
  }
  switch (ev.t) {
    case "snapshot":
      if (typeof ev.seq === "number") state.lastSeq = Math.max(state.lastSeq, ev.seq);
      setRunning(!!ev.busy);
      (ev.events || []).forEach(onEvent);
      return;
    case "start":
      setRunning(true);
      if (ev.queued && !state.displayedUserRuns.has(ev.runId)) {
        state.displayedUserRuns.add(ev.runId);
        state.bubbles.clear();
        addUserMsg(ev.message || "", ev.attachments || []);
      }
      activity(`run ${ev.runId.slice(0, 8)} started (${ev.mode})`);
      setWorking(LEAD_ID, true);
      state.currentReplay = ev.runId;
      break;
    case "queue":
      state.queue = ev;
      renderQueue();
      break;
    case "delta": {
      if (ev.agentId) break;
      let b = state.bubbles.get(ev.id);
      if (!b) { b = { el: addMsg("agent", ""), text: "" }; b.el.classList.add("typing"); state.bubbles.set(ev.id, b); }
      b.text += ev.text; b.el.parentElement.hidden = !b.text.trim();
      b.el.textContent = b.text;
      scroll();
      break;
    }
    case "message": {
      if (ev.agentId) break;
      let b = state.bubbles.get(ev.id);
      if (!b) { b = { el: addMsg("agent", "") }; state.bubbles.set(ev.id, b); }
      b.el.parentElement.hidden = false;
      b.el.classList.remove("typing");
      b.el.innerHTML = md(ev.text || "");
      b.el.parentElement.hidden = !(ev.text || "").trim();
      scroll();
      break;
    }
    case "delegate": {
      const p = persona(ev.agent); state.delegations.set(ev.callId, ev.agent); setWorking(ev.agent, true);
      addEvent(`${avatarHtml(p)} <span>Michael → <b>${esc(p.persona)}</b>${ev.model ? ` · ${esc(ev.model)}` : ""}: ${esc(ev.summary || "on it")}</span>`);
      activity(`delegate → ${ev.agent}${ev.model ? ` (${ev.model})` : ""}`);
      break;
    }
    case "tool":
      activity(`${ev.name}: ${String(ev.summary).slice(0, 140)}`);
      break;
    case "tool_end": {
      if ((ev.background || state.startedDelegations.has(ev.callId)) && state.delegations.has(ev.callId)) break;
      if (state.delegations.has(ev.callId)) {
        const id = state.delegations.get(ev.callId); state.delegations.delete(ev.callId); setWorking(id, isAgentActive(state.delegations, id));
        const p = persona(id);
        addEvent(`${avatarHtml(p)} <span>${esc(p.persona)} ${ev.ok ? "finished ✔" : "hit a problem ✖"}</span>`, ev.ok ? "ok" : "fail");
      }
      if (!ev.ok && ev.error) activity(`✖ ${ev.error.slice(0, 160)}`, "fail");
      break;
    }
    case "agent_start": {
      const id = ev.agent; if (!id) break;
      if (ev.callId) { state.delegations.set(ev.callId, id); state.startedDelegations.add(ev.callId); }
      setWorking(id, true);
      activity(`${id} started${ev.model ? ` (${ev.model})` : ""}`);
      break;
    }
    case "agent_end": {
      const key = findEndKey(state.delegations, ev.callId, ev.agent);
      const id = ev.agent || (key ? state.delegations.get(key) : null);
      if (key) state.delegations.delete(key);
      state.startedDelegations.delete(key);
      if (!id) break;
      setWorking(id, isAgentActive(state.delegations, id)); // two concurrent calls to one specialist stay working until both end
      const p = persona(id);
      if (ev.cancelled) addEvent(`${avatarHtml(p)} <span>${esc(p.persona)} stopped</span>`);
      else addEvent(`${avatarHtml(p)} <span>${esc(p.persona)} ${ev.ok === false ? "hit a problem ✖" : "finished ✔"}</span>`, ev.ok === false ? "fail" : "ok");
      if (!ev.cancelled && ev.ok === false && ev.error) activity(`✖ ${String(ev.error).slice(0, 160)}`, "fail");
      break;
    }
    case "result": {
      const lines = ev.usage?.codeChanges?.linesAdded || 0;
      $("#dundies").textContent = String(++state.dundies);
      activity(`done · ${ev.usage?.premiumRequests ?? "?"} premium req · ${lines} lines added`, "ok");
      break;
    }
    case "finalizing":
      activity(ev.text);
      break;
    case "log":
      if (ev.text?.trim()) activity(ev.text.trim().slice(0, 220));
      break;
    case "error":
      addEvent(`⚠ ${esc(ev.text)}`, "fail");
      activity(`error: ${String(ev.text || "").slice(0, 180)}`, "fail");
      break;
    case "session_deleted":
      if (ev.hqSessionId === state.sessionId) {
        activity("this conversation was deleted from another window", "fail");
        setRunning(false);
        afterConversationGone(ev.hqSessionId).catch(e => activity(e.message, "fail"));
      }
      return;
    case "end":
      setRunning(false);
      refreshSessions().catch(() => {});
      refreshPending().catch(() => {});
      refreshCurrentSessionFromHistory().catch(() => {});
      break;
    case "approval_required":
      activity(`approval required (${ev.request?.kind || "request"})`, "fail");
      if (ev.approvalId) addApprovalCard({ approvalId: ev.approvalId, request: ev.request });
      refreshPending().catch(() => {});
      break;
    case "question_required":
      activity(`agent asked a question`, "fail");
      if (ev.questionId) addQuestionCard({ questionId: ev.questionId, prompt: ev.prompt, choices: ev.choices, allowFreeform: ev.allowFreeform });
      refreshPending().catch(() => {});
      break;
    case "elicitation_required":
      activity(`${ev.source || "connector"} asks you to confirm a change`, "fail");
      if (ev.elicitationId) addElicitationCard(ev);
      refreshPending().catch(() => {});
      break;
    case "elicitation_resolved":
      resolveCard(ev.elicitationId, ev.action === "accept" ? "confirmed" : "declined");
      state.elicitations = state.elicitations.filter(e => e.elicitationId !== ev.elicitationId); renderPending();
      break;
    case "question_resolved":
      resolveCard(ev.questionId, String(ev.answer ?? ""));
      state.questions = state.questions.filter(q => q.questionId !== ev.questionId); renderPending();
      break;
    case "approval_resolved":
      resolveCard(ev.approvalId, ev.decision === "approve" ? "approved" : "denied");
      state.approvals = state.approvals.filter(a => a.approvalId !== ev.approvalId); renderPending();
      break;
  }
}

function setRunning(on) {
  state.running = on;
  updateSendButton();
  renderSessions();
  $("#stop").hidden = !on;
  if (!on) {
    document.querySelectorAll(".typing").forEach(x => x.classList.remove("typing"));
    document.querySelectorAll(".member.working").forEach(e => e.classList.remove("working"));
    state.delegations.clear();
    state.startedDelegations.clear();
  }
}

function updateSendButton() {
  $("#send").disabled = state.sending;
  $("#send").textContent = state.sending ? "Sending..."
    : state.running || state.queue.items.length || state.queue.paused ? "Queue for Michael" : "Send to Michael";
}
function renderQueue() {
  const host = $("#messageQueue");
  host.hidden = !state.queue.items.length && !state.queue.paused;
  $("#queueStatus").textContent = `${state.queue.items.length} queued${state.queue.paused ? " - paused" : ""}${state.queue.reason ? `: ${state.queue.reason}` : ""}`;
  $("#resumeQueue").hidden = !state.queue.paused;
  $("#pauseQueue").hidden = state.queue.paused || !state.queue.items.length;
  const list = $("#queueItems"); list.replaceChildren();
  for (const item of state.queue.items) {
    const li = document.createElement("li"), text = document.createElement("span"), remove = document.createElement("button");
    text.textContent = `${item.message || "(attached files)"} [${item.mode} / ${item.speed}${item.attachmentCount ? ` / ${item.attachmentCount} files` : ""}]${item.status === "uncertain" ? " - may have started; check history" : ""}`;
    remove.type = "button"; remove.className = "ghost"; remove.textContent = "Remove";
    remove.disabled = item.status === "starting";
    remove.addEventListener("click", () => queueAction("remove", { queueId: item.queueId }).catch(e => setAttachError(e.message)));
    li.append(text, remove); list.append(li);
  }
  updateSendButton();
}
async function refreshQueue() {
  const sid = state.sessionId;
  if (!sid) return;
  const q = await (await api(`/api/queue?hqSessionId=${encodeURIComponent(sid)}`)).json();
  if (sid !== state.sessionId) return;
  state.queue = q; renderQueue();
}
async function queueAction(action, extra = {}) {
  const sid = state.sessionId;
  const q = await (await api(`/api/queue/${action}`, {
    method: "POST", body: JSON.stringify({ hqSessionId: sid, ...extra }),
  })).json();
  if (sid === state.sessionId) { state.queue = q; renderQueue(); }
}

function fullTarget() { return { ...target(), repoId: state.repoId || undefined }; }
function updateAutopilotState() {
  const granted = grants.isGranted(state.sessionId, fullTarget());
  $("#autopilotState").hidden = !granted;
}
async function ensureAutopilotConfirmed() {
  if (grants.isGranted(state.sessionId, fullTarget())) return true;
  if (!(await confirmAutopilot())) return false;
  grants.grant(state.sessionId, fullTarget());
  updateAutopilotState();
  return true;
}
async function confirmAutopilot() {
  const t = target(); const expected = autopilotExpected(t);
  $("#cTarget").textContent = "this conversation";
  $("#cInput").value = "";
  $("#cOk").disabled = true;
  $("#cInput").oninput = () => { $("#cOk").disabled = $("#cInput").value.trim() !== expected; };
  $("#confirm").showModal();
  return new Promise(res => $("#confirm").addEventListener("close", () => res($("#confirm").returnValue === "ok"), { once: true }));
}

async function streamNdjson(response) {
  const reader = response.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* ignore malformed event */ }
    }
  }
  const tail = buf.trim();
  if (tail) { try { onEvent(JSON.parse(tail)); } catch { /* ignore */ } }
}

async function followLive(attempt = 0) {
  if (!state.sessionId) return;
  const sid = state.sessionId;
  clearTimeout(state.liveRetry); clearTimeout(state.reconcileRetry);
  state.liveAbort?.abort();
  const ctl = state.liveAbort = new AbortController();
  let gotData = false;
  try {
    const r = await api(`/api/live?hqSessionId=${encodeURIComponent(sid)}`, { signal: ctl.signal });
    if (attempt > 0) await reconcileAfterReconnect(sid);
    gotData = true;
    await streamNdjson(r);
  } catch (e) {
    if (e.name === "AbortError") return;
    activity(`live stream: ${e.message}`, "fail");
  }
  // Stream ended or failed: retry with backoff while this conversation is still the current one and not superseded.
  if (ctl.signal.aborted || state.sessionId !== sid || state.liveAbort !== ctl) return;
  const next = gotData ? 1 : attempt + 1;
  state.liveRetry = setTimeout(() => { if (state.sessionId === sid && state.liveAbort === ctl && !ctl.signal.aborted) followLive(next); }, backoffMs(next - 1));
}
// Reconcile status, pending (authoritative) and history after a reconnect; on failure retry with backoff, independent of the stream,
// until it succeeds or the conversation changes.
async function reconcileAfterReconnect(sid, attempt = 0) {
  if (state.sessionId !== sid) return;
  try {
    const status = await (await api(`/api/status?hqSessionId=${encodeURIComponent(sid)}`)).json();
    if (state.sessionId !== sid) return;
    setRunning(!!status.busy);
    await refreshPending({ authoritative: true });
    await refreshQueue();
    await refreshCurrentSessionFromHistory();
  } catch {
    clearTimeout(state.reconcileRetry);
    state.reconcileRetry = setTimeout(() => reconcileAfterReconnect(sid, attempt + 1), backoffMs(attempt));
  }
}

async function uploadAttachments(items, sid = state.sessionId) {
  const ids = [];
  for (const it of items) {
    if (!it.uploadedId || it.uploadedFor !== sid) { // reuse uploads when a send is retried
      const data = await fileToBase64(it.file);
      const r = await (await api(`/api/history/sessions/${encodeURIComponent(sid)}/attachments`, {
        method: "POST",
        body: JSON.stringify({ name: it.file.name || "screenshot", mimeType: it.file.type, data }),
      })).json();
      it.uploadedId = r.id; it.uploadedFor = sid;
    }
    ids.push(it.uploadedId);
  }
  return ids;
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error(`could not read ${file.name}`));
    fr.onload = () => res(String(fr.result).split(",")[1] || "");
    fr.readAsDataURL(file);
  });
}

function leadLacksVision() {
  const id = $("#leadModel").value;
  if (!id) return false; // default model: the backend decides
  const m = state.models.find(x => x.id === id);
  return !!m && !m.supportsVision;
}

async function send(e) {
  e.preventDefault();
  if (!state.sessionId) await newChat();
  const message = $("#input").value.trim();
  const items = state.attachments.slice();
  if ((!message && !items.length) || state.sending) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const speed = document.querySelector('input[name="speed"]:checked').value;
  if (items.some(a => isImageAttachment(a.file)) && leadLacksVision()) {
    setAttachError("The selected lead model cannot read images. Remove the images or pick a model without the (no images) label.");
    return;
  }
  if (mode === "autopilot" && !(await ensureAutopilotConfirmed())) return;
  const sid = state.sessionId;
  const selectedTarget = target(), selectedRepoId = state.repoId, selectedModel = $("#leadModel").value;
  const queued = state.running || state.queue.items.length > 0 || state.queue.paused;
  const wasRunning = state.running;
  state.sending = true; updateSendButton();
  setAttachError("");
  if (!queued) setRunning(true);
  const agentModels = Object.fromEntries([...document.querySelectorAll("select[data-agent-model]")].filter(x => x.value).map(x => [x.dataset.agentModel, x.value]));
  const fail = msg => {
    // Text and staged images stay in the composer so nothing is lost; uploaded ids are reused on retry.
    state.sending = false; updateSendButton();
    setAttachError(msg); addEvent(`⚠ ${esc(msg)}`, "fail"); activity(`send failed: ${msg}`, "fail");
    if (state.sessionId === sid && !queued) setRunning(wasRunning);
  };
  let attachmentIds = [];
  try {
    if (items.length) attachmentIds = await uploadAttachments(items, sid);
  } catch (err) { return fail(`Could not upload files: ${err.message}`); }
  state.abort = new AbortController();
  let accepted;
  try {
    accepted = await (await api("/api/chat", {
      method: "POST",
      signal: state.abort.signal,
      body: JSON.stringify({
        message,
        queue: queued,
        mode,
        speed,
        ...selectedTarget,
        hqSessionId: sid,
        repoId: selectedRepoId || undefined,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        agentModels: Object.keys(agentModels).length ? agentModels : undefined,
        model: selectedModel || undefined,
      }),
    })).json();
  } catch (err) {
    fail(err.name === "AbortError" ? "Send cancelled; check history before retrying." : err.message);
    refreshSessions().catch(() => {});
    return;
  }
  state.sending = false; updateSendButton();
  if (state.sessionId !== sid) return;
  if (accepted.queued) {
    history_(sid).push(message);
    if ($("#input").value.trim() === message) { $("#input").value = ""; saveDraft(sessionStorage, sid, ""); }
    state.attachments = state.attachments.filter(a => !items.includes(a));
    for (const item of items) URL.revokeObjectURL(item.preview);
    renderAttachments();
    activity(`queued for Michael (#${accepted.position})`);
    await refreshQueue();
    return;
  }
  // Accepted: now it is safe to move the prompt into the transcript and clear the composer.
  addUserMsg(message, items.map(a => ({
    name: a.file.name, mimeType: a.file.type, size: a.file.size,
    url: `/api/history/sessions/${encodeURIComponent(sid)}/attachments/${encodeURIComponent(a.uploadedId)}`,
  })));
  for (const item of items) URL.revokeObjectURL(item.preview);
  history_(state.sessionId).push(message);
  if ($("#input").value.trim() === message) { $("#input").value = ""; saveDraft(sessionStorage, state.sessionId, ""); }
  state.attachments = state.attachments.filter(a => !items.includes(a)); renderAttachments();
  state.bubbles.clear();
  // The server pins the repo on the first accepted run, including when the UI sent none (default repo).
  if (accepted?.repoId) { state.repoId = accepted.repoId; state.repoPinned = true; renderRepos(); }
  activity("request accepted");
  refreshSessions().catch(() => {});
}

// ---------- Attachments ----------
function setAttachError(msg) { const el = $("#attachError"); el.textContent = msg; el.hidden = !msg; }
function clearAttachments() {
  state.attachments.forEach(a => URL.revokeObjectURL(a.preview));
  state.attachments = []; renderAttachments(); setAttachError("");
}
function addFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length) return;
  const { accepted, errors } = validateAttachments(state.attachments.map(a => a.file), incoming);
  accepted.forEach(file => state.attachments.push({ file, preview: URL.createObjectURL(file) }));
  setAttachError(errors.join(" "));
  renderAttachments();
}
function renderAttachments(revokeRemoved = true) {
  const host = $("#attachPreview");
  $("#attachCount").textContent = `${state.attachments.length}/${ATTACH_LIMITS.maxCount}`;
  host.hidden = !state.attachments.length;
  host.innerHTML = "";
  state.attachments.forEach((a, i) => {
    const li = document.createElement("li"); li.className = "attach-item";
    const img = document.createElement(isImageAttachment(a.file) ? "img" : "span");
    if (isImageAttachment(a.file)) { img.src = a.preview; img.alt = a.file.name || "pasted image"; }
    else { img.className = "reference-label"; img.textContent = a.file.name; }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "icon-btn"; btn.textContent = "✕";
    btn.setAttribute("aria-label", `Remove ${a.file.name || "image"}`);
    btn.addEventListener("click", () => {
      const [gone] = state.attachments.splice(i, 1);
      if (revokeRemoved) URL.revokeObjectURL(gone.preview);
      setAttachError(""); renderAttachments();
      $("#input").focus();
    });
    li.append(img, btn); host.append(li);
  });
}
function bindAttachments() {
  $("#attachInput").accept = FILE_ACCEPT;
  $("#attachBtn").addEventListener("click", () => $("#attachInput").click());
  $("#attachInput").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
  const ta = $("#input");
  ta.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const form = $("#composer");
  form.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); form.classList.add("dragging"); } });
  form.addEventListener("dragleave", () => form.classList.remove("dragging"));
  form.addEventListener("drop", e => {
    form.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); }
  });
}

async function stop() {
  if (!state.sessionId) return;
  try { await api("/api/stop", { method: "POST", body: JSON.stringify({ hqSessionId: state.sessionId }) }); } catch { /* ignore */ }
  state.abort?.abort();
  addEvent("⏹ Stopped. Michael: \"Okay, everybody stop. Stop. Meeting adjourned.\"");
  setRunning(false);
}

function bindComposerKeyboard() {
  const ta = $("#input");
  ta.addEventListener("input", () => saveDraft(sessionStorage, state.sessionId, ta.value));
  ta.addEventListener("keydown", e => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const h = history_(state.sessionId);
      const v = e.key === "ArrowUp" ? h.up(e, ta) : h.down(e, ta);
      if (v !== null) { e.preventDefault(); ta.value = v; ta.setSelectionRange(v.length, v.length); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
}

// ---------- Models ----------
async function loadModels() {
  try {
    const r = await (await api("/api/models")).json();
    state.models = (r.models || []).filter(m => m && m.id);
  } catch (e) {
    state.models = [];
    activity(`models unavailable: ${e.message}`, "fail");
  }
  const sel = $("#leadModel");
  const keep = sel.value;
  sel.innerHTML = `<option value="">Lead model: default</option>` + state.models.map(m =>
    `<option value="${esc(m.id)}">${esc(m.name || m.id)}${m.supportsVision ? "" : " (no images)"}</option>`).join("");
  if (state.models.some(m => m.id === keep)) sel.value = keep;
  renderAgentModels();
}
function renderAgentModels() {
  const host = $("#agentModelsList");
  const specialists = state.team.filter(m => m.id !== LEAD_ID);
  $("#agentModels").hidden = !state.models.length || !specialists.length;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("dm.agentModels") || "{}"); } catch { saved = {}; }
  host.innerHTML = specialists.map(m => `
    <label class="agent-model">
      <span>${esc(m.persona)}</span>
      <select data-agent-model="${esc(m.id)}" aria-label="Model for ${esc(m.persona)}">
        <option value="">default</option>
        ${state.models.map(x => `<option value="${esc(x.id)}"${saved[m.id] === x.id ? " selected" : ""}>${esc(x.name || x.id)}</option>`).join("")}
      </select>
    </label>`).join("");
  const refreshCount = () => {
    const chosen = Object.fromEntries([...host.querySelectorAll("select")].filter(x => x.value).map(x => [x.dataset.agentModel, x.value]));
    localStorage.setItem("dm.agentModels", JSON.stringify(chosen));
    $("#agentModelsCount").textContent = Object.keys(chosen).length;
  };
  host.querySelectorAll("select").forEach(x => x.addEventListener("change", refreshCount));
  refreshCount();
}

// ---------- Repositories ----------
async function loadRepos() {
  try {
    const r = await (await api("/api/repos")).json();
    state.repos = r.repos || [];
    state.defaultRepoId = r.defaultRepoId || "";
    if (!state.repoId) state.repoId = state.defaultRepoId;
  } catch (e) { state.repos = []; activity(`repos unavailable: ${e.message}`, "fail"); }
  renderRepos();
}
function renderRepos() { updateAutopilotState(); }
// ---------- Pane layout ----------
function applyLayout() {
  const L = state.ui, lay = $("#layout");
  const left = L.focus ? "hidden" : L.left, right = L.focus ? "hidden" : L.right;
  lay.style.setProperty("--left-col", `${paneColumn(left, L.leftW)}px`);
  lay.style.setProperty("--right-col", `${paneColumn(right, L.rightW)}px`);
  lay.style.setProperty("--rz-left", left === "open" ? "10px" : "0px");
  lay.style.setProperty("--rz-right", right === "open" ? "10px" : "0px");
  [["#paneTeam", left, "team"], ["#paneTarget", right, "target"]].forEach(([sel, st, name]) => {
    const el = $(sel); el.dataset.state = st; el.hidden = st === "hidden";
    const c = el.querySelector('[data-pane-act="compress"]');
    const expanded = st !== "compact";
    c.textContent = expanded ? (name === "team" ? "«" : "»") : (name === "team" ? "»" : "«");
    c.setAttribute("aria-label", `${expanded ? "Compress" : "Expand"} ${name} pane`);
    c.title = expanded ? "Compress" : "Expand";
  });
  $("#rzLeft").hidden = left !== "open"; $("#rzRight").hidden = right !== "open";
  $("#rzLeft").setAttribute("aria-valuenow", String(L.leftW)); $("#rzRight").setAttribute("aria-valuenow", String(L.rightW));
  for (const z of [$("#rzLeft"), $("#rzRight")]) { z.setAttribute("aria-valuemin", String(PANE.min)); z.setAttribute("aria-valuemax", String(PANE.max)); }
  $("#toggleTeam").setAttribute("aria-pressed", String(left === "open"));
  $("#toggleTarget").setAttribute("aria-pressed", String(right === "open"));
  $("#focusChat").setAttribute("aria-pressed", String(L.focus));
  savePrefs();
}
function bindLayout() {
  const L = state.ui;
  document.querySelectorAll(".pane").forEach(pane => {
    const side = pane.dataset.pane === "left" ? "left" : "right";
    pane.querySelector('[data-pane-act="compress"]').addEventListener("click", () => { L.focus = false; L[side] = L[side] === "compact" ? "open" : "compact"; applyLayout(); });
    pane.querySelector('[data-pane-act="hide"]').addEventListener("click", () => { L[side] = "hidden"; applyLayout(); $(side === "left" ? "#toggleTeam" : "#toggleTarget").focus(); });
  });
  const toggle = side => () => { L.focus = false; L[side] = L[side] === "open" ? "hidden" : "open"; applyLayout(); };
  $("#toggleTeam").addEventListener("click", toggle("left"));
  $("#toggleTarget").addEventListener("click", toggle("right"));
  $("#focusChat").addEventListener("click", () => { L.focus = !L.focus; applyLayout(); });
  const bindResizer = (el, key, dir) => {
    el.addEventListener("keydown", e => {
      const w = resizeByKey(e.key, e.shiftKey, L[key], dir);
      if (w !== null) { e.preventDefault(); L[key] = w; applyLayout(); }
    });
    el.addEventListener("pointerdown", e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = L[key];
      const move = ev => { L[key] = clampWidth(w0 + (ev.clientX - x0) * dir); applyLayout(); };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  };
  bindResizer($("#rzLeft"), "leftW", 1);
  bindResizer($("#rzRight"), "rightW", -1);
  applyLayout();
}

async function ensureCurrentSession() {
  if (urlWantsNewSession()) {
    const created = await (await api("/api/history/sessions", { method: "POST", body: JSON.stringify({}) })).json();
    setCurrentSession(created.id);
    const u = new URL(location.href);
    u.searchParams.delete("new");
    history.replaceState(null, "", u.toString());
    await refreshSessions();
    await openSession(state.sessionId);
    return;
  }
  await refreshSessions();
  if (!state.sessionId || !state.sessions.some(s => s.id === state.sessionId)) {
    const created = await (await api("/api/history/sessions", { method: "POST", body: JSON.stringify({}) })).json();
    setCurrentSession(created.id);
    await refreshSessions();
  }
  await openSession(state.sessionId);
}

// ---------- Connectors & quick prompts ----------
async function loadConnectors() {
  const el = $("#connectors");
  try {
    const data = await (await api("/api/connectors")).json();
    if (data.disabled) { el.innerHTML = '<li class="muted">Connectors disabled (DM_DISABLE_MCP=1).</li>'; return; }
    if (!data.connectors.length) { el.innerHTML = '<li class="muted">No connectors configured.</li>'; return; }
    el.innerHTML = data.connectors.map(c => `<li class="connector ${c.available ? "on" : "off"}" title="${esc(c.available ? c.provides.join(", ") : c.reason || "")}">
      <span class="dot" aria-hidden="true"></span><div><b>${esc(c.label)}</b><div class="muted">${esc(c.available ? c.provides.join(" · ") : c.reason || "unavailable")}</div>${c.needsSignIn ? `<button type="button" class="ghost small" data-signin="${esc(c.name)}">Sign in</button>` : ""}</div></li>`).join("")
      + (data.outboundApproval ? '<li class="muted small">✋ Interactive mode asks before connector writes. Approved Autopilot runs routine tools without extra HQ clicks; service confirmations and managed approvals still apply.</li>' : "");
    // A sign-in check still running on the server: look again once it has had time to finish.
    clearTimeout(state.connectorRecheck);
    if (data.connectors.some(c => c.checking)) state.connectorRecheck = setTimeout(() => loadConnectors().catch(() => {}), 24000);
    el.querySelectorAll("button[data-signin]").forEach(btn => btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Opening sign-in…";
      try {
        const r = await (await api(`/api/connectors/${encodeURIComponent(btn.dataset.signin)}/sign-in`, { method: "POST", body: "{}" })).json();
        activity(`sign-in started: ${r.command}`, "ok");
        btn.textContent = "Finish in your browser…";
        // Re-check a few times while the user completes the browser sign-in.
        for (const wait of [15000, 30000, 60000]) setTimeout(() => loadConnectors().catch(() => {}), wait);
      } catch (err) { btn.disabled = false; btn.textContent = "Sign in"; activity(`sign-in failed: ${err.message}`, "fail"); }
    }));
  } catch (e) { el.innerHTML = `<li class="fail">${esc(e.message)}</li>`; }
}
function bindQuickPrompts() {
  document.querySelectorAll("#quickPrompts [data-prompt]").forEach(b => b.addEventListener("click", () => {
    const ta = $("#input"); ta.value = b.dataset.prompt; ta.focus(); saveDraft(sessionStorage, state.sessionId, ta.value);
  }));
}

async function init() {
  state.team = await (await api("/api/team")).json();
  state.byId = Object.fromEntries(state.team.map(m => [m.id, m]));
  renderRoster();
  bindLayout(); bindAttachments();
  $("#roster").addEventListener("click", e => { const b = e.target.closest(".team-toggle"); if (b) toggleTeam(b.dataset.team); });
  $("#revokeAutopilot").addEventListener("click", () => { grants.revoke(state.sessionId); updateAutopilotState(); activity("autopilot confirmation revoked"); });
  $("#resumeQueue").addEventListener("click", () => queueAction("resume").catch(e => setAttachError(e.message)));
  $("#pauseQueue").addEventListener("click", () => queueAction("pause").catch(e => setAttachError(e.message)));
  bindQuickPrompts();
  const st = $("#showStudy");
  if (st) { st.checked = showStudyRuns(); st.addEventListener("change", () => { localStorage.setItem("dm.showStudy", st.checked ? "1" : "0"); renderSessions(); }); }
  await Promise.all([loadModels(), loadRepos(), loadConnectors()]);
  $("#composer").addEventListener("submit", send);
  bindComposerKeyboard();
  $("#stop").addEventListener("click", stop);
  $("#newChat").addEventListener("click", () => newChat().catch(e => activity(e.message, "fail")));
  $("#newParallel").addEventListener("click", () => newParallelSessionWindow().catch(e => activity(e.message, "fail")));
  await ensureCurrentSession();
  const status = await (await api(`/api/status?hqSessionId=${encodeURIComponent(state.sessionId)}`)).json();
  if (status.busy) {
    activity("reconnected: run still in progress");
    setRunning(true);
  }
  await refreshPending();
  followLive();
}

init().catch(e => addEvent(`⚠ ${esc(e.message)}`, "fail"));
