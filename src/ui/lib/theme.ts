export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "postbox:theme";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* private mode */
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
}
