// Per-tab visual state only. Live work is always rebuilt from the server stream.
export const OFFICE_STATE_KEY = "dm-office-scene-v1";
const SIM_FIELDS = ["x", "y", "path", "pose", "nextPose", "target", "facing", "carry",
  "bubbleUntil", "sceneBubble", "anticBubble"];
const LOUNGE_MAPS = ["occ", "visits", "nextOk", "idleSince", "lastVisit"];

export function captureOffice({ sims, lounge, scene, antic, antics, banter }, now) {
  return JSON.parse(JSON.stringify({
    version: 1, now,
    sims: [...sims].map(([id, s]) => [id, {
      ...Object.fromEntries(SIM_FIELDS.map(key => [key, s[key]])), bubbleText: s.bubble.textContent,
    }]),
    lounge: { ...Object.fromEntries(LOUNGE_MAPS.map(key => [key, [...lounge[key]]])), maxOnBreak: lounge.maxOnBreak },
    scene, antic,
    antics: { nextAt: antics.nextAt, recent: antics.recent },
    banter: { nextAt: banter.nextAt, last: [...banter.last], pending: banter.pending },
  }));
}

export function restoreOffice(saved, { sims, lounge, antics, banter }, now) {
  const fail = () => { throw new Error("Invalid saved Office scene"); };
  if (saved?.version !== 1 || !Number.isFinite(saved.now) || !Array.isArray(saved.sims) ||
      saved.sims.length !== sims.size || new Set(saved.sims.map(([id]) => id)).size !== sims.size) fail();
  const point = p => Array.isArray(p) && p.length === 2 &&
    p.every(Number.isFinite) && p[0] >= 0 && p[0] <= 25.2 && p[1] >= 0 && p[1] <= 16.3;
  for (const [id, s] of saved.sims) {
    if (!sims.has(id) || !point([s.x, s.y]) || !Array.isArray(s.path) || !s.path.every(point) ||
        typeof s.pose !== "string" || typeof s.bubbleText !== "string" || !Number.isFinite(s.bubbleUntil)) fail();
  }
  for (const key of LOUNGE_MAPS) if (!Array.isArray(saved.lounge?.[key])) fail();
  const spots = new Map(lounge.spots.map(s => [s.id, s]));
  const occupancy = new Map();
  for (const [id, visit] of saved.lounge.visits) {
    if (!sims.has(id) || !Array.isArray(visit.stages) || !Array.isArray(visit.spots) ||
        !Number.isInteger(visit.idx) || !visit.stages[visit.idx] || !visit.spots[visit.idx] ||
        visit.stages.length !== visit.spots.length ||
        !visit.stages.every(s => typeof s.pose === "string" && Array.isArray(s.dur) && s.dur.length === 2 && s.dur.every(Number.isFinite)) ||
        !visit.spots.every(s => spots.has(s.id)) || (visit.endAt !== null && !Number.isFinite(visit.endAt))) fail();
    for (const spot of visit.spots.slice(visit.idx)) {
      if (occupancy.has(spot.id)) fail();
      occupancy.set(spot.id, id);
    }
  }
  for (const key of ["nextOk", "idleSince", "lastVisit"]) {
    if (!saved.lounge[key].every(([id, t]) => sims.has(id) && Number.isFinite(t))) fail();
  }
  if (!Number.isFinite(saved.lounge.maxOnBreak) || !Array.isArray(saved.antics?.recent) ||
      !Number.isFinite(saved.antics.nextAt) || !Array.isArray(saved.banter?.last) ||
      !Number.isFinite(saved.banter.nextAt) ||
      !saved.banter.last.every(([id, t]) => sims.has(id) && Number.isFinite(t))) fail();
  if (saved.banter.pending && (!sims.has(saved.banter.pending.from) || !sims.has(saved.banter.pending.to) ||
      !Number.isFinite(saved.banter.pending.dueAt))) fail();
  const stepsValid = steps => Array.isArray(steps) && steps.every(s => Number.isFinite(s.at) &&
    Number.isFinite(s.ms) && (!s.id || sims.has(s.id)) && (s.text == null || typeof s.text === "string"));
  if (saved.scene && (!Array.isArray(saved.scene.ids) || !saved.scene.ids.every(id => sims.has(id)) ||
      !["gather", "talk"].includes(saved.scene.phase) || !Array.isArray(saved.scene.lines) ||
      !["clock", "talkAt", "next", "endAt", "maxOnBreak"].every(key => Number.isFinite(saved.scene[key])) ||
      (saved.scene.steps !== null && !stepsValid(saved.scene.steps)))) fail();
  if (saved.antic && (!Array.isArray(saved.antic.bit?.cast) || !saved.antic.bit.cast.every(id => sims.has(id)) ||
      !stepsValid(saved.antic.steps) || !["startedAt", "next", "total"].every(key => Number.isFinite(saved.antic[key])) ||
      (saved.antic.t0 !== null && !Number.isFinite(saved.antic.t0)))) fail();

  // performance.now() belongs to one document. Rebase deadlines so navigation pauses
  // decorative scenes rather than expiring breaks or teleporting through missed frames.
  const delta = now - saved.now;
  const shift = t => t == null ? t : t + delta;
  for (const [id, data] of saved.sims) {
    const s = sims.get(id);
    for (const key of SIM_FIELDS) s[key] = data[key];
    s.bubbleUntil = data.bubbleUntil ? shift(data.bubbleUntil) : 0;
    s.bubble.textContent = data.bubbleText;
    s.bubble.classList.toggle("show", s.bubbleUntil > now);
  }
  for (const key of LOUNGE_MAPS) lounge[key] = new Map(saved.lounge[key]);
  lounge.occ = occupancy;
  for (const key of ["nextOk", "idleSince", "lastVisit"]) lounge[key] = new Map([...lounge[key]].map(([id, t]) => [id, shift(t)]));
  for (const visit of lounge.visits.values()) {
    visit.endAt = shift(visit.endAt);
    visit.spots = visit.spots.map(s => spots.get(s.id));
  }
  lounge.maxOnBreak = saved.lounge.maxOnBreak;
  Object.assign(antics, saved.antics, { nextAt: saved.antics.nextAt ? shift(saved.antics.nextAt) : 0 });
  Object.assign(banter, saved.banter, {
    last: new Map(saved.banter.last.map(([id, t]) => [id, shift(t)])),
    nextAt: saved.banter.nextAt ? shift(saved.banter.nextAt) : 0,
    pending: saved.banter.pending ? { ...saved.banter.pending, dueAt: shift(saved.banter.pending.dueAt) } : null,
  });
  const scene = saved.scene ? { ...saved.scene, last: now } : null;
  const antic = saved.antic ? { ...saved.antic, t0: shift(saved.antic.t0), startedAt: shift(saved.antic.startedAt) } : null;
  return { scene, antic };
}
