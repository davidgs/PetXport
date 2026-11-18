import { useSyncExternalStore } from 'react';

/** 'system' follows the device's own light/dark setting. */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'petxport-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

export function getThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be unavailable (private browsing); fall through to the device setting.
  }
  return 'system';
}

const resolve = (choice: ThemeChoice): 'light' | 'dark' => (choice === 'system' ? (media.matches ? 'dark' : 'light') : choice);

/** Keep in step with public/theme-init.js, which does the same before first paint. */
function apply(): void {
  const dark = resolve(getThemeChoice()) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#0f766e');
  for (const listener of listeners) listener();
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not saved, but still applied for this visit.
    document.documentElement.classList.toggle('dark', resolve(choice) === 'dark');
  }
  apply();
}

media.addEventListener('change', apply);
// Another tab changed the setting.
window.addEventListener('storage', (e) => e.key === KEY && apply());

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The saved choice, and what is actually showing right now. */
export function useTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark' } {
  const snapshot = useSyncExternalStore(subscribe, () => `${getThemeChoice()}|${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}`);
  const [choice, resolved] = snapshot.split('|') as [ThemeChoice, 'light' | 'dark'];
  return { choice, resolved };
}
