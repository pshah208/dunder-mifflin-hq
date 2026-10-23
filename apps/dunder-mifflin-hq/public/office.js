// Dunder Mifflin HQ — "Office": an isometric, Sims-style view of the two teams.
// Agents walk to their stations and animate while Michael has work delegated to them.
// Driven by the server's /api/live stream (same events the chat page receives) or a local demo script.
import { Lounge, Banter, LOUNGE_SPOTS, SIT_POSES, BREAK_GLYPHS, BREAK_LINES, BANTER_SOLO } from "./office-lounge.js";
import { findEndKey } from "./ui-logic.js";
import { teamOf, pickScene, pickGreeting, pickHuddleLine, pickPair, pairKey, pickHandoff } from "./office-crossteam.js";
import { createGrid, simDepth } from "./office-path.js";
import { Antics, CAMERA } from "./office-antics.js";
import { TEXT_CAP, buildAliases, isSocialRun, isReadTool, buildScene as buildSocialScene, feedNote, sceneTimeline, sceneEndAt, HUDDLE_SPOTS, isMeetingSummary, stripMeetingPrefix } from "./office-social.js";
import { awardBadges, dundieListHtml, leaderboardRows, feedbackReaction } from "./office-dundies.js";
import { captureOffice, restoreOffice, OFFICE_STATE_KEY } from "./office-continuity.js";

const TOKEN = document.querySelector('meta[name="dm-token"]').content;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function reportOfficeError(error) {
  let notice = $("#officeError");
  if (!notice) {
    notice = document.createElement("p");
    notice.id = "officeError"; notice.className = "office-error"; notice.setAttribute("role", "alert");
    document.body.prepend(notice);
  }
  notice.textContent = `Office rendering stopped: ${String(error?.message || error).slice(0, 240)}. Reload this page; if it persists, share this error.`;
  notice.hidden = false;
}
addEventListener("error", event => {
  if (/office(?:-[\w-]+)?\.js/.test(event.filename || "")) reportOfficeError(event.error || event.message);
});
addEventListener("unhandledrejection", event => {
  if (/office(?:-[\w-]+)?\.js/.test(event.reason?.stack || "")) reportOfficeError(event.reason);
});

// ---------- Isometric helpers ----------
const TW = 64, TH = 32;
const VB = { x: -400, y: -170, w: 1310, h: 820 };
const iso = (x, y, z = 0) => [(x - y) * TW / 2, (x + y) * TH / 2 - z];
const P = arr => arr.map(p => iso(...p).map(n => n.toFixed(1)).join(",")).join(" ");
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * f))));
  return "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
}
const poly = (pts, fill, extra = "") => `<polygon points="${P(pts)}" fill="${fill}" ${extra}/>`;
const EDGE = `stroke="#00000033" stroke-width="0.8" stroke-linejoin="round"`;

function box(x, y, w, d, h, c, { z = 0, opacity = 1 } = {}) {
  const op = opacity < 1 ? `fill-opacity="${opacity}"` : "";
  return poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], shade(c, .82), `${EDGE} ${op}`) +
    poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], shade(c, .66), `${EDGE} ${op}`) +
    poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], c, `${EDGE} ${op}`);
}
const onWallY = (Y, x0, x1, z0, z1, fill, extra = "") => poly([[x0, Y, z0], [x1, Y, z0], [x1, Y, z1], [x0, Y, z1]], fill, extra);
const onWallX = (X, y0, y1, z0, z1, fill, extra = "") => poly([[X, y0, z0], [X, y1, z0], [X, y1, z1], [X, y0, z1]], fill, extra);
const onFaceY = onWallY; // front (+y) face of a freestanding object
function textOnWallY(Y, x, z, text, size, fill, extra = "") {
  const [tx, ty] = iso(x, Y, z);
  return `<text transform="matrix(0.894,0.447,0,1,${tx.toFixed(1)},${ty.toFixed(1)})" font-size="${size}" fill="${fill}" ${extra}>${esc(text)}</text>`;
}
function textOnWallX(X, y, z, text, size, fill, extra = "") {
  const [tx, ty] = iso(X, y, z);
  return `<text transform="matrix(0.894,-0.447,0,1,${tx.toFixed(1)},${ty.toFixed(1)})" font-size="${size}" fill="${fill}" ${extra}>${esc(text)}</text>`;
}
const floorRect = (x0, y0, x1, y1, fill, extra = "") => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], fill, extra);
function floorText(x, y, text, size, fill) {
  const [tx, ty] = iso(x, y, 0);
  return `<text transform="matrix(0.894,0.447,-0.894,0.447,${tx.toFixed(1)},${ty.toFixed(1)})" font-size="${size}" fill="${fill}" font-weight="800" font-family="Segoe UI, sans-serif" letter-spacing="1">${esc(text)}</text>`;
}

// ---------- Scene (static) ----------
// Each item: { depth, svg }. Depth = x + y of the item's centre; bigger is closer to the camera.
const items = [];
// `rect` is the floor footprint: it blocks walking and anchors sim depth sorting. Wall art and floor decals have none.
const add = (depth, svg, rect = null) => items.push({ depth, svg, rect });
const addBox = (x, y, w, d, h, c, o = {}) => add(o.depth ?? (x + w / 2 + y + d / 2), box(x, y, w, d, h, c, o) + (o.extra || ""),
  o.solid === false ? null : { x0: x, y0: y, x1: x + w, y1: y + d });

function desk(x, y, { color = "#c9a273", screens = 1, logo = "#2ecc71" } = {}) {
  let s = box(x, y, 1.6, 0.8, 26, color);
  for (let i = 0; i < screens; i++) {
    const sx = x + 0.25 + i * 0.62;
    s += box(sx, y + 0.12, 0.55, 0.06, 20, "#2a2f36", { z: 30 }) + box(sx + 0.22, y + 0.12, 0.1, 0.1, 4, "#2a2f36", { z: 26 });
    const [cx, cy] = iso(sx + 0.28, y + 0.18, 40);
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.2" fill="${logo}"/>`;
  }
  add(x + 0.8 + y + 0.4, s, { x0: x, y0: y, x1: x + 1.6, y1: y + 0.8 });
}
function chair(x, y, c) { addBox(x, y, 0.7, 0.7, 14, c); addBox(x, y - 0.05, 0.7, 0.15, 36, c, { depth: x + y - 0.2 }); }

function signText(y, x, z, text, size = 12, fill = "#2d3748") {
  return textOnWallY(y, x, z, text, size, fill, `font-weight="800" font-family="Segoe UI, sans-serif" letter-spacing=".6"`);
}
function roundTable(x, y, c = "#d9c7aa") {
  const [cx, cy] = iso(x, y, 18);
  return box(x - 0.05, y - 0.05, 0.1, 0.1, 18, "#695746") + `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="20" ry="10" fill="${c}" ${EDGE}/>`;
}
function monitor(x, y, z = 28, color = "#2b6cb0") {
  return box(x, y, 0.52, 0.07, 18, "#263238", { z }) + box(x + 0.2, y + 0.05, 0.08, 0.08, 4, "#263238", { z: z - 3 }) +
    `<circle cx="${iso(x + .26, y + .1, z + 11)[0].toFixed(1)}" cy="${iso(x + .26, y + .1, z + 11)[1].toFixed(1)}" r="2" fill="${color}"/>`;
}
function simpleDesk(x, y, { color = "#caa879", phone = false, screens = 0, label = "" } = {}) {
  let svg = box(x, y, 1.35, 0.75, 24, color);
  for (let i = 0; i < screens; i++) svg += monitor(x + 0.18 + i * 0.55, y + 0.13, 28);
  if (phone) svg += box(x + 0.9, y + 0.16, 0.22, 0.16, 5, "#1f2933", { z: 26 });
  if (label) svg += textOnWallY(y + 0.75, x + 0.15, 11, label, 7, "#5b4636", `font-weight="700" font-family="Segoe UI, sans-serif"`);
  add(x + .7 + y + .35, svg, { x0: x, y0: y, x1: x + 1.35, y1: y + .75 });
}
function buildScene() {
  add(-120, floorRect(-1, -1, 26, 13, "#2f3d35"));
  // HQ 1: Scranton Branch floor.
  let scranton = floorRect(0, 0, 14.8, 11.4, "#d9ceb7");
  for (let i = 0; i < 15; i++) scranton += `<line x1="${iso(i,0)[0]}" y1="${iso(i,0)[1]}" x2="${iso(i,11.4)[0]}" y2="${iso(i,11.4)[1]}" stroke="#c3b79e" stroke-width=".7"/>`;
  scranton += floorRect(0.2, 7.0, 7.1, 11.25, "#d6c5aa", `fill-opacity=".55"`); // annex & accounting
  scranton += floorRect(7.35, 6.6, 9.4, 7.95, "#e3d6bb", EDGE); // copy corner
  scranton += floorRect(10.9, 6.6, 14.7, 10.85, "#78484b", EDGE); // Café Disco
  scranton += floorRect(0.2, 0.2, 3.0, 3.4, "#cfc2a8", EDGE); // Michael's office
  scranton += floorRect(3.25, 0.2, 6.25, 3.4, "#eee4cc", EDGE); // conference room
  scranton += floorText(7.5, 7.85, "COPY CORNER", 7, "#8a7559") + floorText(11.2, 10.65, "CAFÉ DISCO", 11, "#f6d6e8");
  scranton += floorText(0.45, 10.95, "ANNEX & ACCOUNTING", 9, "#8a7559") + floorText(0.4, 3.15, "REGIONAL MANAGER", 7, "#8a7559");
  add(-100, scranton);
  const wall = "#ebe3d2";
  add(-92, onWallY(0, 0, 14.8, 0, 118, wall, EDGE) + onWallX(0, 0, 11.4, 0, 82, shade(wall, .88), EDGE) +
    onWallY(0, 0, 14.8, 0, 18, "#274d7d") + onWallX(0, 0, 11.4, 0, 18, "#274d7d") +
    signText(0, 1.0, 98, "Dunder Mifflin Paper Company, Inc. — Scranton Branch", 13, "#1d3557") +
    signText(0, 3.7, 66, "Conference Room", 10, "#5a4635") +
    onWallY(0, .4, 2.7, 40, 82, "#9fd3f5", `${EDGE} fill-opacity=".55"`) + textOnWallX(0, 0.9, 60, "MICHAEL", 12, "#1d3557", `font-weight="900" font-family="Segoe UI, sans-serif"`) +
    // Bullpen whiteboard (Michael's "board" spot stands in front of it).
    onWallY(0, 7.15, 8.95, 34, 80, "#ffffff", EDGE) + signText(0, 7.35, 70, "Sales goals", 8, "#1f4e9c") +
    `<polyline points="${P([[7.4, 0, 46], [7.9, 0, 54], [8.3, 0, 50], [8.75, 0, 64]])}" fill="none" stroke="#c0392b" stroke-width="2"/>`);
  // Michael's glass office: front wall with a door gap at x 1.2-2.0, side wall shared with the conference room.
  addBox(0.2, 3.35, 1.0, 0.1, 62, "#9fd3f5", { opacity: .35 }); addBox(2.0, 3.35, 1.0, 0.1, 62, "#9fd3f5", { opacity: .35 });
  addBox(3.0, 0.2, 0.1, 3.25, 62, "#9fd3f5", { opacity: .35 });
  addBox(0.8, 1.4, 1.6, 0.85, 28, "#8f6b45", { extra: box(1.6, 1.53, .18, .18, 8, "#f4f1e8", { z: 30 }) + textOnWallY(2.25, .9, 14, "World's Best Boss", 6, "#1d3557") });
  addBox(0.35, 2.55, 0.45, 0.7, 16, "#3c5f91"); // couch
  // Conference room table.
  addBox(3.75, 1.25, 1.9, 1.25, 22, "#b48a58");
  addBox(4.35, 1.72, .35, .25, 7, "#f7fafc", { z: 22, solid: false });
  // Reception + bullpen desks.
  addBox(9.8, 1.0, 1.9, 0.8, 30, "#b88954", { extra: textOnWallY(1.8, 10.05, 13, "Reception", 8, "#fff") });
  simpleDesk(6.7, 2.1, { phone: true, label: "Jim" }); simpleDesk(8.35, 2.1, { phone: true, label: "Dwight" });
  simpleDesk(6.7, 4.1, { phone: true, label: "Stanley" }); simpleDesk(8.35, 4.1, { phone: true, label: "Phyllis" });
  simpleDesk(10.3, 4.1, { phone: true }); // spare bullpen desk
  for (const [px, py] of [[12.9, 0.35], [13.4, 0.35], [13.9, 0.35]]) addBox(px, py, .42, .55, 18, "#f5f1e8"); // paper samples
  // Annex & accounting.
  simpleDesk(1.2, 8.0, { phone: true, label: "Angela" }); simpleDesk(2.85, 8.0, { phone: true, label: "Kevin" });
  simpleDesk(4.45, 8.0, { screens: 1, label: "Oscar" }); simpleDesk(5.6, 8.85, { screens: 1, label: "Andy" });
  simpleDesk(2.0, 10.1, { label: "Creed" });
  addBox(6.2, 6.6, .35, .35, 52, "#b7d8f2"); // water cooler
  // Copy corner (the old break nook); the Break Room is now its own room off the front of the floor.
  addBox(7.6, 6.85, .9, .65, 34, "#d9dde2", { extra: box(7.65, 6.9, .8, .5, 4, "#4a5560", { z: 34 }) + onFaceY(7.5, 7.7, 8.3, 20, 26, "#9fb3c4") + textOnWallY(7.5, 7.68, 12, "Copier", 6, "#1d2733", `font-weight="700"`) });
  addBox(8.7, 6.9, .45, .4, 14, "#f5f1e8", { extra: box(8.72, 6.92, .4, .36, 5, "#ffffff", { z: 14 }) }); // paper reams
  // Café Disco props.
  addBox(11.45, 7.05, 1.05, .55, 34, "#6b4f3a", { extra: textOnWallY(7.6, 11.55, 13, "Espresso", 7, "#fef3c7") });
  add(21.65, roundTable(12.2, 9.45, "#f2d6d3"), { x0: 11.9, y0: 9.15, x1: 12.5, y1: 9.75 });
  add(-88, floorRect(13.25, 8.15, 14.55, 9.5, "#5b244a", `${EDGE} class="dancefloor"`));
  const [dbx, dby] = iso(13.85, 7.9, 86);
  add(21.75, `<line x1="${dbx.toFixed(1)}" y1="${(dby - 30).toFixed(1)}" x2="${dbx.toFixed(1)}" y2="${(dby - 12).toFixed(1)}" stroke="#8a8177" stroke-width="1"/><circle class="disco" cx="${dbx.toFixed(1)}" cy="${dby.toFixed(1)}" r="12" fill="#d9f3ff" stroke="#ffffff" stroke-width="2"/>`);
  // HQ 2: Dunder Mifflin Infinity warehouse lab.
  let wh = floorRect(15.6, 0, 25.2, 11.4, "#8a8177");
  for (let i = 16; i < 25; i++) wh += `<line x1="${iso(i,0)[0]}" y1="${iso(i,0)[1]}" x2="${iso(i,11.4)[0]}" y2="${iso(i,11.4)[1]}" stroke="#746b62" stroke-width=".7"/>`;
  wh += floorRect(17.4, 6.85, 22.0, 9.95, "#6f7f8e", EDGE); // workstation zone
  wh += floorRect(14.8, 5.25, 15.6, 6.05, "#9b9184", EDGE); // connecting hallway
  wh += floorText(17.7, 10.85, "INFINITY LAB", 11, "#d8e1ea");
  add(-99, wh);
  add(-91, onWallY(0, 15.6, 25.2, 0, 118, "#c9c4ba", EDGE) + onWallX(15.6, 0, 11.4, 0, 86, "#b7b0a4", EDGE) +
    onWallY(0, 15.6, 25.2, 0, 18, "#2d3748") + signText(0, 17.0, 88, "Dunder Mifflin Infinity", 18, "#1f2937") +
    signText(0, 18.1, 48, "Warehouse Lab", 10, "#374151") + onWallX(15.6, 1.0, 3.4, 10, 72, "#3f3f46", EDGE) +
    onWallX(15.6, 5.25, 6.05, 0, 58, "#5b5148", EDGE)); // doorway to the Scranton office
  // Warehouse props.
  for (const [sx, sy] of [[23.1,1.1],[23.9,1.1],[23.1,2.0],[23.9,2.0],[23.1,2.9]]) addBox(sx, sy, .7, .55, 42, "#eee9dc");
  addBox(16.2, 8.5, 1.3, .8, 70, "#b8b8b8", { opacity: .35, extra: textOnWallY(9.3, 16.32, 52, "Darryl", 8, "#1f2937") });
  addBox(17.8, 2.1, 2.4, .12, 70, "#f7fafc", { extra: onFaceY(2.22,17.9,20.1,18,62,"#ffffff") + textOnWallY(2.22,18.05,48,"Design board",8,"#1d4ed8") });
  addBox(21.2, 4.2, 1.0, .55, 12, "#f59e0b"); addBox(21.55, 3.65, .15, .55, 10, "#111827"); // forklift
  simpleDesk(17.55, 7.15, { phone: true, color: "#5d6d7e", label: "Toby" }); simpleDesk(19.45, 7.15, { screens: 2, color: "#5d6d7e", label: "Ryan" });
  simpleDesk(21.35, 7.15, { screens: 2, color: "#5d6d7e", label: "Darryl" }); simpleDesk(18.45, 9.0, { phone: true, color: "#5d6d7e", label: "Kelly" });
  decorateDesks();
  furnishConferenceRoom();
  buildBasketballCourt();
  buildBreakRoom();
}
const BASKETBALL = Object.freeze({ x: 21.5, y: 2.9, rimX: 21.5, rimY: 1.25, rimZ: 67 });
function buildBasketballCourt() {
  let court = floorRect(20.5, .4, 22.8, 3.3, "#a97c50", `stroke="#fef3c7" stroke-width="1.5"`);
  court += floorRect(20.9, .4, 22.1, 1.9, "none", `stroke="#fef3c7" stroke-width="1.2"`);
  const arc = Array.from({ length: 25 }, (_, i) => {
    const a = Math.PI * i / 24;
    return [21.5 + .85 * Math.cos(a), .7 + 2.0 * Math.sin(a)];
  });
  court += `<polyline points="${P(arc)}" fill="none" stroke="#fef3c7" stroke-width="1.3"/>`;
  court += floorText(20.6, 3.05, "SCRANTON HOOPS", 6, "#fff3d6");
  add(-87, `<g class="basketball-court">${court}</g>`);
  const hoop = BASKETBALL;
  addBox(21.13, .55, .74, .45, 6, "#273446", { extra: box(21.42, .65, .16, .18, 88, "#485568") });
  let board = onWallY(.92, 20.65, 22.35, 64, 104, "#eef6ff", `stroke="#334155" stroke-width="2" fill-opacity=".92"`);
  board += onWallY(.93, 21.15, 21.85, 68, 87, "none", `stroke="#e76027" stroke-width="2"`);
  const ring = Array.from({ length: 17 }, (_, i) => {
    const a = Math.PI * 2 * i / 16;
    return [hoop.rimX + .35 * Math.cos(a), hoop.rimY + .24 * Math.sin(a), hoop.rimZ];
  });
  for (let i = 0; i < 16; i++) {
    const [x, y, z] = ring[i];
    const [nx, ny] = ring[(i + 3) % 16];
    board += `<polyline points="${P([[x, y, z], [hoop.rimX + (nx - hoop.rimX) * .65, hoop.rimY + (ny - hoop.rimY) * .65, z - 20]])}" fill="none" stroke="#ffffff" stroke-width="1" opacity=".9"/>`;
  }
  board += `<polygon points="${P(ring)}" fill="none" stroke="#f97316" stroke-width="3"/>`;
  add(22.5, `<g class="basketball-hoop" aria-label="Basketball backboard, orange rim and woven net">${board}</g>`);
  const [sx, sy] = iso(hoop.x, hoop.y, 37);
  const [rx, ry] = iso(hoop.rimX, hoop.rimY, hoop.rimZ);
  add(hoop.x + hoop.y + .1, `<g class="basketball-shot" style="--shot-x:${(rx - sx).toFixed(1)}px;--shot-y:${(ry - sy).toFixed(1)}px"><g transform="translate(${sx.toFixed(1)},${sy.toFixed(1)})"><circle r="5.5" fill="#ef7c26" stroke="#713611" stroke-width="1"/><path d="M-5,0H5M0,-5V5M-3,-4Q2,0 -3,4" fill="none" stroke="#713611" stroke-width=".7"/></g></g>`);
  const [bx, by] = iso(22.35, 2.9, 6);
  add(25.25, `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="6" fill="#ef7c26" stroke="#713611"/><path d="M${bx - 6},${by}h12M${bx},${by - 6}v12" stroke="#713611" stroke-width=".8"/>`);
}
// ---------- Break Room (separate room off the front of the Scranton floor) ----------
// Room interior: x 6.3–14.5, y 11.75–16.1. Entered through a door in the glass partition at x 9.8–10.8.
// The back walls (partition at y = 11.65, side wall at x = 6.3) are cut down Sims-style so nothing behind them is hidden.
const BREAK_ROOM = Object.freeze({ x0: 6.3, x1: 14.5, y0: 11.65, y1: 16.1, door: Object.freeze({ x0: 9.8, x1: 10.8 }) });
function buildBreakRoom() {
  const R = BREAK_ROOM;
  add(-119, floorRect(5.9, 11.4, 15.0, 16.6, "#2f3d35")); // ground under the extension
  // Checkered linoleum floor.
  let floor = floorRect(R.x0, R.y0, R.x1, R.y1, "#ece6d6", EDGE);
  for (let x = R.x0, i = 0; x < R.x1 - 1e-6; x += 0.5, i++) {
    for (let y = R.y0, j = 0; y < R.y1 - 1e-6; y += 0.5, j++) {
      if ((i + j) % 2) floor += floorRect(x, y, Math.min(x + 0.5, R.x1), Math.min(y + 0.5, R.y1), "#d6ccb5");
    }
  }
  floor += floorRect(R.door.x0, 11.3, R.door.x1, R.y0, "#cfc4ad", EDGE); // threshold
  floor += floorRect(11.5, 12.85, 13.1, 13.65, "#b5543c", `fill-opacity=".55" ${EDGE}`); // rug under the coffee table
  floor += floorText(7.45, 15.95, "BREAK ROOM", 11, "#9a8a6a");
  add(-98, floor);
  // Back walls: tall side wall with cabinets, window, clock and sign; low glass partition toward the bullpen.
  const sideWall = "#e6dcc6";
  let walls = onWallX(R.x0, R.y0, R.y1, 0, 92, shade(sideWall, .9), EDGE) + onWallX(R.x0, R.y0, R.y1, 0, 14, "#274d7d");
  walls += onWallX(R.x0, 12.6, 14.55, 54, 80, "#a77a4f", EDGE) + onWallX(R.x0, 13.55, 13.6, 54, 80, "#7d5a39"); // upper cabinets
  walls += onWallX(R.x0, 14.85, 16.0, 30, 72, "#bfe3f7", EDGE); // window
  for (let z = 36; z < 72; z += 6) walls += `<polyline points="${P([[R.x0, 14.88, z], [R.x0, 15.97, z]])}" stroke="#ffffff" stroke-width="1.2" stroke-opacity=".8"/>`; // blinds
  const [ckx, cky] = iso(R.x0, 15.45, 83);
  walls += `<ellipse cx="${ckx.toFixed(1)}" cy="${cky.toFixed(1)}" rx="5" ry="6" fill="#ffffff" stroke="#1d2733" stroke-width="1.2"/><line x1="${ckx.toFixed(1)}" y1="${cky.toFixed(1)}" x2="${ckx.toFixed(1)}" y2="${(cky - 4).toFixed(1)}" stroke="#1d2733" stroke-width="1"/><line x1="${ckx.toFixed(1)}" y1="${cky.toFixed(1)}" x2="${(ckx + 3).toFixed(1)}" y2="${(cky + 1).toFixed(1)}" stroke="#c0392b" stroke-width="1"/>`;
  walls += textOnWallX(R.x0, 12.75, 83, "BREAK ROOM", 9, "#1d3557", `font-weight="900" font-family="Segoe UI, sans-serif" letter-spacing="1"`); // sits on the cabinets, below the wall top
  // Partition: knee wall + glass, with a door gap and frame posts.
  for (const [a, b] of [[R.x0, R.door.x0], [R.door.x1, R.x1]]) {
    walls += onWallY(R.y0, a, b, 0, 16, "#d8cdb6", EDGE) + onWallY(R.y0, a, b, 16, 44, "#9fd3f5", `fill-opacity=".22" ${EDGE}`);
    walls += `<polyline points="${P([[a, R.y0, 44], [b, R.y0, 44]])}" stroke="#7d8a96" stroke-width="2"/>`;
  }
  walls += onWallY(R.y0, R.door.x0 - .06, R.door.x0, 0, 50, "#7d8a96") + onWallY(R.y0, R.door.x1, R.door.x1 + .06, 0, 50, "#7d8a96");
  // Party Planning Committee bunting over the lounge corner.
  const flags = ["#e75480", "#f1c40f", "#3d7cc9", "#2e8b57", "#c0392b", "#9c6b98"];
  for (let k = 0; k < 9; k++) {
    const x = 11.1 + k * 0.36, z = 62 - Math.sin((k / 8) * Math.PI) * 6;
    walls += poly([[x, R.y0 + .02, z], [x + .3, R.y0 + .02, z], [x + .15, R.y0 + .02, z - 9]], flags[k % flags.length]);
  }
  walls += `<polyline points="${P([[11.1, R.y0 + .02, 62], [12.55, R.y0 + .02, 56], [14.3, R.y0 + .02, 62]])}" fill="none" stroke="#8a6b4a" stroke-width=".8"/>`;
  add(-90, walls);
  // Low front/right edges so the room reads as enclosed without hiding anyone.
  add(-89, onWallY(R.y1, R.x0, R.x1, 0, 8, "#c9bea6", EDGE) + onWallX(R.x1, R.y0, R.y1, 0, 8, "#c9bea6", EDGE));

  // Kitchenette along the side wall.
  addBox(6.4, 11.8, .65, .7, 88, "#f4f4f2", { extra: onWallX(7.05, 11.85, 12.45, 46, 47.5, "#b8bcc2") + box(7.05, 12.0, .03, .06, 14, "#9aa1a9", { z: 52 }) + box(7.05, 12.25, .03, .08, 8, "#e75480", { z: 66 }) + box(7.05, 12.1, .03, .08, 8, "#3d7cc9", { z: 30 }) }); // fridge + magnets
  addBox(6.4, 12.55, .6, 2.05, 30, "#c9a273", { extra:
    box(6.45, 12.7, .45, .5, 14, "#2b2f36", { z: 30 }) + onWallX(6.9, 12.78, 13.08, 33, 41, "#5c7d8a") + // microwave
    box(6.5, 13.45, .3, .25, 16, "#1f2329", { z: 30 }) + box(6.6, 13.48, .14, .14, 7, "#7a4b2a", { z: 31 }) + // coffee maker + pot
    box(6.85, 13.8, .1, .1, 5, "#ffffff", { z: 30 }) + box(6.85, 13.95, .1, .1, 5, "#f1c40f", { z: 30 }) + // mugs
    poly([[6.48, 14.05, 30.5], [6.92, 14.05, 30.5], [6.92, 14.45, 30.5], [6.48, 14.45, 30.5]], "#aab4bd", EDGE) }); // sink
  addBox(6.42, 14.72, .3, .3, 14, "#5b6b7a"); addBox(6.75, 14.72, .3, .3, 14, "#2e8b57", { extra: textOnWallY(15.02, 6.78, 4, "♻", 7, "#ffffff") }); // trash + recycling
  // Vending machines against the partition.
  addBox(7.65, 11.8, .65, .55, 72, "#263238", { extra: onFaceY(12.35, 7.7, 8.1, 22, 64, "#cfe8f5") + vendRows(12.35, 7.72, 8.08, ["#f1c40f", "#e67e22", "#c0392b", "#2e8b57"]) + textOnWallY(12.35, 7.7, 68, "SNACKS", 6, "#fef08a", `font-weight="800"`) });
  addBox(8.4, 11.8, .65, .55, 72, "#b03a2e", { extra: onFaceY(12.35, 8.45, 8.85, 22, 64, "#f3d6d2") + vendRows(12.35, 8.47, 8.83, ["#3d7cc9", "#ffffff", "#2e8b57", "#f1c40f"]) + textOnWallY(12.35, 8.45, 68, "DRINKS", 6, "#ffffff", `font-weight="800"`) });
  // Dining: two round tables with stools.
  for (const [tx, ty] of [[9.7, 13.6], [9.7, 15.3]]) {
    for (const sx of [tx - .55, tx + .55]) addBox(sx - .13, ty - .13, .26, .26, 10, "#7d5a39", { solid: false, depth: sx + ty - .3 });
    add(tx + ty, roundTable(tx, ty, "#efe6d2"), { x0: tx - .3, y0: ty - .3, x1: tx + .3, y1: ty + .3 });
  }
  // Lounge corner: couch, coffee table, bean bag, plant.
  addBox(11.3, 11.8, 2.0, .15, 28, "#8a3b3b"); // couch back
  addBox(11.3, 11.95, 2.0, .4, 12, "#a64646", { extra: box(11.5, 12.0, .45, .3, 5, "#f1c40f", { z: 12 }) + box(12.75, 12.0, .45, .3, 5, "#f5f1e8", { z: 12 }) }); // seat + cushions
  addBox(11.15, 11.8, .15, .55, 18, "#7a3434"); addBox(13.3, 11.8, .15, .55, 18, "#7a3434"); // arms
  addBox(11.7, 13.05, 1.2, .35, 10, "#8f6b45", { extra: box(11.85, 13.12, .3, .2, 1, "#3d7cc9", { z: 10 }) + box(12.4, 13.15, .12, .12, 5, "#ffffff", { z: 10 }) }); // coffee table, magazine, mug
  const [bbx, bby] = iso(13.85, 13.2, 6);
  add(13.85 + 13.2 - .4, `<ellipse cx="${bbx.toFixed(1)}" cy="${bby.toFixed(1)}" rx="14" ry="8" fill="#3d7cc9" ${EDGE}/><ellipse cx="${(bbx - 2).toFixed(1)}" cy="${(bby - 3).toFixed(1)}" rx="7" ry="3.5" fill="#5b94d6"/>`); // bean bag
  addBox(14.0, 15.6, .32, .32, 12, "#a0522d", { extra: plantTop(14.16, 15.76, 12) });
  addBox(6.95, 15.65, .3, .3, 10, "#a0522d", { extra: plantTop(7.1, 15.8, 10) });
  // Ping-pong table: green top, white lines, net; the ball only animates while someone is playing.
  addBox(11.3, 14.6, 1.9, .85, 18, "#1e7a4c", { extra:
    `<polyline points="${P([[11.3, 15.025, 18.2], [13.2, 15.025, 18.2]])}" stroke="#ffffff" stroke-width="1"/>` +
    box(12.22, 14.6, .06, .85, 6, "#f5f5f5", { z: 18 }) });
  const [b0x, b0y] = iso(11.45, 15.02, 26);
  add(27.6, `<circle class="pp-ball" cx="${b0x.toFixed(1)}" cy="${b0y.toFixed(1)}" r="2.4" fill="#ffffff" stroke="#e67e22" stroke-width=".8"/>`);
}
function vendRows(Y, x0, x1, colors) {
  let s = "";
  for (let r = 0; r < 4; r++) {
    const z = 56 - r * 9;
    for (let c = 0; c < 4; c++) {
      const a = x0 + (x1 - x0) * (c / 4) + .02, b = a + (x1 - x0) / 4 - .04;
      s += onFaceY(Y + .001, a, b, z - 5, z, colors[(r + c) % colors.length]);
    }
  }
  return s;
}
function plantTop(x, y, z) {
  const [px, py] = iso(x, y, z);
  return [[0, -8, 7], [-5, -4, 5], [5, -4, 5], [0, -13, 5]].map(([dx, dy, r]) => `<circle cx="${(px + dx).toFixed(1)}" cy="${(py + dy).toFixed(1)}" r="${r}" fill="#3f8f4f"/>`).join("");
}


// ---------- Personal desk touches (original props inspired by each character) ----------
const DESK_TOP = 24; // simpleDesk height
const pt = (x, y, z) => iso(x, y, z).map(n => n.toFixed(1));
const deco = {
  mug: (x, y, z, c = "#ffffff") => box(x, y, .11, .11, 6, c, { z }),
  trophy: (x, y, z) => { const [hx, hy] = pt(x + .06, y + .06, z + 15); return box(x, y, .13, .13, 3, "#6b4f2a", { z }) + box(x + .035, y + .035, .06, .06, 10, "#e1b12c", { z: z + 3 }) + `<circle cx="${hx}" cy="${hy}" r="2.4" fill="#f1c40f" stroke="#a67c00" stroke-width=".5"/>`; },
  frame: (x, y, z, photo = "#9fd3f5") => box(x, y, .26, .04, 11, "#5a4636", { z }) + onFaceY(y + .041, x + .035, x + .225, z + 2, z + 9, photo),
  beet: (x, y, z) => { const [bx, by] = pt(x, y, z + 3); return `<ellipse cx="${(+bx - 2).toFixed(1)}" cy="${(+by - 5).toFixed(1)}" rx="1.2" ry="3" fill="#3f8f4f"/><ellipse cx="${(+bx + 1.5).toFixed(1)}" cy="${(+by - 5).toFixed(1)}" rx="1.2" ry="3" fill="#4fa35f"/><circle cx="${bx}" cy="${by}" r="3" fill="#7d1f4f"/>`; },
  bobble: (x, y, z) => { const [hx, hy] = pt(x + .04, y + .04, z + 11); return box(x, y, .09, .09, 6, "#c7a14a", { z }) + `<circle cx="${hx}" cy="${hy}" r="3.6" fill="#f2c9a6" stroke="#7a5232" stroke-width=".5"/><path d="M${+hx - 3.4} ${+hy - 1} q3.4 -4 6.8 0" fill="#7a5232"/><line x1="${+hx - 2.4}" y1="${+hy + .4}" x2="${+hx + 2.4}" y2="${+hy + .4}" stroke="#333" stroke-width=".6"/>`; },
  jello: (x, y, z) => box(x + .08, y + .06, .22, .06, 3, "#2b2f36", { z: z + 1 }) + box(x, y, .38, .18, 7, "#f7dc6f", { z, opacity: .7 }),
  ball: (x, y, z, c = "#e67e22") => { const [bx, by] = pt(x, y, z + 3.5); return `<circle cx="${bx}" cy="${by}" r="3.5" fill="${c}" stroke="#6b3410" stroke-width=".5"/><line x1="${+bx - 3.5}" y1="${by}" x2="${+bx + 3.5}" y2="${by}" stroke="#6b3410" stroke-width=".5"/>`; },
  candyDish: (x, y, z) => { const [cx, cy] = pt(x, y, z + 2); return `<ellipse cx="${cx}" cy="${cy}" rx="5" ry="2.6" fill="#cfe8f5" stroke="#7d8a96" stroke-width=".5"/>` + ["#e74c3c", "#f1c40f", "#2ecc71", "#3498db"].map((c, i) => `<circle cx="${(+cx - 2.5 + i * 1.7).toFixed(1)}" cy="${(+cy - .6).toFixed(1)}" r="1" fill="${c}"/>`).join(""); },
  sketchbook: (x, y, z) => poly([[x, y, z + .3], [x + .32, y, z + .3], [x + .32, y + .22, z + .3], [x, y + .22, z + .3]], "#ffffff", EDGE) + `<polyline points="${P([[x + .05, y + .06, z + .4], [x + .14, y + .15, z + .4], [x + .26, y + .07, z + .4]])}" fill="none" stroke="#e75480" stroke-width=".8"/>` + box(x + .33, y + .05, .02, .16, 1, "#f1c40f", { z }),
  cat: (x, y, z, c = "#c8c8c8") => { const [cx, cy] = pt(x, y, z); return `<ellipse cx="${cx}" cy="${(+cy - 3).toFixed(1)}" rx="3.2" ry="3" fill="${c}" stroke="#666" stroke-width=".4"/><circle cx="${cx}" cy="${(+cy - 7.5).toFixed(1)}" r="2.3" fill="${c}" stroke="#666" stroke-width=".4"/><path d="M${+cx - 2} ${+cy - 9} l.6 -2.2 l1 1.4 Z M${+cx + 2} ${+cy - 9} l-.6 -2.2 l-1 1.4 Z" fill="${c}" stroke="#666" stroke-width=".3"/>`; },
  jar: (x, y, z, dots = ["#e74c3c", "#f1c40f", "#2ecc71", "#3498db", "#e67e22"]) => { const [jx, jy] = pt(x + .07, y + .07, z + 5); return box(x, y, .14, .14, 10, "#dff1fb", { z, opacity: .6 }) + dots.map((c, i) => `<circle cx="${(+jx - 2 + (i % 3) * 2).toFixed(1)}" cy="${(+jy + 2 - Math.floor(i / 3) * 2.2).toFixed(1)}" r=".9" fill="${c}"/>`).join(""); },
  pot: (x, y, z) => box(x, y, .2, .18, 7, "#b03a2e", { z }) + box(x + .02, y + .02, .16, .14, 1.5, "#7a1f16", { z: z + 7 }),
  crossword: (x, y, z) => { let s = poly([[x, y, z + .3], [x + .3, y, z + .3], [x + .3, y + .28, z + .3], [x, y + .28, z + .3]], "#ffffff", EDGE); for (let k = 1; k < 4; k++) s += `<polyline points="${P([[x + k * .075, y, z + .4], [x + k * .075, y + .28, z + .4]])}" stroke="#555" stroke-width=".3"/><polyline points="${P([[x, y + k * .07, z + .4], [x + .3, y + k * .07, z + .4]])}" stroke="#555" stroke-width=".3"/>`; return s; },
  pretzel: (x, y, z) => { const [px, py] = pt(x, y, z + 1); return `<path d="M${+px - 3} ${py} q0 -3.5 3 -1.5 q3 -2 3 1.5 q-3 2.5 -3 -.5 q0 3 -3 .5" fill="none" stroke="#b5651d" stroke-width="1.4"/>`; },
  yarn: (x, y, z) => { const [yx, yy] = pt(x, y, z + 3); return `<circle cx="${yx}" cy="${yy}" r="3.2" fill="#e88bb2" stroke="#b8577f" stroke-width=".5"/><line x1="${+yx - 1}" y1="${+yy - 2}" x2="${+yx + 5}" y2="${+yy - 8}" stroke="#8a6b4a" stroke-width=".7"/><line x1="${+yx + 1}" y1="${+yy - 2}" x2="${+yx + 6.5}" y2="${+yy - 6}" stroke="#8a6b4a" stroke-width=".7"/>`; },
  flowers: (x, y, z) => { const [fx, fy] = pt(x + .05, y + .05, z + 8); return box(x, y, .1, .1, 8, "#9fd3f5", { z, opacity: .8 }) + [["#e74c3c", -2.5, -3], ["#f1c40f", 0, -5], ["#9b59b6", 2.5, -3]].map(([c, dx, dy]) => `<line x1="${fx}" y1="${fy}" x2="${(+fx + dx).toFixed(1)}" y2="${(+fy + dy).toFixed(1)}" stroke="#3f8f4f" stroke-width=".6"/><circle cx="${(+fx + dx).toFixed(1)}" cy="${(+fy + dy).toFixed(1)}" r="1.5" fill="${c}"/>`).join(""); },
  magazine: (x, y, z) => poly([[x, y, z + .3], [x + .28, y, z + .3], [x + .28, y + .2, z + .3], [x, y + .2, z + .3]], "#e75480", EDGE) + poly([[x + .03, y + .03, z + .4], [x + .14, y + .03, z + .4], [x + .14, y + .17, z + .4], [x + .03, y + .17, z + .4]], "#ffd6e7"),
  heart: (x, y, z) => { const [hx, hy] = pt(x, y, z + 6); return `<text x="${hx}" y="${hy}" font-size="7" text-anchor="middle" fill="#e75480">♥</text>`; },
  wilted: (x, y, z) => { const [wx, wy] = pt(x + .06, y + .06, z + 7); return box(x, y, .12, .12, 7, "#a0522d", { z }) + `<path d="M${wx} ${wy} q2 -6 5 -3 M${wx} ${wy} q-2 -5 -5 -2 M${wx} ${wy} q0 -5 1 -6" fill="none" stroke="#8a8a3a" stroke-width="1.1"/>`; },
  tissues: (x, y, z) => box(x, y, .2, .12, 5, "#9fd3f5", { z }) + `<path d="M${pt(x + .1, y + .06, z + 5).join(" ")} q1 -3 2 0" fill="#ffffff" stroke="#ccc" stroke-width=".3"/>`,
  sprouts: (x, y, z) => { const [sx, sy] = pt(x + .06, y + .06, z + 9); return box(x, y, .12, .12, 9, "#dff1fb", { z, opacity: .6 }) + [-2, 0, 2].map(d => `<path d="M${(+sx + d).toFixed(1)} ${sy} q${d} -4 ${d * 1.5} -5" fill="none" stroke="#6ab04c" stroke-width=".9"/>`).join(""); },
  cactus: (x, y, z) => box(x, y, .1, .1, 4, "#a0522d", { z }) + box(x + .03, y + .03, .04, .04, 8, "#3f8f4f", { z: z + 4 }),
  books: (x, y, z) => box(x, y, .3, .2, 3, "#2e8b57", { z }) + box(x + .02, y + .01, .27, .18, 3, "#1f4e9c", { z: z + 3 }) + box(x + .01, y + .02, .25, .17, 3, "#c0392b", { z: z + 6 }),
  bulb: (x, y, z) => { const [bx, by] = pt(x, y, z + 8); return box(x - .03, y - .03, .06, .06, 4, "#7d8a96", { z }) + `<circle cx="${bx}" cy="${by}" r="3.2" fill="#fff3a0" stroke="#e1b12c" stroke-width=".6"/><path d="M${+bx - 5} ${+by - 4} l-2 -1 M${+bx + 5} ${+by - 4} l2 -1 M${bx} ${+by - 5.5} l0 -2.2" stroke="#e1b12c" stroke-width=".7"/>`; },
  stickies: (x, y, z) => box(x, y, .13, .13, 2, "#f7dc6f", { z }) + box(x + .16, y + .02, .13, .13, 2, "#ff9ff3", { z }) + box(x + .06, y + .14, .13, .13, 2, "#7bed9f", { z }),
  phone: (x, y, z) => poly([[x, y, z + .3], [x + .08, y, z + .3], [x + .08, y + .15, z + .3], [x, y + .15, z + .3]], "#1d2733", EDGE),
  headphones: (x, y, z) => { const [hx, hy] = pt(x, y, z + 2); return `<path d="M${+hx - 4} ${hy} q4 -8 8 0" fill="none" stroke="#2b2f36" stroke-width="1.4"/><circle cx="${+hx - 4}" cy="${hy}" r="1.6" fill="#c0392b"/><circle cx="${+hx + 4}" cy="${hy}" r="1.6" fill="#c0392b"/>`; },
  keys: (x, y, z) => { let s = box(x, y, .5, .14, 2.5, "#f5f5f5", { z }); for (let k = 1; k < 7; k++) if (k % 3) s += `<polyline points="${P([[x + k * .07, y, z + 2.6], [x + k * .07, y + .08, z + 2.6]])}" stroke="#222" stroke-width="1"/>`; return s; },
  banjo: (x, y, z) => { const [bx, by] = pt(x, y, z + 1); return `<line x1="${bx}" y1="${by}" x2="${(+bx + 8).toFixed(1)}" y2="${(+by - 9).toFixed(1)}" stroke="#6b4f2a" stroke-width="1.4"/><ellipse cx="${bx}" cy="${by}" rx="4" ry="2.6" fill="#f5f1e8" stroke="#8a6b4a" stroke-width=".8"/>`; },
};
// Desk origin + desk-top height, and the props on it. Depth puts props just in front of their desk.
const DESKS = [
  { who: "regional-manager", x: 0.8, y: 1.4, w: 1.6, d: .85, z: 28, props: [["trophy", .2, .15], ["frame", 1.15, .1, "#f5c26b"]] }, // + the boss mug already on the desk
  { who: "sales-lead", x: 8.35, y: 2.1, props: [["bobble", .18, .25], ["beet", .5, .45]] },
  { who: "account-strategist", x: 6.7, y: 2.1, props: [["jello", .15, .35], ["ball", .7, .5]] },
  { who: "office-administrator", x: 9.8, y: 1.0, w: 1.9, d: .8, z: 30, props: [["candyDish", .45, .45], ["sketchbook", 1.05, .3]] },
  { who: "renewals-desk", x: 6.7, y: 4.1, props: [["crossword", .15, .3], ["pretzel", .6, .5], ["mug", .7, .25, "#6b4f2c"]] },
  { who: "relationship-manager", x: 8.35, y: 4.1, props: [["yarn", .25, .45], ["flowers", .55, .3]] },
  { who: "finance-analyst", x: 1.2, y: 8.0, props: [["cat", .25, .45], ["frame", .45, .2, "#d7c4e8"]] },
  { who: "summarizer", x: 2.85, y: 8.0, props: [["jar", .2, .3], ["pot", .5, .45]] },
  { who: "communications", x: 18.45, y: 9.0, props: [["magazine", .15, .35], ["heart", .6, .5], ["frame", .5, .15, "#ffb3d1"]] },
  { who: "compliance-officer", x: 17.55, y: 7.15, props: [["wilted", .2, .3], ["tissues", .5, .45]] },
  { who: "qa-reviewer", x: 2.0, y: 10.1, props: [["sprouts", .2, .3], ["cactus", .55, .45]] },
  { who: "cloud-ai-architect", x: 4.45, y: 8.0, props: [["books", .25, .45], ["mug", .95, .5, "#2e8b57"]] },
  { who: "product-manager", x: 19.45, y: 7.15, props: [["bulb", .3, .5], ["stickies", .7, .45], ["phone", 1.1, .5]] },
  { who: "automation-engineer", x: 21.35, y: 7.15, props: [["keys", .2, .5], ["headphones", 1.0, .55]] },
  { who: "presentation-designer", x: 5.6, y: 8.85, props: [["banjo", .9, .45], ["mug", .25, .5, "#c0392b"]] },
];
function decorateDesks() {
  for (const d of DESKS) {
    const z = d.z ?? DESK_TOP, w = d.w ?? 1.35, dd = d.d ?? .75;
    const svg = d.props.map(([kind, ox, oy, arg]) => deco[kind](d.x + ox, d.y + oy, z, arg)).join("");
    add(d.x + w / 2 + d.y + dd / 2 + .02, `<g class="desk-decor" data-who="${d.who}">${svg}</g>`);
  }
}

// ---------- Conference room seating (meetings and brainstorms) ----------
const CONF_HEAD = [6.0, 1.88]; // Michael runs the meeting from the end of the table
const CONF_SEATS = [
  [3.95, 0.85], [4.7, 0.85], [5.45, 0.85], [3.95, 2.9], [4.7, 2.9], [5.45, 2.9],
  [3.4, 1.55], [3.4, 2.2], [6.0, 0.8], [6.0, 2.95], [3.45, 0.7], [3.45, 3.05], [5.95, 3.25], [4.3, 3.25],
];
function furnishConferenceRoom() {
  for (const [x, y] of [...CONF_SEATS.slice(0, 8), CONF_HEAD]) addBox(x - .14, y - .14, .28, .28, 12, "#3c5f91", { solid: false, depth: x + y - .3 });
  // Idea board on the conference room's back wall, with sticky notes.
  let board = onWallY(0, 4.0, 5.9, 26, 58, "#ffffff", EDGE) + textOnWallY(0, 4.1, 52, "IDEAS", 8, "#1f4e9c", `font-weight="900" font-family="Segoe UI, sans-serif"`);
  const notes = ["#f7dc6f", "#ff9ff3", "#7bed9f", "#70a1ff", "#f7dc6f", "#ffa502"];
  notes.forEach((c, i) => { const x = 4.15 + (i % 3) * .55, z = i < 3 ? 38 : 30; board += onWallY(0.01, x, x + .3, z, z + 6, c); });
  add(-90, board);
}

// ---------- Stations ----------
const HOME = {
  "regional-manager": [1.6, 1.15, "talk"],
  "sales-lead": [9.2, 1.85, "phone"], "account-strategist": [7.45, 1.85, "phone"], "office-administrator": [10.75, 0.9, "phone"],
  "finance-analyst": [1.9, 7.7, "review"], "renewals-desk": [7.45, 3.85, "phone"], "relationship-manager": [9.2, 3.85, "phone"],
  "communications": [19.1, 8.7, "phone"], "summarizer": [3.55, 7.75, "review"],
  "cloud-ai-architect": [5.15, 7.75, "type"], "product-manager": [20.25, 6.85, "type"], "automation-engineer": [22.15, 6.85, "type"], "presentation-designer": [6.25, 8.6, "board"],
  "qa-reviewer": [2.65, 9.85, "review"], "compliance-officer": [18.35, 6.85, "review"],
};
// Roles that join a team huddle at the meeting table/whiteboard when two or more of them are working at once.
const HUDDLE = new Set(["regional-manager", "sales-lead", "account-strategist", "office-administrator", "relationship-manager", "communications",
  "cloud-ai-architect", "product-manager", "automation-engineer", "presentation-designer"]);
const SEATS = {
  sales: CONF_SEATS.slice(0, 6), // Scranton huddles use the conference room table
  engineering: [[18.1, 2.75], [19.0, 2.75], [19.9, 2.75], [18.55, 3.55], [19.45, 3.55]],
};
// Character study (downtime): students read in the Break Room; Michael hovers nearby.
const STUDY_SPOTS = [[11.5, 13.95], [12.3, 14.05], [13.1, 13.95], [9.4, 12.6], [10.3, 12.5], [8.2, 14.5]];
const STUDY_HOST = [10.6, 14.3];
const STUDY_CHATTER = ["Huh. Apparently I'm 'a lot'.", "Taking notes on myself. Very meta.", "This fan wiki really gets me.", "Interesting… I should be more like me.",
  "Reading up. Do not disturb. Unless snacks.", "I knew I was the main character.", "Writing original lines only. Promise.", "Chapter one: me."];
const roomOf = x => (x < 15.3 ? "sales" : "engineering");
const NICK = { "regional-manager": "Michael", "sales-lead": "Dwight", "account-strategist": "Jim", "office-administrator": "Pam", "finance-analyst": "Angela", "renewals-desk": "Stanley", "relationship-manager": "Phyllis", "communications": "Kelly", "summarizer": "Kevin", "cloud-ai-architect": "Oscar", "product-manager": "Ryan", "automation-engineer": "Darryl", "presentation-designer": "Andy", "qa-reviewer": "Creed", "compliance-officer": "Toby" };

const FLAVOR = {
  "regional-manager": ["Everybody stay calm; I am leading.", "This feels like a branch moment.", "I will brief the warehouse personally."],
  "sales-lead": ["Customer attack plan is ready.", "Paper facts are locked in.", "I have three follow-up calls."],
  "account-strategist": ["Calling the customer now.", "Let's make this easy to say yes to.", "Tiny prank after delivery."],
  "office-administrator": ["I'll keep the handoff clear.", "Reception has the latest version.", "That phrasing is nicer."],
  "finance-analyst": ["Checking the numbers.", "No mystery discounts.", "That needs a clean approval trail."],
  "renewals-desk": ["Renewal angle is fine.", "Keep the forecast realistic.", "If it closes, wake me."],
  "relationship-manager": ["The customer note is warm.", "Let's make it feel personal.", "I can smooth that over."],
  "communications": ["I have three announcement angles.", "This update needs sparkle.", "Everyone will know by lunch."],
  "summarizer": ["Summary incoming.", "Short version: good paper.", "I can make a snack-sized recap."],
  "cloud-ai-architect": ["Actually, the design is stable.", "Azure, data, and AI are aligned.", "I tightened the schema."],
  "product-manager": ["Infinity can scale this.", "Launch narrative updated.", "The product story is almost mature."],
  "automation-engineer": ["Workflow is moving.", "Warehouse path is clear.", "Script handles the repeat work."],
  "presentation-designer": ["Deck is warming up.", "Slide three needs a button.", "I can sing the intro, but won't."],
  "qa-reviewer": ["Quality corner found something.", "This passes my mysterious test.", "Looks fine, which concerns me."],
  "compliance-officer": ["HR note is clean.", "Outbound review is calm.", "Please don't ignore the policy."],
};
const GLYPHS = { read: ["📖", "🤔", "💡", "✍️"], type: ["{ }", "</>", "⌨", "AI"], board: ["✏️", "📐", "💡"], review: ["🔍", "✓", "📋"], phone: ["📞", "📇", "📈"], talk: ["💬", "☕"] };

// ---------- Sims ----------
const world = $("#world"), overlay = $("#overlay");
world.setAttribute("viewBox", `${VB.x} ${VB.y} ${VB.w} ${VB.h}`);
const sims = new Map();
// Idle breaks (cafe, couch). Decorative: never sets s.active, so no false "working" state, gem or counter.
const lounge = new Lounge({ spots: LOUNGE_SPOTS });
const banter = new Banter({ lounge }); // ambient persona one-liners: bubbles only, never feed/chat/history
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
lounge.setEnabled(!reducedMotion.matches);
let uid = 0;
let team = [];

// The avatar SVGs paint a persona-coloured background disc (plus a faint white overlay) behind the face.
// On the Office floor that disc reads as a coloured halo around the head, so strip ONLY those two
// background shapes from an in-memory copy. Avatar files and other pages are untouched.
const avatarCache = new Map();
function stripAvatarBackground(svg) {
  return String(svg)
    .replace(/<rect\b[^>]*\bwidth="128"[^>]*\bheight="128"[^>]*\/>/, "")
    .replace(/<circle\b[^>]*\br="64"[^>]*\bfill="#ffffff"[^>]*\/>/, "");
}
async function officeAvatar(url) {
  if (avatarCache.has(url)) return avatarCache.get(url);
  let out = url;
  try {
    if (/\.svg(\?|$)/i.test(url)) {
      const svg = await (await fetch(url)).text();
      const stripped = stripAvatarBackground(svg);
      if (stripped !== svg) out = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(stripped)}`;
    }
  } catch { /* fall back to original image */ }
  avatarCache.set(url, out);
  return out;
}

function simSvg(m) {
  const c = m.color || "#2ecc71", dark = shade(c, .72);
  return `<g class="facing"><g class="sim-body">
    <ellipse cx="0" cy="0" rx="13" ry="5.5" fill="#00000040"/>
    <rect class="leg l" x="-7" y="-17" width="5.5" height="17" rx="2.5" fill="#2b2f3a"/>
    <rect class="leg r" x="1.5" y="-17" width="5.5" height="17" rx="2.5" fill="#2b2f3a"/>
    <rect class="arm l" x="-15.5" y="-37" width="5" height="18" rx="2.5" fill="${dark}"/>
    <rect x="-11" y="-39" width="22" height="25" rx="8" fill="${c}"/>
    <g class="arm r"><rect x="10.5" y="-37" width="5" height="18" rx="2.5" fill="${dark}"/><rect class="phone" x="10" y="-22" width="7" height="10" rx="1.5" fill="#222"/><g class="mug"><rect x="11" y="-25" width="6" height="7" rx="1.4" fill="#f5efe2" stroke="#8a6b4a" stroke-width=".6"/><path d="M17 -23.5 q3 1 0 4" fill="none" stroke="#f5efe2" stroke-width="1.2"/></g><g class="snack"><circle cx="14" cy="-18" r="3.4" fill="#d9a05b"/><circle cx="13" cy="-19" r=".7" fill="#6b3f1d"/><circle cx="15" cy="-17" r=".7" fill="#6b3f1d"/></g><g class="book"><rect x="9" y="-29" width="10" height="8" rx="1" fill="#1f4e9c" stroke="#0f2a57" stroke-width=".6"/><line x1="14" y1="-29" x2="14" y2="-21" stroke="#f5f1e8" stroke-width=".8"/></g><g class="paddle"><rect x="12" y="-21" width="2" height="5" rx="1" fill="#8a6b4a"/><circle cx="13" cy="-24" r="4" fill="#c0392b" stroke="#7a1f16" stroke-width=".6"/></g></g>
    <rect class="ream" x="10" y="-10" width="12" height="8" rx="1.5" fill="#f5f1e8" stroke="#8a8177" stroke-width="1"/>
    <image href="${esc(m.avatar)}" x="-18" y="-73" width="36" height="36" preserveAspectRatio="xMidYMid slice" clip-path="url(#headClip)"/>
  </g></g>`;
}

function createSims() {
  world.innerHTML = `<defs><clipPath id="headClip"><circle cx="0" cy="-55" r="17.5"/></clipPath></defs><g id="layer"></g>`;
  const layer = $("#layer");
  buildScene();
  depthBoxes = items.filter(it => it.rect).map(it => ({ ...it.rect, depth: it.depth }));
  walkGrid = createGrid(depthBoxes);
  for (const it of items) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.innerHTML = it.svg; g._depth = it.depth; g._uid = uid++; layer.appendChild(g);
  }
  for (const m of team) {
    const home = HOME[m.id]; if (!home) continue;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "sim pose-idle"); g._uid = uid++; g._depth = 0;
    g.dataset.agent = m.id;
    g.innerHTML = simSvg(m);
    layer.appendChild(g);
    const label = document.createElement("div");
    label.className = "sim-label"; label.textContent = NICK[m.id] || m.persona.split(" ")[0];
    label.title = `${m.persona} · ${m.title}`;
    const gem = document.createElement("div"); gem.className = "gem";
    const bubble = document.createElement("div"); bubble.className = "bubble";
    overlay.append(label, gem, bubble);
    const [hx, hy, pose] = home;
    sims.set(m.id, { m, g, label, gem, bubble, x: hx, y: hy, path: [], pose: "idle", homePose: pose, active: false,
      target: null, idleUntil: 0, bubbleUntil: 0, facing: 1, carry: null });
  }
}

let walkGrid = null, depthBoxes = [];
function routeTo(s, tx, ty) {
  s.path = walkGrid ? walkGrid.findPath([s.x, s.y], [tx, ty]) : [[tx, ty]];
}

function goTo(s, x, y, pose) {
  const key = `${x.toFixed(2)},${y.toFixed(2)}`;
  s.nextPose = pose;
  if (s.target === key) { if (!s.path.length) s.pose = pose; return; }
  s.target = key; routeTo(s, x, y);
}

// ---------- State from events ----------
const state = { busy: false, runs: new Map(), source: "live", leadText: "", replaying: false, studying: new Set() };
// Per-run bookkeeping. `fullText` keeps the whole final answer (capped) for social-scene parsing; leadText stays the short tail for bubbles.
const makeRun = (busy = false) => ({ busy, active: new Map(), leadText: "", fullText: "", delegates: 0, observed: false, work: false, errored: false, lastDelegate: null, summaries: new Map() });
const feed = [];

function personaOf(id) { return team.find(m => m.id === id); }
function logFeed(icon, html) {
  feed.unshift({ icon, html, t: new Date() });
  feed.length = Math.min(feed.length, 8);
  $("#feed").innerHTML = feed.map(f => `<li><span class="fi">${f.icon}</span><span>${f.html}</span><time>${f.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></li>`).join("");
}

function onEvent(ev) {
  if (ev.t === "queue") return;
  const runId = ev.runId || "global";
  const run = state.runs.get(runId) || makeRun();
  let social = null;
  if (!state.runs.has(runId)) state.runs.set(runId, run);
  switch (ev.t) {
    case "start":
      run.busy = true; run.active.clear(); run.leadText = ""; run.fullText = ""; run.delegates = 0; run.observed = true; run.work = false; run.errored = false;
      run.study = ev.kind === "study";
      if (run.study) {
        logFeed("📖", `Character study: <b>Michael</b> gives the free agents some downtime to read up on themselves`);
        say("regional-manager", "Downtime! Everybody read up on yourselves. Responsibly.", 3500);
      } else {
        logFeed("🟢", `<b>Michael</b> picked up a new request`);
        say("regional-manager", "On it. I know exactly who to involve… probably.", 3500);
      }
      break;
    case "delegate": {
      run.busy = true;
      const m = personaOf(ev.agent);
      run.active.set(ev.callId, { agent: ev.agent, summary: ev.summary || "" });
      run.summaries.set(ev.agent, ev.summary || "");
      run.delegates += 1;
      run.lastDelegate = ev.agent;
      if (m) {
        logFeed(`<img src="${esc(m.avatar)}" alt="">`, `<b>${esc(m.persona)}</b> ← ${esc(ev.summary || "new task")}${ev.model ? ` <code>${esc(ev.model)}</code>` : ""}`);
        if (run.study) say(ev.agent, "Reading up on my character… 📖", 3200);
        else {
          say("regional-manager", `${m.persona.split(" ")[0]}, please take “${trim(ev.summary, 40)}”?`, 3500);
          say(ev.agent, "On it!", 2200);
        }
      } else {
        logFeed("🤖", `Helper agent <code>${esc(ev.agent)}</code> ← ${esc(ev.summary || "")}`);
      }
      break;
    }
    case "agent_start": {
      run.busy = true;
      if (!ev.agent) break;
      const prior = run.active.get(ev.callId);
      if (prior) {
        prior.background = ev.background;
        prior.started = true;
        prior.agent = ev.agent;
        prior.summary ||= ev.summary || "";
        break;
      }
      run.active.set(ev.callId, { agent: ev.agent, summary: ev.summary || run.summaries.get(ev.agent) || "", background: ev.background, started: true });
      run.summaries.set(ev.agent, ev.summary || run.summaries.get(ev.agent) || "");
      run.delegates += 1;
      run.lastDelegate = ev.agent;
      break;
    }
    case "agent_end": {
      // Finished for real. A duplicate or unknown end finds nothing in run.active and is ignored.
      const key = findEndKey(run.active, ev.callId, ev.agent); // with a callId, never fall back to another live call of the same agent
      const a = key === null ? null : run.active.get(key);
      if (a) {
        run.active.delete(key);
        const m = personaOf(a.agent);
        if (m) {
          if (ev.cancelled) { logFeed("⏹", `<b>${esc(m.persona)}</b> stopped: ${esc(trim(a.summary, 60))}`); say(a.agent, "Stopped.", 2000); }
          else {
            logFeed(ev.ok === false ? "⚠️" : "✅", `<b>${esc(m.persona)}</b> ${ev.ok === false ? "hit a problem" : "finished"}: ${esc(trim(a.summary, 60))}`);
            say(a.agent, ev.ok === false ? "Hmm, that failed ⚠️" : "Done ✓", 2500);
          }
          if (ev.ok !== false && !ev.cancelled && teamOf(a.agent) === "engineering") requestHandoff(a.agent);
        }
      }
      break;
    }
    case "tool_end": {
      const a = run.active.get(ev.callId);
      if (a && (a.started || ev.background)) break; // SDK lifecycle events, not tool-return text, own completion
      if (a) {
        run.active.delete(ev.callId);
        const m = personaOf(a.agent);
        if (m) { logFeed(ev.ok ? "✅" : "⚠️", `<b>${esc(m.persona)}</b> ${ev.ok ? "finished" : "hit a problem"}: ${esc(trim(a.summary, 60))}`); say(a.agent, ev.ok ? "Done ✓" : "Hmm, that failed ⚠️", 2500); }
      }
      break;
    }
    case "tool":
      run.work ||= !ev.name || !isReadTool(ev.name); // any nameless/unknown/write tool makes the run work, however many tools came before
      if (!run.active.size && ev.name) say("regional-manager", `${toolVerb(ev.name)}${ev.summary ? ` ${trim(ev.summary, 34)}` : ""}…`, 2500);
      break;
    case "delta": if (ev.agentId) break; run.leadText = (run.leadText + (ev.text || "")).slice(-400); if (run.fullText.length < TEXT_CAP) run.fullText = (run.fullText + (ev.text || "")).slice(0, TEXT_CAP); break;
    case "message": if (ev.agentId) break; if (ev.text) {
      run.leadText = ev.text.slice(-400); run.fullText = String(ev.text).slice(0, TEXT_CAP);
      const verdict = /TOBY\s+VERDICT\s*[:\-–—]\s*[*_`]*\s*(APPROVE|REJECT|CHANGES)/i.exec(ev.text);
      if (verdict && !run.tobySaid && !state.replaying) {
        run.tobySaid = true;
        const ok = /^APPROVE/i.test(verdict[1]);
        logFeed(ok ? "✅" : "⛔", `<b>Toby</b> ${ok ? "approved" : "sent back"} the work`);
        say("compliance-officer", ok ? "Approved. Please don't make it weird." : "I'm going to have to send this back. Sorry.", 3800);
      }
    } break;
    case "end":
      if (ev.agentId) break;
      if (state.source === "live" && run.busy && !run.study) setTimeout(loadDundies, 1500);
      if (run.busy && run.study) { logFeed("📖", `Character study wrapped up`); say("regional-manager", "Knowledge is power. So is a snack break.", 3500); }
      else if (run.busy) {
        if (isSocialRun(run, ev)) social = run.fullText; // the Social feed line replaces the usual wrap-up
        else { logFeed("🏁", `<b>Michael</b> wrapped up the request`); say("regional-manager", "Wrapped up. I am proud of this branch.", 4000); }
      }
      run.busy = false;
      run.active.clear();
      state.runs.delete(runId);
      break;
    case "error": run.errored = true; logFeed("⚠️", esc(trim(ev.text, 120))); break;
    case "persona_notes_updated": {
      loadLearnedQuips();
      const names = (ev.agents || []).map(id => personaOf(id)?.persona.split(" ")[0]).filter(Boolean);
      if (names.length) logFeed("📖", `Learned more about themselves: <b>${esc(names.join(", "))}</b>`);
      break;
    }
  }
  state.busy = [...state.runs.values()].some(r => r.busy);
  if (!state.replaying) plan();
  if (social !== null) requestScene(social);
}
const toolVerb = n => ({ view: "Reading", grep: "Searching", glob: "Looking for", powershell: "Running", edit: "Editing", create: "Writing" }[n] || `Using ${n}`);
const trim = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// Character-study notes: each agent's own original in-character quips join their lounge banter pool. Bubble-only.
async function fetchLearnedLines() {
  try {
    const res = await fetch("/api/personas/notes", { headers: { "X-DM-Token": TOKEN } });
    if (!res.ok) return null;
    const { notes } = await res.json();
    const out = {};
    for (const [id, n] of Object.entries(notes || {})) {
      const learned = (Array.isArray(n?.quips) ? n.quips : []).map(q => trim(q, 90)).filter(Boolean);
      if (learned.length) out[id] = learned;
    }
    return out;
  } catch { return null; }
}
export function mergeLearnedLines(builtIn, learned) {
  const solo = { ...builtIn };
  for (const [id, lines] of Object.entries(learned || {})) solo[id] = [...(solo[id] || []), ...lines];
  return solo;
}
function loadLearnedQuips() { fetchLearnedLines().then(learned => { if (learned) banter.solo = mergeLearnedLines(BANTER_SOLO, learned); }); }

// ---------- The Dundies (reward board) ----------
async function loadDundies() {
  try {
    const res = await fetch("/api/rewards", { headers: { "X-DM-Token": TOKEN } });
    if (!res.ok) return;
    const { scorecard = [], awards = [], totals = {} } = await res.json();
    $("#dundieList").innerHTML = dundieListHtml(awards, team);
    const rows = leaderboardRows(scorecard, team);
    $("#dundieTable").hidden = !rows;
    $("#dundieTable tbody").innerHTML = rows;
    if (totals.runs) $("#dundieSub").textContent = `${totals.rated} of ${totals.runs} replies rated · ${totals.usedAsWritten} used as written · Toby ${totals.tobyApproved} approved / ${totals.tobyRejected} rejected. Recent work counts more.`;
    const badges = awardBadges(awards);
    for (const [id, s] of sims) {
      s.label.textContent = NICK[id] || s.m.persona.split(" ")[0];
      if (badges[id]) {
        const b = document.createElement("span"); b.className = "award"; b.textContent = badges[id].join("");
        b.title = awards.filter(a => a.winner === id).map(a => a.title).join(", ");
        s.label.append(b);
      }
    }
  } catch { /* the board is decorative; the Office keeps running without it */ }
}
function onFeedback(ev) {
  const r = feedbackReaction(ev, id => NICK[id] || id);
  if (r) {
    logFeed(r.feed[0], `A reply ${esc(r.feed[1])} — credit to <b>${esc((ev.agents || []).map(id => NICK[id] || id).join(", "))}</b>`);
    r.lines.forEach(([id, line], i) => setTimeout(() => say(id, line, 3800), i * 1600));
  }
  loadDundies();
}

function say(id, text, ms = 3000) {
  const s = sims.get(id); if (!s || !text) return;
  s.sceneBubble = false; // a normal bubble is never owned by a social scene
  s.anticBubble = false; // an antic marks its own bubbles after calling say()
  s.bubble.textContent = text; s.bubble.classList.add("show");
  s.bubble.classList.toggle("camera", text.startsWith(CAMERA));
  s.bubbleUntil = performance.now() + ms;
}

// Decide where everybody should be and what they should be doing.
function plan() {
  const working = new Map(); // agentId -> summary
  const activeRuns = [...state.runs.values()];
  for (const r of activeRuns) {
    for (const a of r.active.values()) if (sims.has(a.agent)) working.set(a.agent, a.summary);
  }
  const leadText = activeRuns.map(r => r.leadText).filter(Boolean).join(" ").slice(-400);
  const lastDelegate = [...activeRuns].reverse().map(r => r.lastDelegate).find(Boolean) || null;
  if (scene && (state.busy || scene.ids.some(id => working.has(id)))) endScene(false); // real work always beats a chat
  // Meetings and brainstorms: everyone Michael called in walks to the conference room, whatever their team.
  const studying = new Set();
  for (const r of activeRuns) if (r.study) for (const a of r.active.values()) if (sims.has(a.agent)) studying.add(a.agent);
  const onlyStudy = activeRuns.some(r => r.busy) && activeRuns.filter(r => r.busy).every(r => r.study);
  state.studying = studying;
  let studyIdx = 0;
  const meeting = new Set([...working.entries()].filter(([id, sum]) => id !== "regional-manager" && !studying.has(id) && isMeetingSummary(sum)).map(([id]) => id));
  // Keep each request's stakeholders together through Michael's synthesis, including finished delegates.
  // Team identity is independent of desk location (Oscar and Andy sit on the Scranton floor).
  for (const run of activeRuns) {
    if (!run.busy || run.study) continue;
    const participants = [...run.summaries.keys()].filter(id => id !== "regional-manager" && sims.has(id));
    if (new Set(participants.map(teamOf).filter(Boolean)).size > 1) participants.forEach(id => meeting.add(id));
  }
  if (antic && antic.bit.cast.some(id => working.has(id) || meeting.has(id) || (id === "regional-manager" && state.busy))) endAntic(false);
  noteMeeting(meeting);
  let confIdx = 0;
  const confSeat = () => CONF_SEATS[confIdx++ % CONF_SEATS.length];
  const huddlers = { sales: [], engineering: [] };
  for (const id of working.keys()) {
    if (meeting.has(id) || studying.has(id)) continue;
    const room = roomOf(HOME[id][0]);
    if (HUDDLE.has(id) && huddlers[room]) huddlers[room].push(id);
  }
  const huddleRooms = Object.keys(huddlers).filter(r => huddlers[r].length >= 2);
  const seatIdx = { sales: 0, engineering: 0 };

  for (const [id, s] of sims) {
    s.active = working.has(id) || (id === "regional-manager" && state.busy);
    s.summary = working.get(id) || "";
    if (s.active) lounge.preempt(id, performance.now()); // real work always beats a break and frees the seat
    else if (meeting.has(id)) lounge.preempt(id, performance.now());
    if (!lounge.onBreak(id)) s.carry = null;
    if (id === "regional-manager") continue;
    if (inScene(id) || inAntic(id)) continue; // social scene / antic members stay put; real work already cancelled them above
    const [hx, hy, pose] = HOME[id];
    const room = roomOf(hx);
    if (meeting.has(id)) {
      goTo(s, ...confSeat(), "talk");
    } else if (working.has(id)) {
      if (studying.has(id)) goTo(s, ...STUDY_SPOTS[studyIdx++ % STUDY_SPOTS.length], "read");
      else if (huddleRooms.includes(room) && HUDDLE.has(id)) {
        // A Scranton huddle during a meeting just joins the conference table.
        const [sx, sy] = meeting.size && room === "sales" ? confSeat() : SEATS[room][seatIdx[room]++ % SEATS[room].length];
        goTo(s, sx, sy, "talk");
      } else goTo(s, hx, hy, pose);
      s.idleUntil = 0;
    } else if (!lounge.onBreak(id)) {
      goTo(s, hx, hy, "idle");
    }
  }

  // Michael: whiteboard when thinking alone; joins a huddle; otherwise visits whoever he last briefed.
  const r = sims.get("regional-manager");
  if (r) {
    if (meeting.size) goTo(r, ...CONF_HEAD, "talk");
    else if (onlyStudy) goTo(r, ...STUDY_HOST, "talk"); // Michael "supervises" study hall // Michael runs the meeting from the head of the table
    else if (!state.busy) { if (!lounge.onBreak("regional-manager") && !inScene("regional-manager") && !inAntic("regional-manager")) goTo(r, ...HOME["regional-manager"].slice(0, 2), "idle"); }
    else if (!working.size) goTo(r, 8.0, 0.95, "board");
    else if (huddleRooms.length) {
      const room = huddleRooms.includes("engineering") && !huddleRooms.includes("sales") ? "engineering" : huddleRooms[0];
      const [sx, sy] = SEATS[room][seatIdx[room]++ % SEATS[room].length];
      goTo(r, sx, sy, "talk");
    } else {
      const engineeringNow = [...working.keys()].filter(id => teamOf(id) === "engineering");
      const who = engineeringNow.length && teamOf(lastDelegate) !== "engineering" ? engineeringNow[engineeringNow.length - 1] : working.has(lastDelegate) ? lastDelegate : [...working.keys()].pop();
      const [hx, hy] = HOME[who];
      goTo(r, hx + 0.9, hy, "talk"); // stand beside them, not inside their desk
    }
  }
  crossPlan([...working.keys()].filter(id => !meeting.has(id) && !studying.has(id))); // meeting guests come to Michael, no warehouse briefing
  const n = working.size;
  $("#workingCount").textContent = n + (state.busy ? 1 : 0);
  const pill = $("#liveStatus");
  pill.className = `live-pill ${state.busy ? "busy" : "idle"}`;
  pill.textContent = state.busy ? `● ${state.source === "demo" ? "Demo" : "Live"}: ${n ? `${n} agent${n > 1 ? "s" : ""} working` : "Michael is thinking"}` : "● Team idle";
  state.leadText = leadText;
}


// ---------- Meetings (conference room) ----------
const MEETING_OPENERS = ["Conference room, everyone. Bring ideas!", "No idea is a bad idea. Most of them, anyway.", "This meeting is now in session. Snacks are optional.", "Let's brainstorm. Ryan, wow me."];
const meetingState = { ids: new Set(), queue: new Set(), timer: 0 };
// Attendees are delegated one after another; batch arrivals into one feed line.
function noteMeeting(ids) {
  const fresh = [...ids].filter(id => !meetingState.ids.has(id));
  const wasEmpty = !meetingState.ids.size;
  meetingState.ids = new Set(ids);
  for (const id of [...meetingState.queue]) if (!ids.has(id)) meetingState.queue.delete(id);
  if (!fresh.length || state.replaying) return;
  if (wasEmpty) say("regional-manager", MEETING_OPENERS[Math.floor(Math.random() * MEETING_OPENERS.length)], 3500);
  fresh.forEach(id => meetingState.queue.add(id));
  clearTimeout(meetingState.timer);
  meetingState.timer = setTimeout(() => {
    const names = [...meetingState.queue].map(nameOf); meetingState.queue.clear();
    if (names.length) logFeed("🗓️", `<b>Michael</b> called ${esc(names.join(", "))} into the conference room`);
  }, 1500);
}

// ---------- Cross-team dynamics (decorative bubbles + one feed line; never sets s.active, never moves anyone but via plan()) ----------
const cross = { briefed: new Set(), queue: [], timer: 0, working: [], lastAt: 0, nextHuddle: 0, nextPair: 0, lastSpeaker: null, lastPair: "", timers: new Set() };
const crossOk = () => !state.replaying && state.source !== "demo" && !document.hidden;
function crossSay(id, text, ms = 3000) {
  const s = sims.get(id); if (!s || !text || s.active && s.path.length) return;
  say(id, text, ms); s.crossBubble = true; cross.lastAt = performance.now();
}
function crossLater(fn, ms) { const t = setTimeout(() => { cross.timers.delete(t); if (crossOk()) fn(); }, ms); cross.timers.add(t); }
function crossPlan(workingIds) {
  cross.working = workingIds;
  const engineering = workingIds.filter(id => teamOf(id) === "engineering");
  if (!engineering.length) { cross.briefed.clear(); cross.queue.length = 0; return; }
  if (state.replaying) { engineering.forEach(id => cross.briefed.add(id)); return; } // never brief for history we merely replayed
  const fresh = engineering.filter(id => !cross.briefed.has(id));
  if (!fresh.length || !state.busy) return;
  fresh.forEach(id => { cross.briefed.add(id); cross.queue.push(id); });
  clearTimeout(cross.timer);
  cross.timer = setTimeout(flushBriefing, 1200); // batch the delegates launched together
}
function flushBriefing() {
  cross.timer = 0;
  const ids = [...new Set(cross.queue.splice(0))].filter(id => cross.working.includes(id));
  if (!ids.length) return;
  const names = ids.map(nameOf);
  logFeed("🤝", `<b>Michael</b> is heading over to brief ${esc(names.join(", "))}`);
  if (!crossOk()) return;
  const [hi, reply] = pickGreeting(ids);
  if (hi) { crossSay(hi.id, hi.text, 3200); crossLater(() => crossSay(reply.id, reply.text, 3200), 2400); }
}
function requestHandoff(id) {
  if (!crossOk()) return;
  const line = pickHandoff(id); if (!line) return;
  crossLater(() => crossSay(id, line, 3200), 1300);
}
// Huddle work lines and sales/Infinity pair banter: rate-capped, one bubble at a time, skipped while hidden.
setInterval(() => {
  if (!crossOk()) return;
  const now = performance.now();
  if (now - cross.lastAt < 3500) return;
  const sc = pickScene(cross.working);
  if (sc.kind === "none") return;
  const huddlers = sc.engineering.filter(id => { const s = sims.get(id); return s && s.active && !s.path.length && s.pose === "talk"; });
  if (huddlers.length >= 2 && now >= cross.nextHuddle) {
    const l = pickHuddleLine(huddlers, cross.lastSpeaker);
    if (l && now > (sims.get(l.id)?.bubbleUntil || 0)) { crossSay(l.id, l.text, 3000); cross.lastSpeaker = l.id; cross.nextHuddle = now + 4000 + Math.random() * 2000; return; }
  }
  if (sc.kind === "mixed" && now >= cross.nextPair) {
    const ok = id => { const s = sims.get(id); return s && !s.path.length && now > s.bubbleUntil; };
    const pair = pickPair(sc.sales.filter(ok), sc.engineering.filter(ok), Math.random, cross.lastPair);
    if (pair) {
      cross.lastPair = pairKey(pair); cross.nextPair = now + 14000 + Math.random() * 8000;
      crossSay(pair[0].id, pair[0].text, 3000); crossLater(() => crossSay(pair[1].id, pair[1].text, 3000), 2200);
    }
  }
}, 1000);

// ---------- Social scene (non-work chats) ----------
// When Michael answers a chat in persona with no delegation or write/shell tools, the teammates he mentions meet him at the cafe,
// trade a few lines pulled from his answer (or ambient banter), then go home. Purely decorative: never sets s.active (no gem,
// no "working" count), no network or LLM calls, nothing written to chat or history. Real work cancels it at once.
let scene = null, pendingScene = null, aliasesCache = null;
const inScene = id => !!scene && scene.ids.includes(id);
const nameOf = id => NICK[id] || (personaOf(id)?.persona || id).split(" ")[0];
// A social run that gets no scene still deserves the normal wrap-up line.
const wrapUpFeed = () => logFeed("🏁", `<b>Michael</b> wrapped up the request`);
function requestScene(text) {
  if (state.replaying || state.source === "demo" || document.hidden) { wrapUpFeed(); return; }
  if (pendingScene) wrapUpFeed(); // an older queued scene is replaced and will never play
  if (scene) endScene(true); // latest wins; old members walk home
  pendingScene = { text, at: performance.now() };
  startPendingScene();
}
function startPendingScene() {
  const p = pendingScene;
  if (!p || scene) return;
  if (document.hidden || performance.now() - p.at > 60000) { pendingScene = null; wrapUpFeed(); return; }
  if (state.busy) return; // wait for the team to be free (queue of one)
  pendingScene = null;
  aliasesCache ||= buildAliases(team);
  const def = buildSocialScene(p.text, aliasesCache, { pool: BANTER_SOLO, available: id => sims.has(id) });
  const ids = def.participants.filter(id => sims.has(id));
  if (!ids.length) { wrapUpFeed(); return; }
  const still = reducedMotion.matches;
  ids.forEach(id => lounge.preempt(id, performance.now())); // clear ambient visitors who are about to join
  if (antic) endAntic(false); // a real chat scene replaces any running joke
  scene = { ids, lines: def.lines, solo: def.solo, clock: 0, last: performance.now(), phase: still ? "talk" : "gather", talkAt: 0, steps: null, next: 0, endAt: 0, maxOnBreak: lounge.maxOnBreak, still };
  lounge.maxOnBreak = 0; // no new ambient breaks while the huddle is on
  logFeed("☕", `Break-room: ${esc(feedNote(ids, Object.fromEntries(ids.map(id => [id, nameOf(id)])), { cafe: !still }))}`);
  if (!still) ids.forEach((id, i) => { const [x, y] = HUDDLE_SPOTS[i % HUDDLE_SPOTS.length]; const s = sims.get(id); s.carry = null; goTo(s, x, y, "talk"); });
  else beginTalk();
}
function beginTalk() {
  const tl = sceneTimeline(scene.lines, scene.ids);
  scene.phase = "talk"; scene.talkAt = scene.clock; scene.steps = tl.steps; scene.next = 0;
  scene.endAt = sceneEndAt(scene.talkAt, tl.end, scene.solo);
}
function endScene(replan = true) {
  if (!scene) return;
  lounge.maxOnBreak = scene.maxOnBreak;
  for (const id of scene.ids) { const s = sims.get(id); if (s?.sceneBubble) { s.bubble.classList.remove("show"); s.bubbleUntil = 0; s.sceneBubble = false; } } // only bubbles the scene made
  scene = null;
  if (replan) plan(); // everyone walks home
}
setInterval(() => {
  if (document.hidden) { if (scene) scene.last = performance.now(); return; } // the scene clock pauses with the tab
  const now = performance.now();
  if (!scene) { startPendingScene(); return; }
  scene.clock += now - scene.last; scene.last = now;
  if (scene.phase === "gather" && (scene.clock > 12000 || scene.ids.every(id => !sims.get(id)?.path.length))) beginTalk();
  if (scene.phase === "talk") {
    const t = scene.clock - scene.talkAt;
    while (scene.next < scene.steps.length && scene.steps[scene.next].at <= t) {
      const st = scene.steps[scene.next++];
      if (st.id && sims.has(st.id)) { say(st.id, st.text, st.ms); sims.get(st.id).sceneBubble = true; }
    }
    if (scene.clock >= scene.endAt) endScene(true);
  }
}, 250);
// ---------- Antics (idle, show-style bits) ----------
// Agents who aren't working pull pranks, visit each other's desks and make asides to the camera (see office-antics.js).
// Decorative like the lounge: never sets s.active, no network or LLM calls, nothing written to chat or history.
const antics = new Antics();
let antic = null;
const inAntic = id => !!antic && antic.bit.cast.includes(id);
function popGlyph(id, text) {
  const s = sims.get(id); if (!s) return;
  const el = document.createElement("span"); el.className = "glyph"; el.textContent = text;
  const [sx, sy] = iso(s.x, s.y); el.style.left = pct(sx, "x"); el.style.top = pct(sy - 78, "y");
  el.addEventListener("animationend", () => el.remove()); overlay.appendChild(el);
}
function startAntic(pick, now) {
  antic = { ...pick, next: 0, t0: null, startedAt: now };
  pick.bit.cast.forEach(id => lounge.preempt(id, now));
  if (pick.bit.emoji) popGlyph(pick.bit.cast[0], pick.bit.emoji);
  if (pick.bit.feed) logFeed("😂", esc(pick.bit.feed));
  const [visitor, host] = pick.visit || [];
  if (visitor && !reducedMotion.matches && sims.has(visitor) && HOME[host]) {
    const [hx, hy] = HOME[host];
    goTo(sims.get(visitor), hx + 0.9, hy, "talk"); // stand beside the host's desk
  } else antic.t0 = now;
}
function endAntic(replan = true) {
  if (!antic) return;
  for (const id of antic.bit.cast) { const s = sims.get(id); if (s?.anticBubble) { s.bubble.classList.remove("show"); s.bubbleUntil = 0; s.anticBubble = false; } }
  antic = null;
  if (replan) plan(); // visitors walk back to their desks
}
setInterval(() => {
  if (document.hidden || state.replaying) return;
  const now = performance.now();
  if (!antic) {
    if (scene || pendingScene) return;
    const agents = [...sims.values()].map(s => ({ id: s.m.id, idle: !s.active && !meetingState.ids.has(s.m.id) && !s.path.length && !lounge.onBreak(s.m.id) && !inScene(s.m.id) && now > s.bubbleUntil }));
    const pick = antics.tick(now, agents, { teamBusy: state.busy });
    if (pick) startAntic(pick, now);
    return;
  }
  if (antic.t0 === null) {
    const v = sims.get(antic.visit[0]);
    if (!v || !v.path.length || now - antic.startedAt > 9000) antic.t0 = now; // arrived (or gave up waiting)
    else return;
  }
  const t = now - antic.t0;
  while (antic.next < antic.steps.length && antic.steps[antic.next].at <= t) {
    const st = antic.steps[antic.next++];
    if (sims.has(st.id)) { say(st.id, st.text, st.ms); sims.get(st.id).anticBubble = true; }
  }
  if (t >= antic.total + 1200) endAntic(true);
}, 400);

// Idle life: occasional, capacity-limited Café/couch breaks (see office-lounge.js). Paused while the tab is hidden.
const loungeAgents = () => [...sims.values()].map(s => ({ id: s.m.id, working: s.active || meetingState.ids.has(s.m.id) || inScene(s.m.id) || inAntic(s.m.id), walking: s.path.length > 0 }));
function applyLounge(cmds) {
  for (const c of cmds) {
    const s = sims.get(c.id); if (!s) continue;
    if (c.type === "go") {
      s.carry = c.carry || null;
      goTo(s, c.spot.x, c.spot.y, c.pose);
      const lines = BREAK_LINES[c.pose];
      if (lines && !s.active) say(c.id, lines[Math.floor(Math.random() * lines.length)], 2400);
    } else s.carry = null;
  }
  if (cmds.some(c => c.type === "end")) plan(); // ended breaks head back to their station
}
setInterval(() => {
  if (document.hidden) return;
  const now = performance.now(), agents = loungeAgents();
  applyLounge(lounge.tick(now, agents));
  for (const b of banter.tick(now, loungeAgents())) { const s = sims.get(b.id); if (s && !s.active) say(b.id, b.text, b.ms); }
}, 2500);
reducedMotion.addEventListener?.("change", e => { if (scene) endScene(false); lounge.setEnabled(!e.matches, performance.now()); banter.reset(); plan(); });
document.addEventListener("visibilitychange", () => document.body.classList.toggle("tab-hidden", document.hidden));

// Chatter: working agents occasionally say what they're doing.
setInterval(() => {
  if (document.hidden) return;
  const now = performance.now();
  const speakers = [...sims.values()].filter(s => s.active && !s.path.length && now > s.bubbleUntil);
  if (!speakers.length) return;
  const s = speakers[Math.floor(Math.random() * speakers.length)];
  const lines = FLAVOR[s.m.id] || ["…"];
  let text = Math.random() < 0.45 && s.summary ? stripMeetingPrefix(s.summary) : lines[Math.floor(Math.random() * lines.length)];
  if (s.pose === "read" || state.studying.has(s.m.id)) text = STUDY_CHATTER[Math.floor(Math.random() * STUDY_CHATTER.length)]; // never echo the raw study brief
  if (s.m.id === "regional-manager" && ![...state.runs.values()].some(r => r.active.size) && state.leadText && Math.random() < 0.6) text = "…" + trim(state.leadText.slice(-80), 70);
  say(s.m.id, trim(text, 70), s.pose === "talk" ? 3200 : 2600);
}, 1600);

// Little floating glyphs over busy heads.
setInterval(() => {
  if (document.hidden) return;
  for (const s of sims.values()) {
    if (s.path.length || Math.random() < 0.35) continue;
    const opts = s.active ? GLYPHS[s.pose] : (lounge.onBreak(s.m.id) ? BREAK_GLYPHS[s.pose] : null); if (!opts) continue;
    const el = document.createElement("span");
    el.className = "glyph"; el.textContent = opts[Math.floor(Math.random() * opts.length)];
    const [sx, sy] = iso(s.x, s.y);
    el.style.left = pct(sx + (Math.random() * 30 - 15), "x"); el.style.top = pct(sy - 70, "y");
    el.addEventListener("animationend", () => el.remove());
    overlay.appendChild(el);
  }
}, 700);

const pct = (v, axis) => axis === "x" ? `${((v - VB.x) / VB.w) * 100}%` : `${((v - VB.y) / VB.h) * 100}%`;

// ---------- Animation loop ----------
let last = performance.now(), lastOrder = "", ppBall = null, basketballShot = null;
function frame(now) {
  const dt = Math.min(1, (now - last) / 1000); last = now;
  const SPEED = 3.4;
  for (const s of sims.values()) {
    if (s.path.length) {
      const [tx, ty] = s.path[0];
      const dx = tx - s.x, dy = ty - s.y, dist = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (dist <= step) { s.x = tx; s.y = ty; s.path.shift(); if (!s.path.length) s.pose = s.nextPose || "idle"; }
      else { s.x += dx / dist * step; s.y += dy / dist * step; }
      const sdx = (dx - dy); if (Math.abs(sdx) > 0.01) s.facing = sdx > 0 ? 1 : -1;
    }
  }
  paint(now);
  requestAnimationFrame(frame);
}

// SVG nodes default to (0, 0). First paint must not depend on an animation callback,
// which an embedded, background or paused browser may defer indefinitely.
function paint(now) {
  for (const s of sims.values()) {
    const walking = s.path.length > 0;
    const cls = `sim pose-${walking ? "walk" : s.pose}${s.active ? " active" : ""}${s.carry ? ` carry-${s.carry}` : ""}`;
    if (s.g.getAttribute("class") !== cls) s.g.setAttribute("class", cls);
    const [sx, sy] = iso(s.x, s.y);
    const drop = !walking && (SIT_POSES.has(s.pose) || s.pose === "read") ? 7 : 0; // seated on a stool, bench or sofa
    s.g.setAttribute("transform", `translate(${sx.toFixed(1)},${(sy + drop).toFixed(1)})`);
    s.g.firstElementChild.setAttribute("transform", s.facing < 0 ? "scale(-1,1)" : "");
    s.g._depth = simDepth(s.x, s.y, depthBoxes);
    s.label.style.left = pct(sx, "x"); s.label.style.top = pct(sy + 4, "y");
    s.label.classList.toggle("on", s.active);
    s.gem.style.left = pct(sx, "x"); s.gem.style.top = pct(sy - 82, "y");
    s.gem.classList.toggle("show", s.active);
    s.bubble.style.left = pct(sx, "x"); s.bubble.style.top = pct(sy - (s.active ? 96 : 80), "y");
    if (s.bubbleUntil && now > s.bubbleUntil) { s.bubble.classList.remove("show"); s.bubbleUntil = 0; }
    s.label.style.zIndex = s.bubble.style.zIndex = Math.round(s.g._depth * 10);
  }
  // Ping-pong ball: visible and bouncing only while a player stands at the table.
  ppBall ||= document.querySelector(".pp-ball");
  if (ppBall) {
    const playing = [...sims.values()].some(s => s.pose === "pingpong" && !s.path.length);
    if (ppBall.classList.contains("on") !== playing) ppBall.classList.toggle("on", playing);
  }
  basketballShot ||= document.querySelector(".basketball-shot");
  if (basketballShot) {
    const shooting = [...sims.values()].some(s => !s.active && s.pose === "shoot" && !s.path.length && lounge.onBreak(s.m.id));
    if (basketballShot.classList.contains("on") !== shooting) basketballShot.classList.toggle("on", shooting);
  }
  // Painter's algorithm: re-order only when the order actually changes.
  const layer = $("#layer");
  const kids = [...layer.children].sort((a, b) => a._depth - b._depth);
  const order = kids.map(k => k._uid).join("|");
  if (order !== lastOrder) { for (const k of kids) layer.appendChild(k); lastOrder = order; }
}

// ---------- Live stream ----------
async function connectLive() {
  try {
    const res = await fetch("/api/live", { headers: { "X-DM-Token": TOKEN } });
    if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === "ping") continue;
        if (ev.t === "snapshot") {
          if (Array.isArray(ev.activeRuns)) {
            const known = new Set(ev.activeRuns.map(r => r.runId));
            for (const key of [...state.runs.keys()]) {
              if (!known.has(key) && !(state.source === "demo" && key === DEMO_RUN)) state.runs.delete(key); // the server knows nothing about the local demo
            }
            for (const run of ev.activeRuns) {
              state.runs.set(run.runId, makeRun(true));
            }
            state.busy = [...state.runs.values()].some(r => r.busy);
          }
          if ((ev.events || []).length) {
            stopDemo();
            state.source = "live";
            state.replaying = true; // history replay must never stage a Café scene
            try { for (const e of ev.events) onEvent(e); } finally { state.replaying = false; }
          } else if (ev.busy) {
            stopDemo();
            state.source = "live";
          }
          for (const run of state.runs.values()) run.observed = false;
          plan(); // Reconcile once, not through every stale intermediate target in the replay.
          continue;
        }
        if (ev.t === "feedback") { onFeedback(ev); continue; }
        if (ev.t === "start") { stopDemo(); state.source = "live"; }
        if (state.source === "live") onEvent(ev);
      }
    }
  } catch { /* retry below */ }
  setTimeout(connectLive, 2000);
}

// ---------- Demo (no Copilot requests are used) ----------
const DEMO_RUN = "global"; // demo events carry no runId
const DEMO = [
  [0.0, { t: "start" }],
  [2.0, { t: "delegate", callId: "d1", agent: "sales-lead", summary: "Paper customer discovery and sales angle" }],
  [2.6, { t: "delegate", callId: "d2", agent: "account-strategist", summary: "Customer-friendly pitch" }],
  [3.2, { t: "delegate", callId: "d3", agent: "office-administrator", summary: "Reception handoff and wording" }],
  [9.0, { t: "tool_end", callId: "d1", ok: true }], [9.5, { t: "tool_end", callId: "d2", ok: true }], [10.0, { t: "tool_end", callId: "d3", ok: true }],
  [11.0, { t: "delegate", callId: "d4", agent: "cloud-ai-architect", summary: "Infinity Azure architecture" }],
  [11.5, { t: "delegate", callId: "d5", agent: "automation-engineer", summary: "Warehouse workflow automation" }],
  [12.0, { t: "delegate", callId: "d6", agent: "product-manager", summary: "Infinity launch story" }],
  [20.0, { t: "tool_end", callId: "d4", ok: true }], [20.5, { t: "tool_end", callId: "d5", ok: true }], [21.0, { t: "tool_end", callId: "d6", ok: true }],
  [22.0, { t: "delegate", callId: "d7", agent: "qa-reviewer", summary: "Creed QA corner review" }],
  [22.5, { t: "delegate", callId: "d8", agent: "compliance-officer", summary: "Toby outbound compliance check" }],
  [28.0, { t: "tool_end", callId: "d7", ok: true }], [28.6, { t: "tool_end", callId: "d8", ok: true }],
  [30.0, { t: "delegate", callId: "m1", agent: "product-manager", summary: "Meeting: brainstorm launch ideas" }],
  [30.4, { t: "delegate", callId: "m2", agent: "presentation-designer", summary: "Meeting: pitch storyline" }],
  [30.8, { t: "delegate", callId: "m3", agent: "communications", summary: "Meeting: catchy campaign names" }],
  [31.2, { t: "delegate", callId: "m4", agent: "office-administrator", summary: "Meeting: take notes and actions" }],
  [31.6, { t: "delegate", callId: "m5", agent: "sales-lead", summary: "Meeting: customer reality check" }],
  [44.0, { t: "tool_end", callId: "m1", ok: true }], [44.3, { t: "tool_end", callId: "m2", ok: true }], [44.6, { t: "tool_end", callId: "m3", ok: true }],
  [44.9, { t: "tool_end", callId: "m4", ok: true }], [45.2, { t: "tool_end", callId: "m5", ok: true }],
  [46.5, { t: "end" }],
];
let demoTimers = [], demoStartedAt = null;
function stopDemo() {
  if (!demoTimers.length) return;
  demoTimers.forEach(clearTimeout); demoTimers = [];
  demoStartedAt = null;
  $("#demoBtn").textContent = "▶ Play demo";
  if (state.source === "demo") { state.source = "live"; onEvent({ t: "end" }); }
}
$("#demoBtn").addEventListener("click", async () => {
  if (demoTimers.length) return stopDemo();
  const st = await fetch("/api/status", { headers: { "X-DM-Token": TOKEN } }).then(r => r.json()).catch(() => ({}));
  if (st.busy) { logFeed("ℹ️", "The branch is working on a real request — the demo will wait."); return; }
  playDemo();
});
function playDemo(elapsed = 0) {
  state.source = "demo";
  demoStartedAt = performance.now() - elapsed;
  $("#demoBtn").textContent = "■ Stop demo";
  state.replaying = true;
  try { for (const [t, ev] of DEMO) if (t * 1000 < elapsed) onEvent(ev); }
  finally { state.replaying = false; }
  plan();
  demoTimers = DEMO.filter(([t]) => t * 1000 >= elapsed).map(([t, ev]) => setTimeout(() => {
    if (state.source !== "demo") return;
    onEvent(ev);
    if (ev.t === "end") { demoTimers = []; demoStartedAt = null; state.source = "live"; $("#demoBtn").textContent = "▶ Replay demo"; }
  }, t * 1000 - elapsed));
}

let continuityWarned = false;
function continuityError(error) {
  if (!continuityWarned) {
    console.warn("Office scene continuity unavailable:", error);
    logFeed("!", "Office positions could not be saved/restored in this tab. Browser storage may be unavailable.");
  }
  continuityWarned = true;
}
function saveOffice() {
  if (!sims.size) return;
  try {
    const now = performance.now();
    const saved = captureOffice({ sims, lounge, scene, antic, antics, banter }, now);
    saved.demoElapsed = demoStartedAt === null ? null : now - demoStartedAt;
    sessionStorage.setItem(OFFICE_STATE_KEY, JSON.stringify(saved));
  } catch (error) { continuityError(error); }
}
function resumeOffice() {
  try {
    const raw = sessionStorage.getItem(OFFICE_STATE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    ({ scene, antic } = restoreOffice(saved, { sims, lounge, antics, banter }, performance.now()));
    if (Number.isFinite(saved.demoElapsed) && saved.demoElapsed < 46500) {
      demoTimers.forEach(clearTimeout);
      demoTimers = [];
      playDemo(saved.demoElapsed);
    }
    return true;
  } catch (error) { continuityError(error); return false; }
}
addEventListener("pagehide", saveOffice);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveOffice(); });
// Save before link navigation too: pagehide may be delayed by a page's live stream.
document.addEventListener("click", event => { if (event.target.closest?.("nav a")) saveOffice(); }, true);

// ---------- Boot ----------
team = await fetch("/api/team", { headers: { "X-DM-Token": TOKEN } }).then(r => r.json());
await Promise.all(team.map(async m => { if (m.avatar) m.avatar = await officeAvatar(m.avatar); }));
createSims();
paint(performance.now());
const restored = resumeOffice();
paint(performance.now());
if (reducedMotion.matches) { if (scene) endScene(false); lounge.setEnabled(false, performance.now()); }
loadLearnedQuips();
loadDundies();
setInterval(loadDundies, 5 * 60_000);
if (!restored) plan();
setInterval(saveOffice, 2000);
last = performance.now();
frame(last);
addEventListener("pageshow", event => {
  if (!event.persisted) return;
  resumeOffice();
  last = performance.now();
  paint(last);
});
// Start the never-ending stream only after load, so the browser does not treat the page as still loading.
if (document.readyState === "complete") setTimeout(connectLive, 0); else addEventListener("load", () => setTimeout(connectLive, 0), { once: true });
if (!demoTimers.length && new URLSearchParams(location.search).has("demo")) $("#demoBtn").click();
