// Load before styles so a saved dark theme is applied before the first paint.
(() => {
  const key = "dm.theme";
  let saved = "light", storage;
  try { storage = localStorage; saved = storage.getItem(key); }
  catch (error) { console.warn("Theme preference could not be read:", error); }

  function apply(value) {
    const dark = value === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("themeToggle");
    if (button) {
      button.textContent = dark ? "Theme: Dark" : "Theme: Light";
      button.setAttribute("aria-pressed", String(dark));
      button.title = `Switch to ${dark ? "light" : "dark"} theme`;
    }
  }
  apply(saved);
  document.addEventListener("DOMContentLoaded", () => {
    apply(document.documentElement.dataset.theme);
    document.getElementById("themeToggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      apply(next);
      try { storage.setItem(key, next); }
      catch (error) {
        console.warn("Theme preference could not be saved:", error);
        document.getElementById("themeToggle").title += " (preference could not be saved)";
      }
    });
  }, { once: true });
  addEventListener("storage", event => {
    if (event.storageArea === storage && (event.key === key || event.key === null)) apply(event.newValue);
  });
})();
