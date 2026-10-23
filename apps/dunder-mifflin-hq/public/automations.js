const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="dm-token"]').content;
let team = [], models = [], state = { definitions: [], runs: [] }, selected = null, dirty = false, busy = false;
let buildRunId = null, pollTimer = null, refreshing = false;
let editorRevision = null;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const error = message => { $("error").textContent = message; $("error").hidden = !message; };
const notice = message => { $("notice").textContent = message; };
async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, headers: { "X-DM-Token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "HQ restarted. Refresh this page before continuing." : data.error || `Request failed (${response.status})`);
  return data;
}
async function act(operation) {
  if (busy) return;
  busy = true; error(""); controls();
  try { await operation(); } catch (e) { error(e.message); }
  finally { busy = false; controls(); }
}
const active = () => state.runs.some(r => r.state === "running");
const saved = () => state.definitions.find(d => d.id === selected);
function controls() {
  const def = saved(), unsaved = dirty || !def || def.revision !== editorRevision, running = active();
  $("saveState").textContent = dirty ? "Unsaved changes" : def ? `Revision ${def.revision} · ${def.enabled ? "Scheduled" : "Paused / on demand"}` : "Not saved";
  $("saveWorkflow").disabled = busy || (def && state.runs.some(r => r.automationId === def.id && r.state === "running"));
  for (const id of ["testWorkflow", "runWorkflow"]) $(id).disabled = busy || unsaved || running;
  $("deleteWorkflow").disabled = busy || !def || state.runs.some(r => r.automationId === selected && r.state === "running");
  $("toggleSchedule").textContent = def?.enabled ? "Pause schedule" : "Enable schedule";
  $("toggleSchedule").disabled = busy || unsaved || (!def?.enabled && (def?.schedule.type === "manual" || def?.testedRevision !== def?.revision || running || !state.schedulerEnabled || !!state.schedulerError));
  $("buildButton").disabled = busy || running;
  $("addStep").disabled = busy || $("steps").children.length >= 10;
}
function change() { dirty = true; controls(); }
function scheduleFields() {
  const type = $("triggerType").value;
  $("minutesField").hidden = type !== "interval";
  $("timeField").hidden = $("timezoneField").hidden = !["daily", "weekly"].includes(type);
  $("weekdayField").hidden = type !== "weekly";
}
function selectOptions(select, entries, current) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = node("option", label); option.value = value; return option;
  }));
  select.value = current;
}
function stepCard(step = { title: "", agent: "auto", instruction: "", condition: "" }) {
  const card = node("div", null, "automation-step");
  const bar = node("div", null, "automation-actions");
  const heading = node("strong", "Step"); bar.append(heading);
  for (const [label, action] of [["Up", "up"], ["Down", "down"], ["Remove", "remove"]]) {
    const button = node("button", label); button.type = "button";
    button.addEventListener("click", () => {
      if (action === "remove") { if ($("steps").children.length === 1) return error("Keep at least one step."); card.remove(); }
      if (action === "up" && card.previousElementSibling) card.previousElementSibling.before(card);
      if (action === "down" && card.nextElementSibling) card.nextElementSibling.after(card);
      renumber(); change();
    });
    bar.append(button);
  }
  card.append(bar);
  const fields = node("div", null, "automation-fields");
  for (const [key, label, tag, max] of [
    ["title", "Step title", "input", 120], ["agent", "Assigned specialist", "select"],
    ["instruction", "Instructions, sources and filters", "textarea", 2500], ["condition", "Only if (optional)", "textarea", 500],
  ]) {
    const wrapper = node("label", label), input = node(tag);
    input.dataset.field = key;
    if (key === "agent") selectOptions(input, [["auto", "Auto - Michael routes"], ...team.map(a => [a.id, `${a.persona} - ${a.title}`])], step.agent);
    else { input.value = step[key] || ""; input.maxLength = max; input.required = key !== "condition"; }
    wrapper.append(input);
    (key === "title" || key === "agent" ? fields : card).append(wrapper);
  }
  card.insertBefore(fields, bar.nextSibling);
  return card;
}
function renumber() {
  [...$("steps").children].forEach((card, index) => {
    card.querySelector("strong").textContent = `Step ${index + 1}`;
    const buttons = card.querySelectorAll("button");
    buttons[0].disabled = index === 0; buttons[1].disabled = index === $("steps").children.length - 1;
    buttons[2].disabled = $("steps").children.length === 1;
  });
}
function renderModels(overrides = {}) {
  $("modelOverrides").replaceChildren(...team.map(agent => {
    const label = node("label", agent.persona), select = node("select");
    select.dataset.agent = agent.id;
    const defaultLabel = models.length && !models.includes(agent.model) ? `Inherit session (${agent.model} unavailable)` : `Default (${agent.model})`;
    const entries = [["", defaultLabel], ...models.map(model => [model, model])];
    if (overrides[agent.id] && !models.includes(overrides[agent.id])) entries.push([overrides[agent.id], `${overrides[agent.id]} (not in current catalog)`]);
    selectOptions(select, entries, overrides[agent.id] || ""); label.append(select); return label;
  }));
}
function openEditor(definition = {}) {
  selected = definition.id || null;
  editorRevision = definition.revision ?? null;
  $("editorTitle").textContent = selected ? "Edit workflow" : "New workflow";
  $("workflowName").value = definition.name || "";
  $("workflowDescription").value = definition.description || "";
  $("workflowMode").value = definition.mode || "plan";
  const schedule = definition.schedule || { type: "manual" };
  $("triggerType").value = schedule.type;
  $("intervalMinutes").value = schedule.minutes || 60;
  $("scheduleTime").value = schedule.time || "08:30";
  $("scheduleTimezone").value = schedule.timezone || state.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("scheduleDay").value = schedule.weekday ?? 1;
  $("timeoutMinutes").value = definition.timeoutMinutes || 10;
  $("steps").replaceChildren(...(definition.steps || [{ title: "", agent: "auto", instruction: "", condition: "" }]).map(stepCard));
  renderModels(definition.agentModels);
  scheduleFields(); renumber(); dirty = !selected; renderList(); controls();
}
function editorValue() {
  const type = $("triggerType").value, schedule = { type };
  if (type === "interval") schedule.minutes = Number($("intervalMinutes").value);
  if (["daily", "weekly"].includes(type)) Object.assign(schedule, { time: $("scheduleTime").value, timezone: $("scheduleTimezone").value });
  if (type === "weekly") schedule.weekday = Number($("scheduleDay").value);
  return {
    name: $("workflowName").value, description: $("workflowDescription").value, mode: $("workflowMode").value,
    schedule, timeoutMinutes: Number($("timeoutMinutes").value),
    steps: [...$("steps").children].map(card => Object.fromEntries([...card.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value]))),
    agentModels: Object.fromEntries([...document.querySelectorAll("#modelOverrides select")].filter(input => input.value).map(input => [input.dataset.agent, input.value])),
  };
}
function renderList() {
  $("workflowList").replaceChildren();
  if (!state.definitions.length) $("workflowList").append(node("p", "No workflows yet. Ask Ryan or use a starter template.", "muted"));
  for (const def of [...state.definitions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const button = node("button", null, `workflow-item${selected === def.id ? " selected" : ""}`);
    button.type = "button";
    button.append(node("strong", def.name), node("small", `${def.steps.length} steps · ${def.enabled ? "Enabled" : def.schedule.type === "manual" ? "On demand" : "Paused"}`));
    if (def.nextRunAt) button.append(node("small", `Next: ${new Date(def.nextRunAt).toLocaleString()}`));
    button.addEventListener("click", () => { if (!dirty || confirm("Discard unsaved changes?")) openEditor(def); });
    $("workflowList").append(button);
  }
}
function renderHistory() {
  $("runHistory").replaceChildren();
  if (!state.runs.length) $("runHistory").append(node("p", "Test a saved workflow to see results here.", "muted"));
  for (const run of [...state.runs].reverse().slice(0, 30)) {
    const row = node("article", null, "automation-run"), details = node("div");
    details.append(node("strong", run.name), node("p", `${run.trigger} · ${new Date(run.startedAt).toLocaleString()}${run.revision ? ` · revision ${run.revision}` : ""}`, "muted"));
    if (run.error) details.append(node("p", run.error));
    row.append(details, node("span", run.state, `run-state ${run.state}`));
    const link = node("a", "Open run"); link.href = `/?session=${encodeURIComponent(run.hqSessionId)}`; row.append(link);
    if (run.draftId) {
      const button = node("button", "Review draft"); button.type = "button";
      button.addEventListener("click", () => {
        const def = state.definitions.find(d => d.id === run.draftId);
        if (!def) return error("This draft was deleted.");
        if (!dirty || confirm("Discard unsaved changes?")) openEditor(def);
      }); row.append(button);
    }
    if (run.state === "running") {
      const button = node("button", "Stop"); button.type = "button";
      button.addEventListener("click", () => act(async () => { await api(`/api/automations/${run.id}/stop`, "POST", {}); notice("Stop requested. The run will not be retried automatically."); await refresh(); }));
      row.append(button);
    }
    $("runHistory").append(row);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api("/api/automations");
    if (selected && saved()?.revision !== editorRevision) {
      if (!dirty && saved()) openEditor(saved());
      else notice("This workflow changed in another tab. Reload it from Saved workflows before running or saving.");
    }
    $("schedulerStatus").textContent = state.schedulerError ? `Scheduler paused: ${state.schedulerError}. Resolve the error and restart HQ.` :
      state.schedulerEnabled ? "Scheduler ready. Enabling a tested workflow authorizes recurring read-only model usage." : "Automatic scheduling is disabled on this HQ instance.";
    renderList(); renderHistory(); controls();
    if (buildRunId) {
      const run = state.runs.find(r => r.id === buildRunId);
      if (run && run.state !== "running") {
        buildRunId = null;
        if (run.draftId) {
          notice("Ryan's draft is ready. Review its assumptions and steps, save any edits, then test it.");
          if (!dirty) openEditor(state.definitions.find(d => d.id === run.draftId));
        } else error(run.error || "Builder did not produce a draft.");
      }
    }
  } finally { refreshing = false; }
}
function template(kind) {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const step = (title, agent, instruction) => ({ title, agent, instruction, condition: "" });
  const definitions = {
    morning: { name: "Morning briefing", description: "Read-only briefing. Use my authorized sources; report anything unavailable.", schedule: { type: "daily", time: "08:30", timezone: state.timezone }, steps: [
      step("Today's calendar and inbox", "office-administrator", "Read today's calendar and important unread email from the last 24 hours. Include meeting preparation and explicit action items, with sources."),
      step("Upcoming milestones", "sales-lead", "Read my open MSX milestones due in the next seven days. Summarize owners, dates and blockers; do not modify records."),
      step("Consolidate", "summarizer", "Combine earlier findings into a concise morning briefing with priorities, sources and access limitations. Do not send it anywhere."),
    ] },
    pipeline: { name: "Weekly pipeline review", description: "Review my assigned pipeline; draft findings only.", schedule: { type: "weekly", time: "09:00", weekday: 1, timezone: state.timezone }, steps: [
      step("Review pipeline", "sales-lead", "Read my open opportunities and milestones. Identify stale next steps, date slips and blockers. Cite records and avoid any CRM writes."),
      step("Recommend follow-ups", "account-strategist", "From the prior findings, draft prioritized follow-up actions. Clearly separate sourced facts from recommendations. Save here; do not send."),
    ] },
    blank: {},
  };
  openEditor(definitions[kind]);
}
$("workflowForm").addEventListener("input", change);
$("workflowForm").addEventListener("change", change);
$("triggerType").addEventListener("change", scheduleFields);
$("addStep").addEventListener("click", () => { $("steps").append(stepCard()); renumber(); change(); });
document.querySelectorAll("[data-template]").forEach(button => button.addEventListener("click", () => template(button.dataset.template)));
$("workflowForm").addEventListener("submit", event => {
  event.preventDefault();
  void act(async () => {
    const def = saved();
    const result = await api(def ? `/api/automations/${def.id}` : "/api/automations", def ? "PUT" : "POST", { ...editorValue(), ...(def ? { revision: editorRevision } : {}) });
    await refresh(); openEditor(result); notice("Saved. Test this revision before enabling its schedule.");
  });
});
for (const [id, test] of [["testWorkflow", true], ["runWorkflow", false]]) $(id).addEventListener("click", () => act(async () => {
  const def = saved();
  const run = await api(`/api/automations/${def.id}/run`, "POST", { revision: def.revision, test });
  notice(`${test ? "Read-only test" : "Run"} started. Use Open run in the history below to follow activity${def.mode === "interactive" && !test ? " and respond to approvals" : ""}.`);
  await refresh();
}));
$("toggleSchedule").addEventListener("click", () => act(async () => {
  const def = saved();
  if (!def.enabled && !confirm(`Enable recurring read-only runs for "${def.name}"? Each run consumes model usage while HQ is running.`)) return;
  await api(`/api/automations/${def.id}/enabled`, "POST", { revision: def.revision, enabled: !def.enabled });
  await refresh(); notice(saved().enabled ? "Schedule enabled." : "Schedule paused. An active run continues until you stop it.");
}));
$("deleteWorkflow").addEventListener("click", () => act(async () => {
  const def = saved();
  if (!confirm(`Delete "${def.name}"? Past run conversations will remain.`)) return;
  await api(`/api/automations/${def.id}`, "DELETE", { revision: def.revision });
  selected = null; await refresh(); openEditor(); notice("Workflow deleted. Past conversations are unchanged.");
}));
$("builderForm").addEventListener("submit", event => {
  event.preventDefault();
  void act(async () => {
    const run = await api("/api/automations/build", "POST", { request: $("buildRequest").value });
    buildRunId = run.runId;
    notice("Ryan is designing a draft. Follow its conversation using Open run below.");
    await refresh();
  });
});
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => clearTimeout(pollTimer));
async function poll() {
  try { if (!document.hidden) await refresh(); } catch (e) { error(e.message); }
  pollTimer = setTimeout(poll, 4000);
}
async function init() {
  try {
    [team] = await Promise.all([api("/api/team"), refresh()]);
    openEditor();
    dirty = false; controls();
    try { models = (await api("/api/models")).models; $("modelStatus").textContent = "Blank means the agent's configured default. Models must be enabled for your account."; }
    catch (e) { $("modelStatus").textContent = `Model catalog unavailable: ${e.message}. Default models remain selectable.`; }
    if (!dirty) renderModels(saved()?.agentModels);
    void poll();
  } catch (e) { error(e.message); }
}
void init();
