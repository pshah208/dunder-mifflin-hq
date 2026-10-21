export const SPEEDS = Object.freeze(["quick", "auto", "team"]);
export const QUICK_LEAD_MODELS = Object.freeze(["claude-sonnet-5.5", "gpt-5.4-mini", "claude-haiku-5.5"]);

export function quickLeadModel(details, hasImages = false) {
  return QUICK_LEAD_MODELS.find(id => details.some(m => m.id === id
    && (!m.policy || m.policy.state === "enabled")
    && (!hasImages || m.capabilities?.supports?.vision === true))) || null;
}

export function orchestrationBlock(speed = "auto") {
  const lines = [
    "[ORCHESTRATION & SPEED]",
    `SPEED: ${speed.toUpperCase()}`,
    "You are Michael Scott. This request's speed lane overrides routine delegation and reporting defaults, not safety or permissions.",
    "All lanes retain user approvals, Toby/Creed reviews when required, data-source constraints, freshness and verification. Browser-only requests never become DAX/API queries.",
  ];
  const quick = "Answer directly with no routine task delegation. Use only necessary tools; batch independent calls. Skip routine learning files, LEARNINGS blocks, planning tables and ceremonial meetings. Lead with the answer and stop once supported.";
  const team = "Delegate outcomes to the 1-3 most relevant specialists, one owner per outcome, with complete context and acceptance criteria. Issue independent task calls together, not serially. Avoid manager-to-sub-lead-to-specialist relays and duplicate investigation. Wait for their results, then give one concise synthesis. Escalate only genuine gaps; do not rerun the same work.";
  if (speed === "quick") lines.push(quick, "If a mandatory review or requested specialist is necessary, use only that specialist and explain briefly; never bypass a review to stay fast.");
  else if (speed === "team") lines.push(team, "Use the established Office routing table. Explicit brainstorms retain the conference-room workflow.");
  else lines.push(
    "Triage silently. Handle greetings, status checks, follow-ups, small edits and bounded read-only lookups directly.",
    quick,
    "Use a specialist for domain judgment, multi-step analysis or implementation; use a team only for independent outcomes or requested discussions.",
    team,
    "Prefer the smallest sufficient route. Power BI report controls still go to Angela; serialized browser work is not parallelizable.",
  );
  return [...lines, "[/ORCHESTRATION & SPEED]"].join("\n");
}
