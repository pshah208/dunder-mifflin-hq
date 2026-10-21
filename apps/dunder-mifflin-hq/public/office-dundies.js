// Dunder Mifflin HQ — Office view of the reward system: the Dundies board, leaderboard and in-world reactions.
// Pure helpers (no DOM access) so they can be unit-tested; office.js renders their output.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LEAD = "regional-manager", TOBY = "compliance-officer";

// id -> award icons, so a winner's name tag in the Office shows their trophies.
export function awardBadges(awards = []) {
  const out = {};
  for (const a of awards) (out[a.winner] ||= []).push(a.icon);
  return out;
}

function avatar(m) {
  if (m?.avatar) return `<img src="${esc(m.avatar)}" alt="">`;
  return `<span class="ini" style="background:${esc(m?.color || "#888")}">${esc(m?.initials || "??")}</span>`;
}

export function dundieListHtml(awards = [], team = []) {
  const byId = new Map(team.map(m => [m.id, m]));
  return awards.map(a => {
    const m = byId.get(a.winner);
    const name = m?.persona || a.winner;
    return `<li class="dundie" title="${esc(a.blurb)}"><span class="trophy" aria-hidden="true">${esc(a.icon)}</span>${avatar(m)}`
      + `<span class="what"><b>${esc(a.title)}</b>${esc(name)} · ${esc(a.value)} ${esc(a.unit)}</span></li>`;
  }).join("");
}

// Only agents with at least one signal make the leaderboard; nobody is ranked on silence.
export function leaderboardRows(scorecard = [], team = [], max = 8) {
  const byId = new Map(team.map(m => [m.id, m]));
  return scorecard.filter(s => s.positives + s.negatives > 0).slice(0, max).map(s => {
    const name = byId.get(s.id)?.persona || s.id;
    return `<tr><td>${esc(name)}</td><td class="num">${esc(s.score)}</td><td class="num">${Math.round(s.reliability * 100)}% <span class="muted">(${esc(s.confidence)})</span></td>`
      + `<td class="num">${s.up}</td><td class="num">${s.down}</td><td class="num">${s.used}</td><td class="num">${s.approved}/${s.rejected}</td><td class="num">${s.streak}</td></tr>`;
  }).join("");
}

// Who speaks in the Office when a reply is rated, and what they say. Original lines, in the spirit of the show.
export function feedbackReaction(ev, nick = id => id) {
  const helpers = (ev?.agents || []).filter(id => id !== LEAD);
  const star = helpers[0] || LEAD;
  const changed = Array.isArray(ev?.changed) ? ev.changed : ["rating", "usedAsWritten"];
  if (changed.includes("usedAsWritten") && ev?.usedAsWritten) return { lines: [[LEAD, "Used as written! Somebody get me a Dundie engraver."], [star, `${nick(star)} accepts this honour with humility. Mostly.`]], feed: ["📋", "used as written"] };
  if (!changed.includes("rating")) return null;
  if (ev?.rating === "up") return { lines: [[LEAD, "A thumbs up! That's basically a Dundie."], [star, "I'd like to thank the Academy. And Michael."]], feed: ["👍", "got a thumbs up"] };
  if (ev?.rating === "down") return { lines: [[LEAD, "Thumbs down. We learn, we grow, we never speak of it."], [helpers.includes(TOBY) ? TOBY : star, "Noted. We'll do better next time."]], feed: ["👎", "got a thumbs down"] };
  return null;
}
