import { setThemeChoice, useTheme, type ThemeChoice } from '../lib/theme';

/** Sun/moon button: flips between light and dark from wherever you are. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolved } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setThemeChoice(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`rounded-lg p-2 ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {resolved === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match device' },
];

/** Three-way choice, including following the phone or computer's own setting. */
export function ThemePicker() {
  const { choice } = useTheme();
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex gap-1 rounded-lg bg-slate-200/70 p-0.5 text-sm sm:w-fit">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={choice === o.value}
          onClick={() => setThemeChoice(o.value)}
          className={`flex-1 rounded-md px-4 py-1.5 font-medium sm:flex-none ${choice === o.value ? 'bg-white shadow-sm' : 'text-slate-600'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
