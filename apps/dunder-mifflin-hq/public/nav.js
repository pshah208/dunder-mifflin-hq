// Shared by every HQ page: keep this window's current conversation across Chat / Org chart / Office.
import { initWindowScope, getWindowSession, setWindowSession, withSession } from "./ui-logic.js";

initWindowScope(sessionStorage, window);

export function updateNavLinks(id = getWindowSession(sessionStorage)) {
  document.querySelectorAll('nav a[href="/"], nav a[href^="/?"], nav a[href="/team.html"], nav a[href^="/team.html?"], nav a[href="/office.html"], nav a[href^="/office.html?"], nav a[href="/automations.html"], nav a[href^="/automations.html?"]').forEach(a => {
    if (!a.dataset.ppBase) a.dataset.ppBase = a.getAttribute("href").split("?")[0];
    a.setAttribute("href", withSession(a.dataset.ppBase, id));
  });
}

// An explicit ?session= on any page becomes this window's current conversation.
const explicit = new URL(location.href).searchParams.get("session");
if (explicit) setWindowSession(sessionStorage, explicit);
updateNavLinks();
addEventListener("pageshow", () => updateNavLinks());
