import type { Place } from '@petxport/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useOrgPath } from '../lib/api';
import { Input } from './ui';

/** Address box that looks places up as you type and returns one with coordinates. */
export function PlaceSearch({
  value,
  onChange,
  placeholder = 'City, address or place name',
  name,
  autoComplete = 'off',
}: {
  value: Place | null;
  onChange: (place: Place | null) => void;
  placeholder?: string;
  name?: string;
  /**
   * Browser autofill hint. Off by default because the browser's own suggestion list would sit on
   * top of the search results; a field for the person's own address turns it on.
   */
  autoComplete?: string;
}) {
  const { apiBase } = useOrgPath();
  const [text, setText] = useState(value?.name ?? '');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    setText(value?.name ?? '');
  }, [value?.name]);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 3 || q === value?.name) {
      setResults(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const found = await api<Place[]>(`${apiBase}/geocode?q=${encodeURIComponent(q)}`);
        if (mine === seq.current) setResults(found);
      } catch (err) {
        if (mine === seq.current) setError(errorMessage(err));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [text, value?.name, apiBase]);

  return (
    <div className="relative">
      <Input
        value={text}
        placeholder={placeholder}
        name={name}
        autoComplete={autoComplete}
        onChange={(e) => {
          setText(e.target.value);
          if (value) onChange(null);
        }}
      />
      {value && <span className="pointer-events-none absolute right-3 top-2.5 text-emerald-600" aria-label="Location found">✓</span>}
      {busy && <p className="mt-1 text-xs text-slate-500">Searching…</p>}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
      {results && !value && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-slate-200">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No matches. Try adding a city or state.</li>}
          {results.map((p, i) => (
            <li key={i}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-50"
                onClick={() => {
                  onChange(p);
                  setResults(null);
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
