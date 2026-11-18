import { STOP_CATEGORIES, STOP_CATEGORY_LABELS, haversineM, miles, type Leg, type Place, type Stop, type StopCategory } from '@petxport/shared';
import type { FeatureCollection } from 'geojson';
import type * as MapLibre from 'maplibre-gl';
import { maplibregl } from '../lib/maplibre';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, useOrgPath } from '../lib/api';
import { PlaceSearch } from './PlaceSearch';
import { Button, Field, Input } from './ui';

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
/** Below this zoom the visible area is too large to list every gas station and restaurant in it. */
const MIN_STOPS_ZOOM = 11;
const MAX_MARKERS = 150;

/** How the map tiles label a place (OpenStreetMap's own value) → our categories. */
const TILE_SUBCLASS: Record<string, StopCategory> = {
  fuel: 'fuel',
  hotel: 'lodging',
  motel: 'lodging',
  restaurant: 'food',
  fast_food: 'food',
  cafe: 'food',
  supermarket: 'shopping',
  mall: 'shopping',
  department_store: 'shopping',
};

/**
 * Places already present in the map tiles on screen. This needs no extra
 * service, so it keeps working when the lookup service is busy; it only has
 * data once the map is zoomed in close.
 */
function stopsFromTiles(map: MapLibre.Map): Stop[] {
  if (!map.getSource('openmaptiles')) return [];
  const bounds = map.getBounds();
  const seen = new Map<string, Stop>();
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' })) {
    const props = f.properties as { name?: string; subclass?: string; class?: string };
    const category = TILE_SUBCLASS[props.subclass ?? ''] ?? TILE_SUBCLASS[props.class ?? ''];
    if (!category || !props.name || f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    if (!bounds.contains([lng, lat])) continue;
    const id = `tile/${category}/${props.name}/${lng.toFixed(4)},${lat.toFixed(4)}`;
    seen.set(id, { id, name: props.name, category, lat, lng, address: null });
  }
  return [...seen.values()];
}

/** Lookup-service results first (they carry addresses), plus any tile places they do not already cover. */
function mergeStops(looked: Stop[], fromTiles: Stop[]): Stop[] {
  const extra = fromTiles.filter((t) => !looked.some((l) => l.category === t.category && haversineM(l, t) < 80));
  return [...looked, ...extra];
}

const ICONS: Record<StopCategory, string> = { fuel: '⛽', rest_area: '🅿️', lodging: '🛏️', food: '🍴', shopping: '🛒' };

interface Choice {
  lat: number;
  lng: number;
  /** Set when a listed place was picked; a bare map click has none. */
  stopId: string | null;
}

/**
 * Full-screen map for choosing exactly where two drivers meet: zoom in, then
 * pick a gas station, rest area, hotel or restaurant, or click any spot.
 */
export function HandoffPicker({
  legs,
  index,
  onClose,
  onSave,
}: {
  legs: Leg[];
  /** Which handoff: 0 is the one between leg 1 and leg 2. */
  index: number;
  onClose: () => void;
  onSave: (place: Place) => Promise<void>;
}) {
  const { apiBase } = useOrgPath();
  const current = legs[index]!.end;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre.Map | null>(null);
  const stopMarkers = useRef<MapLibre.Marker[]>([]);
  const choiceMarker = useRef<MapLibre.Marker | null>(null);
  const markerClickedAt = useRef(0);
  const requestSeq = useRef(0);

  const [lookedUp, setLookedUp] = useState<Stop[]>([]);
  const [tileStops, setTileStops] = useState<Stop[]>([]);
  const stops = useMemo(() => mergeStops(lookedUp, tileStops), [lookedUp, tileStops]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'zoom' | 'error'>('idle');
  const [lookupError, setLookupError] = useState('');
  const [filters, setFilters] = useState<Set<StopCategory>>(() => new Set(STOP_CATEGORIES));
  const [choice, setChoice] = useState<Choice | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [jump, setJump] = useState<Place | null>(null);
  /** The name we last filled in ourselves; if the box still holds it, we may improve it. */
  const autoName = useRef('');
  const fillName = (value: string) => {
    autoName.current = value;
    setName(value);
  };

  // The two legs that meet at this handoff, for drawing and for "how far off the route" figures.
  const nearby = useMemo(() => [legs[index], legs[index + 1]].filter((l): l is Leg => Boolean(l)), [legs, index]);
  const routePoints = useMemo(() => nearby.flatMap((l) => l.geometry.filter((_, i) => i % 2 === 0)), [nearby]);
  const offRouteMiles = (p: { lat: number; lng: number }) => {
    let best = Infinity;
    for (const [lng, lat] of routePoints) {
      // Cheap pre-check before the exact distance.
      if (Math.abs(lat - p.lat) > 0.3 || Math.abs(lng - p.lng) > 0.4) continue;
      const d = haversineM(p, { lat, lng });
      if (d < best) best = d;
    }
    return miles(best);
  };

  const shown = useMemo(
    () =>
      stops
        .filter((s) => filters.has(s.category))
        .map((s) => ({ ...s, off: offRouteMiles(s) }))
        .sort((a, b) => a.off - b.off)
        .slice(0, MAX_MARKERS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stops, filters, routePoints],
  );

  const pickStop = (s: Stop, pan = false) => {
    setChoice({ lat: s.lat, lng: s.lng, stopId: s.id });
    fillName(s.address ? `${s.name}, ${s.address}` : s.name);
    if (pan) mapRef.current?.easeTo({ center: [s.lng, s.lat], zoom: Math.max(mapRef.current.getZoom(), 15) });
  };
  const pickStopRef = useRef(pickStop);
  pickStopRef.current = pickStop;

  // ----- map setup -----
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: STYLE, center: [current.lng, current.lat], zoom: 14, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    const here = document.createElement('div');
    here.className = 'pin';
    here.textContent = String(index + 1);
    here.title = `Current handoff: ${current.name}`;
    new maplibregl.Marker({ element: here }).setLngLat([current.lng, current.lat]).addTo(map);

    map.once('style.load', () => {
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: nearby.map((leg) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: leg.geometry } })),
      };
      map.addSource('route', { type: 'geojson', data });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f766e', 'line-width': 4, 'line-opacity': 0.75 } });
    });

    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      clearTimeout(timer);
      if (map.getZoom() < MIN_STOPS_ZOOM) {
        requestSeq.current++;
        setStatus('zoom');
        return;
      }
      timer = setTimeout(async () => {
        const mine = ++requestSeq.current;
        const b = map.getBounds();
        setStatus('loading');
        try {
          const params = new URLSearchParams({
            south: b.getSouth().toFixed(5),
            west: b.getWest().toFixed(5),
            north: b.getNorth().toFixed(5),
            east: b.getEast().toFixed(5),
          });
          const found = await api<Stop[]>(`${apiBase}/stops?${params}`);
          if (mine !== requestSeq.current) return;
          setLookedUp(found);
          setStatus('idle');
        } catch (err) {
          if (mine !== requestSeq.current) return;
          setLookupError(errorMessage(err));
          setStatus('error');
        }
      }, 500);
    };
    map.on('moveend', load);
    load();

    // Once the visible tiles have arrived, list the places they contain.
    map.on('idle', () => {
      const found = stopsFromTiles(map);
      setTileStops((old) => (old.length === found.length && old.every((o, i) => o.id === found[i]!.id) ? old : found));
    });

    map.on('click', (e) => {
      // A click on a place marker also reaches the map; ignore that one.
      if (Date.now() - markerClickedAt.current < 250) return;
      setChoice({ lat: e.lngLat.lat, lng: e.lngLat.lng, stopId: null });
      autoName.current = '';
      setName('');
    });

    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- place markers -----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of stopMarkers.current) m.remove();
    stopMarkers.current = shown.map((s) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `stop-pin${choice?.stopId === s.id ? ' stop-pin-selected' : ''}`;
      el.textContent = ICONS[s.category];
      el.title = s.name;
      el.setAttribute('aria-label', `${s.name}, ${STOP_CATEGORY_LABELS[s.category]}`);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        markerClickedAt.current = Date.now();
        pickStopRef.current(s);
      });
      return new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
    });
  }, [shown, choice?.stopId]);

  // ----- the chosen spot -----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    choiceMarker.current?.remove();
    choiceMarker.current = null;
    if (!choice) return;
    const marker = new maplibregl.Marker({ color: '#e11d48', draggable: true }).setLngLat([choice.lng, choice.lat]).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      setChoice({ lat: p.lat, lng: p.lng, stopId: null });
    });
    choiceMarker.current = marker;
  }, [choice]);

  // Add the town to a name that lacks one ("Cracker Barrel" → "Cracker Barrel, Linthicum Heights, MD"),
  // unless the coordinator has typed something of their own in the meantime.
  useEffect(() => {
    if (!choice) return;
    const base = autoName.current;
    if (base.includes(',')) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { label } = await api<{ label: string | null }>(`${apiBase}/reverse-geocode?lat=${choice.lat.toFixed(5)}&lng=${choice.lng.toFixed(5)}`);
        if (cancelled || !label) return;
        setName((now) => {
          if (now !== base) return now;
          const better = base ? `${base}, ${label}` : `Near ${label}`;
          autoName.current = better;
          return better;
        });
      } catch {
        // The name stays as it is; the server fills in an empty one when saving.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [choice, apiBase]);

  useEffect(() => {
    if (jump) mapRef.current?.flyTo({ center: [jump.lng, jump.lat], zoom: 14 });
  }, [jump]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!choice) return;
    setSaving(true);
    setSaveError('');
    try {
      // An empty name is filled in by the server with the nearest town.
      await onSave({ name: name.trim(), lat: choice.lat, lng: choice.lng });
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaving(false);
    }
  };

  const toggle = (c: StopCategory) =>
    setFilters((old) => {
      const next = new Set(old);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const chosenOff = choice ? offRouteMiles(choice) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" aria-label={`Choose the handoff place after leg ${index + 1}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">Handoff after leg {index + 1}</h2>
          <p className="truncate text-xs text-slate-500">Now: {current.name}</p>
        </div>
        <Button variant="ghost" small onClick={onClose}>
          Cancel
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[45vh] shrink-0 lg:h-auto lg:flex-1">
          <div className="absolute inset-0">
            {/* MapLibre's stylesheet sets position: relative on the map element, so the sizing box is this wrapper. */}
            <div ref={container} className="h-full w-full" />
          </div>
          <div className="pointer-events-none absolute left-2 top-2 right-14 flex flex-wrap gap-1.5">
            {STOP_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={filters.has(c)}
                onClick={() => toggle(c)}
                className={`pointer-events-auto rounded-full px-2.5 py-1 text-xs font-medium shadow ring-1 ${filters.has(c) ? 'bg-brand-700 text-white ring-brand-800' : 'bg-white text-slate-600 ring-slate-300'}`}
              >
                {ICONS[c]} {STOP_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          {status !== 'idle' && !(status === 'loading' && shown.length > 0) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-4">
              <span className={`rounded-full px-3 py-1.5 text-center text-xs font-medium shadow ${status === 'error' ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200' : 'bg-slate-900/85 text-white'}`}>
                {status === 'loading' && 'Looking for places…'}
                {status === 'zoom' && 'Zoom in to see gas stations, rest areas, hotels and restaurants'}
                {status === 'error' && (shown.length > 0 ? 'Showing places from the map only; rest areas may be missing. Move the map to retry.' : lookupError)}
              </span>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 lg:w-96 lg:flex-none lg:border-l lg:border-t-0">
          <div className="space-y-3 border-b border-slate-200 p-4">
            <p className="text-sm text-slate-600">
              Zoom in and tap a place, or tap anywhere on the map (a particular corner of a car park, say). Drag the red pin to fine-tune.
            </p>
            <Field label="Jump to a town or address">
              <PlaceSearch value={jump} onChange={setJump} placeholder="South Hill, VA" />
            </Field>
          </div>

          <ul className="min-h-24 flex-1 divide-y divide-slate-100 overflow-y-auto">
            {status !== 'zoom' && status !== 'loading' && shown.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-500">No matching places in this part of the map. Zoom in closer or move the map, or tap any spot to use it.</li>
            )}
            {status !== 'zoom' &&
              shown.slice(0, 60).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => pickStop(s, true)}
                    className={`flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 ${choice?.stopId === s.id ? 'bg-brand-50' : ''}`}
                  >
                    <span aria-hidden className="mt-0.5 text-lg leading-none">
                      {ICONS[s.category]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.name}</span>
                      <span className="block truncate text-xs text-slate-500">{s.address ?? STOP_CATEGORY_LABELS[s.category]}</span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{s.off < 0.1 ? 'on route' : `${s.off.toFixed(1)} mi off`}</span>
                  </button>
                </li>
              ))}
          </ul>

          <div className="space-y-3 border-t border-slate-200 bg-slate-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {choice ? (
              <>
                <Field
                  label="Name shown to drivers"
                  hint={`${chosenOff != null && chosenOff >= 0.1 ? `About ${chosenOff.toFixed(1)} miles off the current route. ` : ''}Add detail drivers will need, such as “by the air pump”.`}
                >
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={300} placeholder="Leave empty to name it after the nearest town" />
                </Field>
                {saveError && <p className="text-sm text-rose-700">{saveError}</p>}
                <Button className="w-full" disabled={saving} onClick={save}>
                  {saving ? 'Re-routing…' : 'Use this place'}
                </Button>
              </>
            ) : (
              <p className="text-center text-sm text-slate-500">Nothing chosen yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
