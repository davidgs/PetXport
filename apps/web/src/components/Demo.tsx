import { useEffect, useState } from 'react';

/**
 * An animated walk-through of planning one transport, drawn rather than recorded so it stays
 * sharp at any size, follows light and dark mode, and weighs almost nothing.
 *
 * Everything on screen is a function of two numbers: `step` (which scene) and, in the last
 * scene, `pos` (how far the pet has travelled). CSS transitions do the motion, so pausing,
 * jumping to a step and reduced-motion all fall out of the same state.
 *
 * The trip is an illustration: the towns are real and roughly 100 miles apart, but the
 * people and the pet are made up.
 */

const PLACES = [
  { name: 'Charlotte, NC', x: 62, y: 246 },
  { name: 'Greensboro, NC', x: 138, y: 192 },
  { name: 'South Hill, VA', x: 222, y: 152 },
  { name: 'Richmond, VA', x: 288, y: 98 },
  { name: 'Washington, DC', x: 338, y: 44 },
] as const;

const LEGS = [
  { driver: 'Maria', leaves: '8:00 am' },
  { driver: 'James', leaves: '9:50 am' },
  { driver: 'Priya', leaves: '11:40 am' },
  { driver: 'Tom', leaves: '1:30 pm' },
] as const;

const STEPS = [
  { title: 'Start and finish', text: 'Tell PetXport where the pet is picked up, where it is going, and when it leaves.', ms: 3200 },
  { title: 'Find the route', text: 'It works out the driving route for the whole trip.', ms: 3200 },
  { title: 'Split into legs', text: 'The route is cut into legs of about 100 miles, each ending at a place where two drivers can meet.', ms: 4200 },
  { title: 'Ask for volunteers', text: 'Drivers near each leg get a notice and offer to take it. You confirm who drives.', ms: 5200 },
  { title: 'On the day', text: 'Everyone has the itinerary, a reminder, and a group chat. Each driver marks their hand-off as they go.', ms: 7500 },
] as const;

const ease = 'transition-all duration-700 ease-out motion-reduce:transition-none';

export function Demo() {
  const [step, setStep] = useState(0);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Move to the next scene, and start over after the last one.
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEPS[step]!.ms);
    return () => clearTimeout(t);
  }, [step, playing]);

  // In the last scene the pet travels one leg at a time.
  useEffect(() => {
    if (step < 4) return setPos(0);
    if (!playing || pos >= LEGS.length) return;
    const t = setTimeout(() => setPos((p) => p + 1), pos === 0 ? 900 : 1300);
    return () => clearTimeout(t);
  }, [step, pos, playing]);

  const go = (s: number) => {
    setStep(s);
    setPos(0);
  };
  const pet = PLACES[Math.min(pos, PLACES.length - 1)]!;
  const status = step < 3 ? 'Draft' : step === 3 ? 'Drivers needed' : pos >= LEGS.length ? 'Done' : 'On the road';

  return (
    <figure className="overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ring-slate-200" aria-label="Animated example of planning a transport">
      {/* Title bar, as on a transport's page in the app */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">Biscuit to her new home</p>
          <p className="truncate text-xs text-slate-500">Charlotte, NC → Washington, DC · Saturday</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${ease} ${
            step < 3 ? 'bg-slate-100 text-slate-600' : step === 3 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
          }`}
        >
          {status}
        </span>
      </div>

      <div className="grid sm:grid-cols-5">
        {/* The map */}
        <div className="sm:col-span-3">
          <svg viewBox="0 0 400 290" className="block h-auto w-full" role="img" aria-label="Map of the route with its hand-off places">
            <rect width="400" height="290" className="fill-slate-100" />
            {/* Countryside: a river and a few other roads, so it reads as a map */}
            <path d="M-10 70 C 60 90, 90 40, 170 60 S 300 150, 410 120" className="fill-none stroke-sky-100" strokeWidth="10" strokeLinecap="round" />
            <g className="fill-none stroke-slate-200" strokeWidth="3" strokeLinecap="round">
              <path d="M0 200 C 80 180, 150 250, 250 230 S 360 200, 400 220" />
              <path d="M120 0 C 110 80, 180 120, 170 290" />
              <path d="M300 0 C 320 90, 250 170, 330 290" />
              <path d="M0 110 C 90 130, 200 90, 400 20" />
            </g>

            {/* The route, one piece per leg */}
            {LEGS.map((_, i) => {
              const a = PLACES[i]!;
              const b = PLACES[i + 1]!;
              const done = step === 4 && pos > i;
              return (
                <g key={i}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="white" strokeWidth="9" strokeLinecap="round" opacity={step >= 1 ? 0.9 : 0} className={ease} />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    pathLength={1}
                    strokeDasharray={1}
                    strokeDashoffset={step >= 1 ? 0 : 1}
                    strokeWidth="5"
                    strokeLinecap="round"
                    style={{ transitionDelay: step === 1 ? `${i * 450}ms` : '0ms' }}
                    className={`${ease} ${done ? 'stroke-emerald-600' : step >= 3 ? 'stroke-brand-600' : 'stroke-slate-500'}`}
                  />
                </g>
              );
            })}

            {/* Who is driving each leg */}
            {LEGS.map((leg, i) => {
              const a = PLACES[i]!;
              const b = PLACES[i + 1]!;
              const show = step >= 3;
              // Name tags sit on the opposite side of the road from the town names.
              const width = leg.driver.length * 6.4 + 26;
              const at = i < 2 ? { x: (a.x + b.x) / 2 - width - 8, y: (a.y + b.y) / 2 - 16 } : { x: (a.x + b.x) / 2 + 18, y: (a.y + b.y) / 2 + 16 };
              return (
                <g
                  key={leg.driver}
                  transform={`translate(${at.x} ${at.y})`}
                  opacity={show ? 1 : 0}
                  style={{ transitionDelay: step === 3 ? `${700 + i * 800}ms` : '0ms' }}
                  className={ease}
                >
                  <rect x="-4" y="-11" width={width} height="20" rx="10" className="fill-brand-700" />
                  <circle cx="7" cy="-1" r="6" fill="white" opacity="0.9" />
                  <text x="7" y="2.5" textAnchor="middle" fontSize="8" fontWeight="700" className="fill-brand-700">
                    {leg.driver[0]}
                  </text>
                  <text x="17" y="3" fontSize="10" fontWeight="600" fill="white">
                    {leg.driver}
                  </text>
                </g>
              );
            })}

            {/* Start, hand-offs and finish */}
            {PLACES.map((p, i) => {
              const end = i === 0 || i === PLACES.length - 1;
              const show = end ? true : step >= 2;
              const left = i >= 3;
              return (
                <g key={p.name} opacity={show ? 1 : 0} style={{ transitionDelay: step === 2 && !end ? `${i * 350}ms` : '0ms' }} className={ease}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={show ? 10 : 2}
                    stroke="white"
                    strokeWidth="2.5"
                    style={{ transitionDelay: step === 2 && !end ? `${i * 350}ms` : '0ms' }}
                    className={`${ease} ${i === 0 ? 'fill-emerald-600' : i === PLACES.length - 1 ? 'fill-rose-600' : 'fill-slate-700'}`}
                  />
                  <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" className={end ? '' : 'fill-slate-50'} fill={end ? 'white' : undefined}>
                    {i === 0 ? 'A' : i === PLACES.length - 1 ? 'B' : i}
                  </text>
                  <text
                    x={left ? p.x - 15 : p.x + 14}
                    y={left ? p.y - 8 : p.y + 18}
                    textAnchor={left ? 'end' : 'start'}
                    fontSize="11"
                    fontWeight="600"
                    className="fill-slate-800"
                    style={{ paintOrder: 'stroke' }}
                    stroke="var(--color-slate-100)"
                    strokeWidth="3"
                  >
                    {p.name}
                  </text>
                </g>
              );
            })}

            {/* The pet, travelling */}
            <g
              style={{ transform: `translate(${pet.x}px, ${pet.y - 24}px)`, transitionDuration: '1200ms' }}
              opacity={step === 4 ? 1 : 0}
              className="transition-all ease-in-out motion-reduce:transition-none"
            >
              <circle r="13" className="fill-amber-100 stroke-amber-700" strokeWidth="1.5" />
              <text y="5" textAnchor="middle" fontSize="14">
                🐶
              </text>
            </g>
          </svg>
        </div>

        {/* The legs, as the coordinator sees them */}
        <div className="relative flex min-h-[15.5rem] flex-col gap-2 border-t border-slate-200 p-3 sm:col-span-2 sm:border-l sm:border-t-0">
          {/* Before there are legs: the few things a coordinator types in */}
          <div className={`absolute inset-0 space-y-2 p-3 ${ease} ${step < 2 ? 'opacity-100' : 'pointer-events-none opacity-0'}`} aria-hidden={step >= 2}>
            <p className="text-xs font-semibold text-slate-800">New transport</p>
            {[
              ['Pickup place', 'Charlotte, NC'],
              ['Destination', 'Washington, DC'],
              ['Leaves the pickup place at', 'Saturday, 8:00 am'],
              ['Who is travelling', 'Biscuit · beagle mix · medium'],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-[11px] text-slate-500">{label}</p>
                <p className="rounded-md px-2 py-1 text-xs text-slate-800 ring-1 ring-inset ring-slate-300">{value}</p>
              </div>
            ))}
            <p className={`rounded-md px-2 py-1.5 text-center text-xs font-medium text-white ${ease} ${step === 1 ? 'bg-brand-600' : 'bg-brand-700'}`}>
              {step === 1 ? 'Finding the route…' : 'Plan transport'}
            </p>
          </div>
          <ul className="space-y-1.5">
            {LEGS.map((leg, i) => {
              const shown = step >= 2;
              const hasDriver = step >= 3;
              const done = step === 4 && pos > i;
              const now = step === 4 && pos === i;
              return (
                <li
                  key={leg.driver}
                  style={{ transitionDelay: step === 2 ? `${300 + i * 350}ms` : '0ms' }}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 ring-1 ${ease} ${shown ? 'opacity-100' : 'translate-y-1 opacity-0'} ${
                    now ? 'bg-brand-50 ring-brand-200' : 'ring-slate-200'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-slate-800">
                      Leg {i + 1} · {PLACES[i]!.name.split(',')[0]} → {PLACES[i + 1]!.name.split(',')[0]}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      about 100 mi · leaves {leg.leaves}
                    </p>
                  </div>
                  <span
                    style={{ transitionDelay: step === 3 ? `${700 + i * 800}ms` : '0ms' }}
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ease} ${
                      done ? 'bg-emerald-100 text-emerald-800' : hasDriver ? 'bg-brand-100 text-brand-900' : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {done ? '✓ Done' : hasDriver ? leg.driver : 'Open'}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Group chat */}
          <div className={`mt-auto space-y-1.5 pt-1 ${ease} ${step === 4 ? 'opacity-100' : 'opacity-0'}`} aria-hidden={step !== 4}>
            <p className={`w-fit max-w-[92%] rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-1.5 text-xs text-slate-800 ${ease} ${pos >= 1 ? 'opacity-100' : 'translate-y-1 opacity-0'}`}>
              <span className="font-semibold">Maria:</span> At the gas station by the exit, blue Subaru.
            </p>
            <p className={`ml-auto w-fit max-w-[92%] rounded-2xl rounded-br-sm bg-brand-700 px-3 py-1.5 text-xs text-white ${ease} ${pos >= 2 ? 'opacity-100' : 'translate-y-1 opacity-0'}`}>
              <span className="font-semibold">James:</span> Got her! Heading north.
            </p>
          </div>
        </div>
      </div>

      {/* What is happening, and controls */}
      <figcaption className="border-t border-slate-200 bg-slate-50 px-4 py-3">
        <p className="min-h-[3.75rem] text-sm text-slate-700 sm:min-h-[2.5rem]" aria-live="polite">
          <span className="font-semibold text-slate-900">
            {step + 1}. {STEPS[step]!.title}.
          </span>{' '}
          {STEPS[step]!.text}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-slate-300 hover:bg-white"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <div className="flex flex-1 gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                type="button"
                onClick={() => go(i)}
                aria-label={`Step ${i + 1}: ${s.title}`}
                aria-current={i === step ? 'step' : undefined}
                className="group flex-1 py-2"
              >
                <span className={`block h-1.5 rounded-full ${ease} ${i === step ? 'bg-brand-600' : i < step ? 'bg-brand-200' : 'bg-slate-200 group-hover:bg-slate-300'}`} />
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400">Example</span>
        </div>
      </figcaption>
    </figure>
  );
}
