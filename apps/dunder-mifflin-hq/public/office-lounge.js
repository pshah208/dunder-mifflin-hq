// Dunder Mifflin HQ Office: deterministic break/lounge scheduler (DOM-free, unit-tested in Node).
// Decorative only. A break is never "work": it never marks an agent active, and real work preempts it at once.

// Break Room, Café Disco and water-cooler spots. Coordinates are scene tiles (the same space as HOME in office.js).
export const LOUNGE_BOUNDS = Object.freeze({ x0: 6.0, x1: 22.8, y0: .4, y1: 16.05 });
export const PATH_BAND = Object.freeze({ y0: 5.0, y1: 6.25 }); // warehouse walkway: keep it clear
export const LOUNGE_SPOTS = Object.freeze([
  // Break Room (its own room off the front of the Scranton floor).
  { id: "break-fridge", kind: "counter", zone: "break", x: 7.35, y: 12.2 },
  { id: "break-micro", kind: "counter", zone: "break", x: 7.35, y: 12.95 },
  { id: "break-coffee", kind: "counter", zone: "break", x: 7.35, y: 13.65 },
  { id: "break-vend-snacks", kind: "counter", zone: "break", x: 7.98, y: 12.7 },
  { id: "break-vend-drinks", kind: "counter", zone: "break", x: 8.72, y: 12.7 },
  { id: "break-table-a1", kind: "seat", zone: "break", x: 9.15, y: 13.6 },
  { id: "break-table-a2", kind: "seat", zone: "break", x: 10.25, y: 13.6 },
  { id: "break-table-b1", kind: "seat", zone: "break", x: 9.15, y: 15.3 },
  { id: "break-table-b2", kind: "seat", zone: "break", x: 10.25, y: 15.3 },
  { id: "break-couch-1", kind: "seat", zone: "break", x: 11.85, y: 12.6 },
  { id: "break-couch-2", kind: "seat", zone: "break", x: 12.8, y: 12.6 },
  { id: "break-beanbag", kind: "seat", zone: "break", x: 13.85, y: 13.25 },
  { id: "break-pingpong-w", kind: "pingpong", zone: "break", x: 10.95, y: 15.02 },
  { id: "break-pingpong-e", kind: "pingpong", zone: "break", x: 13.55, y: 15.02 },
  { id: "cafe-espresso-1", kind: "counter", zone: "cafe-disco", x: 12.25, y: 8.05 },
  { id: "cafe-table-1", kind: "seat", zone: "cafe-disco", x: 11.7, y: 9.55 },
  { id: "cafe-table-2", kind: "seat", zone: "cafe-disco", x: 12.75, y: 9.55 },
  { id: "dance-floor", kind: "dance", zone: "cafe-disco", x: 13.7, y: 9.05 },
  { id: "dance-floor-2", kind: "dance", zone: "cafe-disco", x: 14.2, y: 8.55 },
  { id: "water-cooler", kind: "chill", zone: "annex", x: 6.75, y: 7.2 },
  { id: "warehouse-free-throw", kind: "basketball", zone: "court", x: 21.5, y: 2.9 },
  { id: "warehouse-courtside", kind: "court-side", zone: "court", x: 22.55, y: 2.85 },
].map(s => Object.freeze(s)));

// Poses used on a break. Seated ones sink the sim a few pixels so it reads as sitting.
export const SIT_POSES = new Set(["sipping", "snacking", "chill"]); // dancing is done standing
export const BREAK_GLYPHS = {
  shoot: ["🏀", "💥"],
  cheer: ["🏀", "👏"],
  brew: ["☕", "♨️"], pick: ["🥨", "🍫"], sipping: ["☕", "💬"], snacking: ["🥨", "😋"], chill: ["😌", "💬", "🧩"], dance: ["🕺", "✨", "☕"], pingpong: ["🏓", "💥", "😤"],
};
export const BREAK_LINES = {
  shoot: ["One shot, then back to paper.", "Nothing but net. Mostly.", "This is my quarterly jump-shot review."],
  cheer: ["I'm here for the scouting report.", "Let's see that famous jump shot.", "Friendly competition. Very serious commentary."],
  brew: ["Fresh pot in the break room.", "Espresso, Scranton style.", "Coffee before paperwork."],
  pick: ["Pretzel day energy.", "Snack inventory looks healthy.", "One candy bar for morale."],
  chill: ["Five minutes away from the phones.", "Water-cooler summit.", "Just resting my sales voice."],
  dance: ["Tiny dance break.", "Café Disco is open.", "One song, then back to paper."],
  pingpong: ["Best of three. Loser restocks the paper.", "My serve. Don't argue.", "Ping-pong is basically sales with a paddle.", "That one hit the net. Replay."],
};

// A visit is a list of stages. `need` lists acceptable spot kinds; `after` is what the agent carries when leaving the stage.
export const KINDS = Object.freeze({
  basketball: { weight: 3, stages: [
    { need: ["basketball"], pose: "shoot", dur: [12000, 22000] },
  ] },
  hoops: { weight: 5, pair: true,
    stages: [{ need: ["basketball"], pose: "shoot", dur: [24000, 38000] }],
    companionStages: [{ need: ["court-side"], pose: "cheer", dur: [24000, 38000] }],
  },
  coffee: { weight: 5, stages: [
    { need: ["counter"], pose: "brew", dur: [3000, 5000], after: "mug" },
    { need: ["seat", "chill"], pose: "sipping", dur: [10000, 20000] },
  ] },
  snack: { weight: 4, stages: [
    { need: ["counter"], pose: "pick", dur: [2200, 4200], after: "snack" },
    { need: ["seat"], pose: "snacking", dur: [8500, 16000] },
  ] },
  chill: { weight: 3, stages: [
    { need: ["seat", "chill"], pose: "chill", dur: [12000, 24000] },
  ] },
  disco: { weight: 1, stages: [
    { need: ["dance"], pose: "dance", dur: [8000, 14000] },
  ] },
  // A pair kind: only booked for two agents going on break together, who then play each other.
  pingpong: { weight: 6, pair: true, stages: [
    { need: ["pingpong"], pose: "pingpong", dur: [12000, 22000] },
  ] },
});

export const RELATIONSHIPS = Object.freeze({
  "account-strategist|office-administrator": 9,
  "account-strategist|sales-lead": 7,
  "sales-lead|finance-analyst": 8,
  "regional-manager|compliance-officer": -6,
  "regional-manager|sales-lead": 6,
  "regional-manager|office-administrator": 5,
  "communications|product-manager": 7,
  "summarizer|renewals-desk": 4,
  "cloud-ai-architect|finance-analyst": 5,
  "automation-engineer|presentation-designer": 4,
  "relationship-manager|renewals-desk": 6,
  "qa-reviewer|compliance-officer": 3,
});
const relKey = (a, b) => [a, b].sort().join("|");
export const affinity = (a, b, rel = RELATIONSHIPS) => rel[relKey(a, b)] ?? 0;

export class Lounge {
  constructor(o = {}) {
    this.spots = o.spots || LOUNGE_SPOTS;
    this.rng = o.rng || Math.random;
    this.maxOnBreak = o.maxOnBreak ?? 5;
    this.startChance = o.startChance ?? 0.35;
    this.minIdleMs = o.minIdleMs ?? 8000;
    this.cooldownMs = o.cooldownMs || [45000, 120000];
    this.initialDelayMs = o.initialDelayMs || [8000, 45000];
    this.kinds = o.kinds || KINDS;
    this.relationships = o.relationships || RELATIONSHIPS;
    this.enabled = true;
    this.occ = new Map();        // spotId -> agentId (reserved for the agent's whole visit)
    this.visits = new Map();     // agentId -> { kind, stages, spots, idx, endAt, group }
    this.nextOk = new Map();     // agentId -> earliest time a new break may start
    this.idleSince = new Map();  // agentId -> when the agent last became idle
    this.lastVisit = new Map();  // least-recently invited agents get the next outing
  }

  get occupancy() { return new Map(this.occ); }
  get count() { return this.visits.size; }
  onBreak(id) { return this.visits.has(id); }
  _rand([a, b]) { return a + this.rng() * (b - a); }

  _release(id) {
    for (const [spotId, owner] of [...this.occ]) if (owner === id) this.occ.delete(spotId);
    this.visits.delete(id);
  }
  _finish(id, now) { this._release(id); this.nextOk.set(id, now + this._rand(this.cooldownMs)); }

  preempt(id, now = 0) {
    if (!this.visits.has(id)) return false;
    this._finish(id, now);
    this.idleSince.delete(id);
    return true;
  }

  setEnabled(on, now = 0) {
    this.enabled = !!on;
    if (on) return [];
    const ended = [...this.visits.keys()];
    ended.forEach(id => this._finish(id, now));
    return ended;
  }

  _freeSpot(kinds, taken) {
    const free = this.spots.filter(s => kinds.includes(s.kind) && !this.occ.has(s.id) && !taken.has(s.id));
    return free.length ? free[Math.floor(this.rng() * free.length) % free.length] : null;
  }

  // A pair kind needs a companion and a free spot per player for every stage (both ends of the ping-pong table).
  _pairFits(k) {
    if (k.companionStages) return [...k.stages, ...k.companionStages].every(st =>
      this.spots.some(s => st.need.includes(s.kind) && !this.occ.has(s.id)));
    return k.stages.every(st => this.spots.filter(s => st.need.includes(s.kind) && !this.occ.has(s.id)).length >= 2);
  }
  _pickKind({ pair = false } = {}) {
    const entries = Object.entries(this.kinds).filter(([, k]) => !k.pair || (pair && this._pairFits(k)));
    if (!entries.length) return null;
    let r = this.rng() * entries.reduce((n, [, k]) => n + k.weight, 0);
    for (const [name, k] of entries) { r -= k.weight; if (r < 0) return name; }
    return entries[entries.length - 1][0];
  }

  pickCompanion(id, candidates) {
    const pool = candidates.filter(a => a.id !== id && !a.working && !a.walking && !this.visits.has(a.id));
    if (!pool.length) return null;
    const weighted = pool.map(a => ({ a, w: Math.max(0.2, 1 + affinity(id, a.id, this.relationships) / 3) }));
    let r = this.rng() * weighted.reduce((n, x) => n + x.w, 0);
    for (const x of weighted) { r -= x.w; if (r <= 0) return x.a; }
    return weighted[weighted.length - 1].a;
  }

  tick(now, agents) {
    const cmds = [];
    const byId = new Map(agents.map(a => [a.id, a]));
    for (const a of agents) {
      if (!this.nextOk.has(a.id)) this.nextOk.set(a.id, now + this._rand(this.initialDelayMs));
      if (a.working) {
        this.idleSince.delete(a.id);
        if (this.visits.has(a.id)) { this._finish(a.id, now); cmds.push({ type: "end", id: a.id, reason: "working" }); }
      } else if (!this.idleSince.has(a.id)) this.idleSince.set(a.id, now);
    }
    if (!this.enabled) {
      for (const id of [...this.visits.keys()]) { this._finish(id, now); cmds.push({ type: "end", id, reason: "disabled" }); }
      return cmds;
    }

    for (const [id, v] of [...this.visits]) {
      const a = byId.get(id);
      if (!a) { this._release(id); continue; }
      if (v.endAt == null) { if (!a.walking) v.endAt = now + this._rand(v.stages[v.idx].dur); continue; }
      if (now < v.endAt) continue;
      if (v.idx + 1 < v.stages.length) {
        const prev = v.stages[v.idx];
        this.occ.delete(v.spots[v.idx].id);
        v.idx += 1; v.endAt = null;
        cmds.push({ type: "go", id, spot: v.spots[v.idx], pose: v.stages[v.idx].pose, carry: prev.after || null, stage: v.idx, group: v.group || null });
      } else { this._finish(id, now); cmds.push({ type: "end", id, reason: "done" }); }
    }

    const candidates = agents.filter(a => !a.working && !a.walking && !this.visits.has(a.id) &&
      now >= (this.nextOk.get(a.id) ?? Infinity) && now - (this.idleSince.get(a.id) ?? now) >= this.minIdleMs);
    const overdue = candidates.some(a => now - this.nextOk.get(a.id) >= 15000);
    if (this.visits.size < this.maxOnBreak && (this.rng() < this.startChance || overdue)) {
      if (candidates.length) {
        const oldest = Math.min(...candidates.map(a => this.lastVisit.get(a.id) ?? -Infinity));
        const waiting = candidates.filter(a => (this.lastVisit.get(a.id) ?? -Infinity) === oldest);
        const a = waiting[Math.floor(this.rng() * waiting.length) % waiting.length];
        const companion = this.visits.size + 1 < this.maxOnBreak && this.rng() < 0.42 ? this.pickCompanion(a.id, candidates) : null;
        const group = companion ? [a.id, companion.id].sort().join("+") : null;
        let pairKind = null;
        for (const actor of [a, companion].filter(Boolean)) {
          if (this.visits.size >= this.maxOnBreak || this.visits.has(actor.id)) continue;
          // The companion joins a pair activity (ping-pong); otherwise each picks their own.
          const kind = pairKind || this._pickKind({ pair: !!companion && actor === a });
          if (!kind) continue;
          const stages = (actor === companion && this.kinds[kind].companionStages) || this.kinds[kind].stages;
          const taken = new Set(), spots = [];
          for (const st of stages) { const s = this._freeSpot(st.need, taken); if (!s) break; spots.push(s); taken.add(s.id); }
          if (spots.length === stages.length) {
            if (actor === a && this.kinds[kind].pair) pairKind = kind;
            spots.forEach(s => this.occ.set(s.id, actor.id));
            this.visits.set(actor.id, { kind, stages, spots, idx: 0, endAt: null, group });
            this.lastVisit.set(actor.id, now);
            cmds.push({ type: "go", id: actor.id, spot: spots[0], pose: stages[0].pose, carry: null, stage: 0, group });
          }
        }
      }
    }
    return cmds;
  }
}

export const BANTER_SOLO = Object.freeze({
  "regional-manager": ["I am casually available for friendship.", "This coffee has leadership potential."],
  "sales-lead": ["Paper readiness remains high.", "I can defend this vending machine if needed."],
  "account-strategist": ["Tiny prank window. Very tempting.", "Nice break. Suspiciously productive."],
  "office-administrator": ["Reception is holding together.", "I drew a tiny teapot on this cup."],
  "finance-analyst": ["Please label your leftovers.", "This snack requires a receipt."],
  "renewals-desk": ["Wake me for pretzel day.", "My crossword has better margins than this deal."],
  "relationship-manager": ["A sweet snack helps everyone be nicer.", "I brought napkins, just in case."],
  "communications": ["Okay, but who told who first?", "This is technically internal communications."],
  "summarizer": ["I saved room for chili. Always.", "If anyone asks, this is research."],
  "cloud-ai-architect": ["Actually, that machine has a small queueing problem.", "The database of snacks is under-normalized."],
  "product-manager": ["This break could scale.", "Imagine a social network for break rooms."],
  "automation-engineer": ["Warehouse is calm today.", "A steady beat helps the shift."],
  "presentation-designer": ["I can harmonize with the microwave.", "This room has acoustics."],
  "qa-reviewer": ["I found a flaw. Might be lunch.", "Quality is a mysterious journey."],
  "compliance-officer": ["Please keep the walkway clear.", "I am also here. That's okay."],
});
const REPLIES = Object.freeze({
  "regional-manager": ["Great talk. Best one today."], "sales-lead": ["Fact accepted."], "account-strategist": ["Noted, and harmlessly filed."],
  "office-administrator": ["That's actually sweet."], "finance-analyst": ["I will allow one smile."], "renewals-desk": ["If this is quick."],
  "relationship-manager": ["Oh, that's nice."], "communications": ["Wait, say that again."], "summarizer": ["Nice. Also hungry."],
  "cloud-ai-architect": ["Actually, yes."], "product-manager": ["Strong concept."], "automation-engineer": ["Sounds good."],
  "presentation-designer": ["Yes, and in song."], "qa-reviewer": ["Could be true."], "compliance-officer": ["Thank you for including me."],
});
const GENERIC_REPLIES = Object.freeze(["Ha, fair.", "Same here.", "Good call.", "☕"]);

// Original, friendly court chatter; never copied dialogue from the show.
export const COURT_BANTER = Object.freeze({
  "regional-manager": ["That shot was a leadership exercise. The basket needs coaching.", "I call this move the regional layup."],
  "sales-lead": ["I calculated your shooting percentage. You should sit down for this.", "The rim has not passed my inspection."],
  "account-strategist": ["Interesting strategy, keeping the scoreboard completely relaxed.", "Dwight brought a scouting binder. I brought sneakers."],
  "office-administrator": ["I can sketch where the ball was supposed to go.", "Your follow-through needs fewer meetings."],
  "finance-analyst": ["That miss is not reimbursable.", "Your confidence exceeds the approved budget."],
  "renewals-desk": ["Make the shot. My crossword is waiting.", "I came for basketball, not a quarterly presentation."],
  "relationship-manager": ["Lovely effort. The basket is just being difficult.", "I knitted a warmer for that cold shooting streak."],
  "communications": ["The sneakers are winning. The score is another story.", "I am giving this game a very honest review."],
  "summarizer": ["My scouting report says we need snacks.", "If rebounds were chili, I'd have a full pot."],
  "cloud-ai-architect": ["Your shot has impressive latency.", "The trajectory needs a small architecture review."],
  "product-manager": ["We're calling that miss an early-access feature.", "I'm pivoting from baskets to audience engagement."],
  "automation-engineer": ["Less commentary, more knees in that jump shot.", "Warehouse rules: you miss it, you fetch it."],
  "presentation-designer": ["That airball needs a dramatic soundtrack.", "I have prepared a victory harmony. Whenever you're ready."],
  "qa-reviewer": ["I tested the basket. It works when the ball goes in.", "That bounce looked suspicious. I'll investigate."],
  "compliance-officer": ["Friendly reminder: confidence is not a point.", "Trash talk is fine. Please recycle the actual trash."],
});
export const COURT_REPLIES = Object.freeze([
  "Keep the commentary warm. I'm lining up the next one.",
  "That was a practice miss. Very technical.",
  "Big scouting report from someone standing on the sideline.",
  "Loser restocks the paper. Suddenly this matters.",
]);

export class Banter {
  constructor({ lounge, rng = Math.random, gapMs = [12000, 26000], agentCooldownMs = 55000, pairBias = 0.75, solo = BANTER_SOLO, replies = REPLIES, relationships = RELATIONSHIPS } = {}) {
    Object.assign(this, { lounge, rng, gapMs, agentCooldownMs, pairBias, solo, replies, relationships });
    this.nextAt = 0; this.last = new Map(); this.pending = null;
  }
  _rand([a, b]) { return a + this.rng() * (b - a); }
  residents(agents) { return agents.filter(a => !a.working && !a.walking && this.lounge.onBreak(a.id)); }
  zone(id) {
    const spotId = [...this.lounge.occupancy].find(([, owner]) => owner === id)?.[0];
    return this.lounge.spots.find(s => s.id === spotId)?.zone;
  }
  _pickPartner(id, partners) {
    const weighted = partners.map(p => ({ id: p, w: Math.max(0.2, 1 + affinity(id, p, this.relationships) / 3) }));
    let r = this.rng() * weighted.reduce((n, x) => n + x.w, 0);
    for (const x of weighted) { r -= x.w; if (r <= 0) return x.id; }
    return weighted[weighted.length - 1]?.id;
  }
  tick(now, agents) {
    const here = new Map(this.residents(agents).map(a => [a.id, a]));
    const out = [];
    if (this.pending) {
      const p = this.pending;
      if (!here.has(p.from) || !here.has(p.to) || (p.court && (this.zone(p.from) !== "court" || this.zone(p.to) !== "court"))) this.pending = null;
      else if (now >= p.dueAt) {
        const pool = p.court ? COURT_REPLIES : (this.replies[p.to] || GENERIC_REPLIES);
        out.push({ id: p.to, text: pool[Math.floor(this.rng() * pool.length)], ms: 2600, pair: true });
        this.last.set(p.to, now); this.pending = null;
      }
      return out;
    }
    if (!this.nextAt) this.nextAt = now + (this.residents(agents).some(a => this.zone(a.id) === "court") ? 2500 : this._rand(this.gapMs));
    if (now < this.nextAt) return out;
    const ready = [...here.keys()].filter(id => now - (this.last.get(id) ?? -Infinity) >= this.agentCooldownMs);
    if (!ready.length) return out;
    const pick = list => list[Math.floor(this.rng() * list.length)];
    const courtReady = ready.filter(id => this.zone(id) === "court");
    const id = pick(courtReady.length ? courtReady : ready);
    const court = this.zone(id) === "court";
    const partners = [...here.keys()].filter(o => o !== id && (court ? this.zone(o) === "court" : this.zone(o) !== "court"));
    const wantPair = partners.length && this.rng() < this.pairBias;
    const pool = court ? COURT_BANTER[id] : this.solo[id]; if (!pool) { this.nextAt = now + this._rand(this.gapMs); return out; }
    out.push({ id, text: pick(pool), ms: 3000, pair: !!wantPair });
    this.last.set(id, now);
    if (wantPair) this.pending = { from: id, to: this._pickPartner(id, partners), dueAt: now + 3500, court };
    this.nextAt = now + this._rand(this.gapMs);
    return out;
  }
  reset() { this.pending = null; }
}
