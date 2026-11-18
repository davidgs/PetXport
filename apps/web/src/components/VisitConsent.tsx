import { Link } from 'react-router';
import { counterApplies, setVisitChoice, useIsVisitor, useVisitChoice } from '../lib/analytics';

/**
 * The one-line question on public pages: may this visit be counted? Shown until answered,
 * and only where the counter would actually run. Nothing is loaded or stored before a "yes".
 */
export function VisitConsent() {
  const visitor = useIsVisitor();
  const choice = useVisitChoice();
  if (!visitor || choice !== null || !counterApplies()) return null;
  const button = 'rounded-md px-2.5 py-1 text-xs font-medium';
  return (
    <div
      role="region"
      aria-label="Visitor statistics"
      className="no-print fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-slate-200 bg-white px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-slate-600 shadow-[0_-1px_6px_rgba(0,0,0,0.06)]"
    >
      <span>
        May we count your visit? It uses a cookie.{' '}
        <Link to="/privacy#visitor-statistics" className="underline hover:text-slate-800">
          Details
        </Link>
      </span>
      <span className="flex gap-2">
        <button type="button" onClick={() => setVisitChoice('no')} className={`${button} text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50`}>
          No
        </button>
        <button type="button" onClick={() => setVisitChoice('yes')} className={`${button} bg-brand-700 text-white hover:bg-brand-800`}>
          OK
        </button>
      </span>
    </div>
  );
}
