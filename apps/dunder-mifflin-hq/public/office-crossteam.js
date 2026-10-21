// Dunder Mifflin HQ Office: cross-team dynamics (DOM-free, unit-tested in Node).
// Scranton Branch sales/domain experts and Dunder Mifflin Infinity engineers share the Office.
// This module owns team membership, original persona line pools and the pure scene-selection logic.

export const MICHAEL = "regional-manager";
export const LINE_CHARS = 70;

export const SALES_IDS = Object.freeze(["regional-manager", "sales-lead", "account-strategist", "office-administrator", "finance-analyst",
  "renewals-desk", "relationship-manager", "communications", "summarizer"]);
export const ENGINEERING_IDS = Object.freeze(["cloud-ai-architect", "product-manager", "automation-engineer", "presentation-designer"]);
export const REVIEW_IDS = Object.freeze(["qa-reviewer", "compliance-officer"]);

const SALES = new Set(SALES_IDS), ENG = new Set(ENGINEERING_IDS), REVIEW = new Set(REVIEW_IDS);
export const teamOf = id => (ENG.has(id) ? "engineering" : SALES.has(id) ? "sales" : REVIEW.has(id) ? "review" : null);

const pick = (arr, rng = Math.random) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
const clip = (t, n = LINE_CHARS) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export const MICHAEL_GREETINGS = Object.freeze([
  "Warehouse team! I come bearing strategy and vibes.",
  "Infinity needs paper people and tech people. I am both emotionally.",
  "Quick huddle. Nobody panic unless I start using a marker.",
  "I walked all the way here because this is important and dramatic.",
  "Scranton and Infinity, assemble near the least dangerous forklift.",
]);
export const ENGINEERING_REPLIES = Object.freeze({
  "cloud-ai-architect": ["Actually, the architecture is already safer over here.", "Bring the requirements; leave the assumptions."],
  "product-manager": ["This could be the next big workplace platform.", "I can make that sound investable."],
  "automation-engineer": ["Forklift is parked. Whiteboard is free.", "Tell me what needs moving; physical or digital."],
  "presentation-designer": ["I can pitch it with three slides and a high note.", "Warehouse acoustics are underrated."],
});
export const ENGINEERING_WORK_LINES = Object.freeze({
  "cloud-ai-architect": ["Actually, the data model needs one more constraint.", "Azure side is clean if we keep secrets out."],
  "product-manager": ["Infinity should feel effortless, not just online.", "Let's define launch before the launch defines us."],
  "automation-engineer": ["I can automate the handoff and label the boxes.", "If it repeats twice, a script can carry it."],
  "presentation-designer": ["This slide needs drama, but business drama.", "I hear a short opener and a strong close."],
});
export const SALES_QUIPS = Object.freeze({
  "regional-manager": ["Make it friendly. People buy from friends.", "I can brief everyone. Probably twice."],
  "sales-lead": ["Sales protocol remains undefeated.", "The customer will respect decisive paper."],
  "account-strategist": ["Can we make it useful and mildly funny?", "I'll ask the customer what they actually need."],
  "office-administrator": ["I'll make sure the forms don't scare people.", "Reception can translate that into human words."],
  "finance-analyst": ["No discount without a reason.", "Please put the margin in a real cell."],
  "renewals-desk": ["If it renews itself, wake me.", "Keep it simple. Customers like naps too."],
  "relationship-manager": ["A personal note would help here.", "Let's keep the customer feeling looked after."],
  "communications": ["The announcement needs less spreadsheet, more sparkle.", "I can make everyone hear about it by lunch."],
  "summarizer": ["I'll keep the summary short. Maybe.", "Can the snack budget be a line item?"],
});
export const PAIR_BANTER = Object.freeze([
  { sales: "account-strategist", engineering: "product-manager", lines: ["Customers want less buzz and more working buttons.", "Working buttons can still have a brand story."] },
  { sales: "sales-lead", engineering: "cloud-ai-architect", lines: ["Security must be intense and visible.", "Actually, invisible security is usually better."] },
  { sales: "office-administrator", engineering: "automation-engineer", lines: ["Can it stop jamming the printer queue?", "Printer jams are a worthy opponent."] },
  { sales: "finance-analyst", engineering: "product-manager", lines: ["I need a number before I need a slogan.", "What if the number is part of the slogan?" ] },
  { sales: "communications", engineering: "presentation-designer", lines: ["Make it exciting but not weird.", "I can do exciting-adjacent." ] },
  { sales: "summarizer", engineering: "automation-engineer", lines: ["If it moves boxes, does it move chili?", "Only in a sealed container." ] },
  { sales: "regional-manager", engineering: "cloud-ai-architect", lines: ["Can the cloud be more personable?", "Actually, no. But the UI can." ] },
  { sales: "relationship-manager", engineering: "presentation-designer", lines: ["A warm close would be lovely.", "I have just the chord progression." ] },
]);
export const HANDOFF_LINES = Object.freeze({
  "cloud-ai-architect": ["Michael, the architecture is ready and technically defensible.", "I left notes before anyone could misinterpret the schema."],
  "product-manager": ["Michael, the Infinity angle is packaged.", "I drafted the launch story without overpromising too much."],
  "automation-engineer": ["Michael, the workflow is moving clean.", "Done. Warehouse and app both have a path."],
  "presentation-designer": ["Michael, the deck has shape and a tasteful crescendo.", "Done. I removed the fourth musical metaphor."],
});

export function pickScene(working) {
  const ids = [...new Set(working || [])];
  const engineering = ids.filter(id => ENG.has(id));
  const sales = ids.filter(id => SALES.has(id) && id !== MICHAEL);
  if (!engineering.length) return { kind: "none", engineering: [], sales };
  return { kind: sales.length ? "mixed" : "engineering", engineering, sales };
}

export function pickGreeting(engineeringIds, rng = Math.random) {
  const ids = (engineeringIds || []).filter(id => ENG.has(id));
  if (!ids.length) return [];
  const who = pick(ids, rng);
  return [{ id: MICHAEL, text: clip(pick(MICHAEL_GREETINGS, rng)) }, { id: who, text: clip(pick(ENGINEERING_REPLIES[who], rng)) }];
}

export function pickHuddleLine(engineeringIds, lastId = null, rng = Math.random) {
  const ids = (engineeringIds || []).filter(id => ENG.has(id));
  if (!ids.length) return null;
  const pool = ids.length > 1 ? ids.filter(id => id !== lastId) : ids;
  const id = pick(pool, rng);
  return { id, text: clip(pick(ENGINEERING_WORK_LINES[id], rng)) };
}

export function pickPair(salesIds, engineeringIds, rng = Math.random, lastKey = "") {
  const sales = (salesIds || []).filter(id => SALES.has(id) && id !== MICHAEL), engineering = (engineeringIds || []).filter(id => ENG.has(id));
  if (!sales.length || !engineering.length) return null;
  const known = PAIR_BANTER.filter(p => sales.includes(p.sales) && engineering.includes(p.engineering) && `${p.sales}|${p.engineering}` !== lastKey);
  if (known.length) { const p = pick(known, rng); return [{ id: p.sales, text: clip(p.lines[0]) }, { id: p.engineering, text: clip(p.lines[1]) }]; }
  const a = pick(sales, rng), b = pick(engineering, rng);
  return [{ id: a, text: clip(pick(SALES_QUIPS[a] || ["Interesting."], rng)) }, { id: b, text: clip(pick(ENGINEERING_WORK_LINES[b], rng)) }];
}
export const pairKey = pair => (pair ? `${pair[0].id}|${pair[1].id}` : "");

export function pickHandoff(engineeringId, rng = Math.random) {
  const pool = HANDOFF_LINES[engineeringId];
  return pool ? clip(pick(pool, rng)) : null;
}
