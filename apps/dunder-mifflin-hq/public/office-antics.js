// Dunder Mifflin HQ Office: idle "antics" — short, show-style bits between agents who aren't working
// (pranks, desk visits, talking-head asides to the camera). DOM-free and deterministic with an injected rng.
// Decorative only: bubbles and a short walk, never "work", never chat/history. All lines are original text
// written in the characters' spirit; nothing is quoted from the show's scripts.

export const CAMERA = "🎥 "; // a talking-head aside, rendered as a dark "to camera" bubble

const M = "regional-manager", DW = "sales-lead", JIM = "account-strategist", PAM = "office-administrator", ANG = "finance-analyst",
  STAN = "renewals-desk", PHY = "relationship-manager", KEL = "communications", KEV = "summarizer", OSC = "cloud-ai-architect",
  RYAN = "product-manager", DAR = "automation-engineer", ANDY = "presentation-designer", CREED = "qa-reviewer", TOBY = "compliance-officer";

// visit: [visitor, host] — the visitor walks over to the host's desk before the bit starts.
// emoji: floats above the first cast member's head when the bit starts. feed: optional one-line feed note.
export const ANTICS = Object.freeze([
  { id: "stapler-jello", cast: [DW, JIM, PAM], emoji: "🖇️", feed: "Jim pranked Dwight. Again.", lines: [
    [DW, "Why is my stapler suspended in gelatin?"], [JIM, "Gelatin? Sounds like a security breach, Dwight."], [DW, "I am opening a formal investigation."], [PAM, "🤭"]] },
  { id: "pencil-border", cast: [DW, JIM], lines: [
    [DW, "Jim, your pencil has crossed the desk border."], [JIM, "It's seeking asylum."], [DW, "Request denied."]] },
  { id: "jim-camera", cast: [JIM, DW], lines: [
    [DW, "I have memorised every fire exit and two secret ones."], [JIM, CAMERA + "😐"]] },
  { id: "vending-phone", cast: [JIM, PAM], visit: [JIM, PAM], lines: [
    [JIM, "Want to see Dwight find his phone in the vending machine?"], [PAM, "Hold on, getting my sketchbook."], [JIM, "B4. Right next to the pretzels."]] },
  { id: "pam-teapot", cast: [PAM, JIM], lines: [
    [PAM, "I drew a tiny teapot on your sticky note."], [JIM, "Best sticky note in Pennsylvania."]] },
  { id: "best-boss-mug", cast: [M], lines: [
    [M, CAMERA + "Am I a great boss? The mug says yes, and mugs don't lie."]] },
  { id: "toby-visit", cast: [M, TOBY], visit: [M, TOBY], lines: [
    [M, "Toby. I came all the way over here to say… nothing. Bye."], [TOBY, "Okay. Thanks for stopping by."], [TOBY, CAMERA + "That was one of the nicer ones."]] },
  { id: "suggestion-box", cast: [TOBY, M], lines: [
    [TOBY, "Reminder: the HR suggestion box is open."], [M, "And now it's closed. Meeting adjourned."]] },
  { id: "fire-drill", cast: [DW, M], visit: [DW, M], lines: [
    [DW, "Michael, I've prepared a forty-step safety drill."], [M, "Love the passion. Hate the smoke."], [DW, "There's barely any smoke."]] },
  { id: "dundies", cast: [M, STAN], visit: [M, STAN], lines: [
    [M, "Dundie nominations are open! Category: best at being here."], [STAN, "I'll accept by mail."]] },
  { id: "team-spirit", cast: [M, STAN], lines: [
    [STAN, "If this isn't about pretzels, I'm busy."], [M, "It's about team spirit!"], [STAN, "Then I'm very busy."]] },
  { id: "glass-door", cast: [M, KEV], visit: [M, KEV], lines: [
    [M, "Kevin, my door is always open."], [KEV, "It's glass."], [M, "Metaphorically open, Kevin."]] },
  { id: "chili", cast: [KEV], emoji: "🌶️", lines: [
    [KEV, CAMERA + "My best talent is chili. Second best: eating chili."]] },
  { id: "crumbs", cast: [ANG, KEV], lines: [
    [ANG, "Kevin, your crumbs are on my side of the desk."], [KEV, "They're just visiting."], [ANG, "Evict them."]] },
  { id: "snack-budget", cast: [KEV, ANG], lines: [
    [KEV, "I rounded the snack budget."], [ANG, "To what?"], [KEV, "To lunch."]] },
  { id: "actually-fewer", cast: [OSC, KEV], lines: [
    [OSC, "Actually, it's 'fewer snacks', not 'less snacks'."], [KEV, "Less words. Same snacks."]] },
  { id: "merged-cells", cast: [OSC, ANG], lines: [
    [OSC, "Angela, your spreadsheet has merged cells."], [ANG, "I merge nothing. They merged themselves."], [OSC, CAMERA + "She merged them."]] },
  { id: "cats", cast: [ANG, OSC], lines: [
    [ANG, "My cats would never miss a deadline."], [OSC, "Actually, cats don't have deadlines."], [ANG, "Mine do."]] },
  { id: "inventory", cast: [ANG, DW, PAM], lines: [
    [ANG, "Dwight. Warehouse. For… inventory."], [DW, "Inventory. Yes. Very official."], [PAM, CAMERA + "They think nobody knows."]] },
  { id: "fridge", cast: [PHY, DW], lines: [
    [PHY, "My husband says hi. And that you should buy a fridge."], [DW, "My refrigeration needs are met by the earth."]] },
  { id: "scarf", cast: [PHY, M], visit: [M, PHY], lines: [
    [PHY, "I'm knitting you a scarf, Michael."], [M, "For me? Is it in team colours?"], [PHY, "It's beige."]] },
  { id: "ditty", cast: [ANDY, JIM], emoji: "🎶", lines: [
    [ANDY, "🎶 Here's a little song about paper…"], [JIM, "Andy, it's nine a.m."], [ANDY, "Perfect time for an a cappella warm-up!"]] },
  { id: "alma-mater", cast: [ANDY, OSC], lines: [
    [ANDY, "Fun fact about my alma mater, Cornell—"], [OSC, "We know, Andy. We all know."]] },
  { id: "rivalry", cast: [DW, ANDY], lines: [
    [DW, "Andy, you are not the number two here."], [ANDY, "Neither are you, buddy."], [DW, "I'm number two and a half."]] },
  { id: "big-news", cast: [KEL, PAM], visit: [KEL, PAM], lines: [
    [KEL, "Okay so I have the BIGGEST news."], [PAM, "Is it about Ryan?"], [KEL, "It's always about Ryan."]] },
  { id: "ryan-break", cast: [RYAN, KEL], lines: [
    [KEL, "Ryan, you didn't text me back for eleven minutes!"], [RYAN, CAMERA + "I'm on a break. From everything."]] },
  { id: "fax-app", cast: [RYAN, DAR], visit: [RYAN, DAR], lines: [
    [RYAN, "Imagine an app that texts your fax machine."], [DAR, "Imagine me not listening."]] },
  { id: "protege", cast: [M, RYAN], lines: [
    [M, "Ryan, my protégé!"], [RYAN, "I'm a consultant now."], [M, "Of protégés."]] },
  { id: "warehouse-groove", cast: [DAR, ANDY], emoji: "🎹", lines: [
    [DAR, "Working on a little warehouse groove."], [ANDY, "Can I add a harmony?"], [DAR, "No."]] },
  { id: "street-wisdom", cast: [M, DAR], visit: [M, DAR], lines: [
    [M, "Darryl! Teach me something street."], [DAR, "Lift with your legs."], [M, CAMERA + "Wisdom. Pure wisdom."]] },
  { id: "creed-camera", cast: [CREED], lines: [
    [CREED, CAMERA + "Nobody knows what I do here. That includes me."]] },
  { id: "mung-beans", cast: [CREED, KEV], lines: [
    [CREED, "I sprout beans in my desk drawer. Want some?"], [KEV, "…How long have they been in there?"], [CREED, "Define 'long'."]] },
  { id: "which-oscar", cast: [CREED, OSC], visit: [CREED, OSC], lines: [
    [CREED, "Which one of you is Oscar?"], [OSC, "It's just me. We've sat near each other for years."], [CREED, "Good to finally meet you."]] },
  { id: "creed-title", cast: [CREED, M], lines: [
    [CREED, "Michael, remind me what my title is?"], [M, "Quality… Assurance."], [CREED, "Assured."]] },
  { id: "who-are-you", cast: [CREED, TOBY], lines: [
    [CREED, "Hey, new guy. What's your name?"], [TOBY, "It's Toby. I've been here longer than the carpet."]] },
  { id: "stanley-crossword", cast: [STAN, PHY], lines: [
    [PHY, "Seven letters, 'rest period'?"], [STAN, "Weekend. And it can't come soon enough."]] },
  { id: "kelly-camera", cast: [KEL], lines: [
    [KEL, CAMERA + "I'm basically the office's entire news network."]] },
  { id: "dwight-camera", cast: [DW], lines: [
    [DW, CAMERA + "In an emergency I'd be the last man standing. Also the first. I'd be all of them."]] },
  { id: "oscar-camera", cast: [OSC], lines: [
    [OSC, CAMERA + "I'm the only one here who reads the terms and conditions."]] },
  { id: "pretzel-day", cast: [STAN, KEV], emoji: "🥨", lines: [
    [KEV, "Is it pretzel day?"], [STAN, "Every day I'm not on a call is pretzel day."]] },
].map(b => Object.freeze(b)));

/** Steps for one bit: {at (ms from start), id, text, ms}. Lines are spaced so each bubble can be read. */
export function anticTimeline(bit, lineGapMs = 2600) {
  let at = 0;
  return bit.lines.map(([id, text]) => {
    const ms = Math.min(4200, 1900 + text.length * 32);
    const step = { at, id, text, ms };
    at += Math.max(lineGapMs, ms * 0.8);
    return step;
  });
}

export class Antics {
  constructor({ rng = Math.random, gapMs = [7000, 14000], busyGapFactor = 2.5, recent = 14, bits = ANTICS, lineGapMs = 2600 } = {}) {
    Object.assign(this, { rng, gapMs, busyGapFactor, recentSize: recent, bits, lineGapMs });
    this.nextAt = 0; this.recent = [];
  }
  _gap(busy) { const [a, b] = this.gapMs; return (a + this.rng() * (b - a)) * (busy ? this.busyGapFactor : 1); }
  /**
   * agents: [{ id, idle }] (idle = not working, walking, on a break or in another scene). Returns a bit to play
   * ({ bit, steps, visit, total }) or null. While the team is busy, bits are rarer and only involve idle agents.
   */
  tick(now, agents, { teamBusy = false } = {}) {
    if (!this.nextAt) { this.nextAt = now + this._gap(teamBusy); return null; }
    if (now < this.nextAt) return null;
    const idle = new Set(agents.filter(a => a.idle).map(a => a.id));
    const fits = this.bits.filter(b => b.cast.every(id => idle.has(id)));
    const fresh = fits.filter(b => !this.recent.includes(b.id));
    const pool = fresh.length ? fresh : fits;
    this.nextAt = now + this._gap(teamBusy);
    if (!pool.length) return null;
    const bit = pool[Math.floor(this.rng() * pool.length)];
    this.recent.push(bit.id); if (this.recent.length > this.recentSize) this.recent.shift();
    const steps = anticTimeline(bit, this.lineGapMs);
    const last = steps[steps.length - 1];
    return { bit, steps, visit: bit.visit || null, total: last.at + last.ms };
  }
}
