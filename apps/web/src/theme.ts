// Theme is toggled (not OS-driven) and persisted, per the redesign handoff:
// body[data-theme="dark"|"light"]. Default dark.
export type Theme = "dark" | "light";

const KEY = "foreman-theme";

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* private mode / blocked storage */ }
  return "dark";
}

export function applyTheme(t: Theme): void {
  document.body.dataset.theme = t;
}

export function initTheme(): void {
  applyTheme(getTheme());
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  applyTheme(next);
  return next;
}
