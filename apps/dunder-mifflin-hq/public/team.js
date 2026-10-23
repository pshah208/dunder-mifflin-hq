const TOKEN = document.querySelector('meta[name="dm-token"]').content;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = p => fetch(p, { headers: { "X-DM-Token": TOKEN } }).then(r => r.json());
const send = (p, method, body) => fetch(p, { method, headers: { "Content-Type": "application/json", "X-DM-Token": TOKEN }, body: JSON.stringify(body || {}) });

let NOTES = {}, STUDY = null;
function learnedHtml(m) {
  const n = NOTES[m.id];
  const btn = `<button type="button" class="ghost small study-one" data-study="${esc(m.id)}" title="Let ${esc(m.persona.split(" ")[0])} read up now (one study run)">📖 Study now</button>`;
  if (!n) return `<div class="learned none muted">📖 Hasn't studied their character yet. ${btn}</div>`;
  const list = xs => xs.map(x => `<li>${esc(x)}</li>`).join("");
  // Source URLs are validated server-side (public http(s) only); links are hardened here too.
  const sources = (n.sources || []).filter(s => /^https?:\/\//i.test(s.url || ""))
    .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>`).join(" · ");
  return `<details class="learned"><summary>📖 What I've learned about my character</summary>
    ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
    ${n.traits?.length ? `<p class="muted">Traits</p><ul>${list(n.traits)}</ul>` : ""}
    ${n.quips?.length ? `<p class="muted">Lines I might say in the Office (original)</p><ul class="quips">${list(n.quips)}</ul>` : ""}
    ${sources ? `<p class="muted learned-src">Sources: ${sources}</p>` : ""}
    <p class="muted">Updated ${esc(new Date(n.updatedAt).toLocaleString())} · studied ${n.studies || 1}× ${btn}</p>
  </details>`;
}

const SOURCE_LABEL = { m365: "Microsoft 365", msx: "MSX", azure: "Azure", learn: "MS Learn", code: "Code", files: "Office files", seismic: "Seismic", routing: "Routing" };

function card(m, cls = "") {
  const sources = (m.sources || []).map(s => `<span class="chip src">${esc(SOURCE_LABEL[s] || s)}</span>`).join("");
  return `<article class="card ${cls}" style="--c:${esc(m.color)}">
    <img class="avatar" src="${esc(m.avatar)}" alt="${esc(m.persona)}" style="--c:${esc(m.color)}" />
    <div><div class="name">${esc(m.persona)}</div><div class="title">${esc(m.title)}</div></div>
    <div class="meta"><span class="chip">${esc(m.id)}</span><span class="chip model">🧠 ${esc(m.model)}</span>${sources}</div>
    <details><summary>What I do</summary><p>${esc(m.summary)}</p><p class="muted">Owns: ${esc(m.owns)}</p></details>
    ${STUDY ? learnedHtml(m) : ""}
  </article>`;
}

const FLOW = [
  ["regional-manager", "Michael reads the request and picks people + models"],
  ["office-administrator", "Pam pulls mail, calendar and Teams context"],
  ["sales-lead", "Dwight pulls MSX pipeline and milestones"],
  ["cloud-ai-architect", "Oscar adds technical depth"],
  ["presentation-designer", "Andy packages it"],
  ["qa-reviewer", "Creed checks facts and code"],
  ["compliance-officer", "Toby clears anything outbound"],
];

const team = await api("/api/team");
const by = Object.fromEntries(team.map(m => [m.id, m]));
try { STUDY = await api("/api/personas/notes"); NOTES = STUDY.notes || {}; } catch { STUDY = null; }
function renderCards() {
$("#count").textContent = team.length;
$("#leadSlot").innerHTML = card(by["regional-manager"], "big");
$("#salesLead").innerHTML = by["sales-lead"] ? card(by["sales-lead"], "sublead") : "";
$("#sales").innerHTML = team.filter(m => m.team === "sales" && m.id !== "sales-lead").map(m => card(m)).join("");
$("#engLead").innerHTML = by["cloud-ai-architect"] ? card(by["cloud-ai-architect"], "sublead") : "";
$("#engineering").innerHTML = team.filter(m => m.team === "engineering" && m.id !== "cloud-ai-architect").map(m => card(m)).join("");
$("#quality").innerHTML = team.filter(m => m.team === "quality").map(m => card(m)).join("");
}
renderCards();
$("#flow").innerHTML = FLOW.filter(([id]) => by[id]).map(([id, label]) =>
  `<li><img src="${esc(by[id].avatar)}" alt="" />${esc(label)}</li>`).join("");

try {
  const { connectors = [] } = await api("/api/connectors");
  $("#connectors").innerHTML = connectors.map(c => `<li class="connector ${c.available ? "on" : "off"}">
    <span class="dot" aria-hidden="true"></span><div><b>${esc(c.label)}</b>
    <div class="muted">${esc(c.available ? c.provides.join(" · ") : c.reason || "unavailable")}</div>
    <div class="used-by">${c.usedBy.filter(id => by[id]).map(id => `<img src="${esc(by[id].avatar)}" alt="${esc(by[id].persona)}" title="${esc(by[id].persona)}" />`).join("")}</div></div></li>`).join("");
} catch { /* connectors are optional on this page */ }

// ---------- Character study controls (downtime) ----------
// Mirrors persona-study.mjs pickStudents: never-studied first, then the stalest notes.
const nextUp = (ids, notes, n) => {
  const ts = id => (notes[id]?.updatedAt ? Date.parse(notes[id].updatedAt) || 0 : -1);
  return [...ids].sort((a, b) => (ts(a) - ts(b)) || (ids.indexOf(a) - ids.indexOf(b))).slice(0, n);
};
const firstName = id => (by[id]?.persona || id).split(" ")[0];
function renderStudy() {
  const s = STUDY; if (!s) return;
  $("#study").hidden = false;
  const st = s.settings;
  $("#studyEnabled").checked = st.enabled;
  $("#studyTime").value = `${String(st.hour).padStart(2, "0")}:${String(st.minute).padStart(2, "0")}`;
  $("#studyPerRun").value = String(st.perRun);
  const ids = team.map(m => m.id);
  const done = ids.filter(id => NOTES[id]).length;
  $("#studyBarFill").style.width = `${Math.round((done / ids.length) * 100)}%`;
  $("#studyProgress").textContent = `${done} of ${ids.length} characters have studied themselves${done === ids.length ? " 🎉" : ""}`;
  const days = Math.ceil((ids.length - done) / st.perRun);
  $("#studyNext").textContent = `Next up: ${nextUp(ids, NOTES, st.perRun).map(firstName).join(", ")}`
    + (done < ids.length && st.enabled ? ` · everyone covered in about ${days} more day${days === 1 ? "" : "s"} at ${st.perRun} per study` : "");
  const last = s.lastRun;
  $("#studyStatus").textContent = s.running ? "A study is in progress — watch the Office."
    : last ? `Last study ${new Date(last.startedAt).toLocaleString()}: ${last.state}${last.state === "completed" ? `, ${last.learned} agent(s) learned something` : ""}${last.error ? ` (${last.error})` : ""}.`
      : "No character study yet.";
  if (!s.schedulerEnabled) $("#studyStatus").textContent += " The daily schedule is off for this server (DM_STUDY_SCHEDULER=0).";
}
async function refreshStudy() { try { STUDY = await api("/api/personas/notes"); NOTES = STUDY.notes || {}; renderCards(); renderStudy(); } catch { /* optional */ } }
async function startStudy(agents) {
  const res = await send("/api/personas/study", "POST", agents ? { agents } : {});
  const body = await res.json().catch(() => ({}));
  $("#studyStatus").textContent = res.ok ? `Started: ${body.students.map(firstName).join(", ")} ${body.students.length === 1 ? "is" : "are"} reading up. Watch the Office.` : `Could not start: ${body.error || res.status}`;
  if (res.ok) { STUDY.running = true; for (const wait of [20000, 60000, 120000, 240000]) setTimeout(refreshStudy, wait); }
}
if (STUDY) {
  renderStudy();
  const save = async () => {
    const [hour, minute] = $("#studyTime").value.split(":").map(Number);
    const res = await send("/api/personas/settings", "PUT", { enabled: $("#studyEnabled").checked, hour, minute, perRun: Number($("#studyPerRun").value) });
    const body = await res.json().catch(() => ({}));
    $("#studySaved").textContent = res.ok ? "Saved ✓" : `Could not save (${body.error || res.status})`;
    if (res.ok) { STUDY.settings = body.settings; renderStudy(); }
  };
  $("#study").querySelectorAll(".study-controls input, .study-controls select").forEach(el => { el.onchange = save; });
  $("#studyNow").onclick = async () => { $("#studyNow").disabled = true; try { await startStudy(); } finally { $("#studyNow").disabled = false; } };
  $("#org").addEventListener("click", e => {
    const b = e.target.closest("button[data-study]"); if (!b) return;
    e.preventDefault(); b.disabled = true; b.textContent = "📖 Reading…";
    startStudy([b.dataset.study]).finally(() => { b.disabled = false; });
  });
}
