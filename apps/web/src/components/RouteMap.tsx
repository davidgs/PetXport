import type { Leg } from '@petxport/shared';
import type { FeatureCollection } from 'geojson';
import type * as MapLibre from 'maplibre-gl';
import { maplibregl } from '../lib/maplibre';
import { useEffect, useRef } from 'react';
import { useTheme } from '../lib/theme';

const STYLES = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };
const COLORS = { light: ['#0f766e', '#7c3aed'], dark: ['#2dd4bf', '#c4b5fd'] };

interface Props {
  legs: Leg[];
  /** Drawn thicker and brighter; the map zooms to it. */
  highlightLegId?: string | null;
  /** When set, handoff pins can be dragged. index is the handoff's position (0 = end of leg 1). */
  onMoveHandoff?: (index: number, point: { lat: number; lng: number }) => void;
  showLocate?: boolean;
  /** Where the animal is right now on legs that are under way, as shared by their drivers. */
  live?: { legId: string; lat: number; lng: number; title: string }[];
  className?: string;
}

export function RouteMap({ legs, highlightLegId, onMoveHandoff, showLocate, live, className }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre.Map | null>(null);
  const markers = useRef<MapLibre.Marker[]>([]);
  const liveMarkers = useRef(new Map<string, MapLibre.Marker>());
  const fitted = useRef('');
  // The style JSON has arrived, so sources and layers can be added. (Waiting for the map's
  // 'load' event instead would also wait for every tile, which can take a long time.)
  const styleReady = useRef(false);
  const { resolved: theme } = useTheme();
  const onMove = useRef(onMoveHandoff);
  onMove.current = onMoveHandoff;

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: STYLES[theme], center: [-96, 38], zoom: 3, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    if (showLocate) {
      map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    }
    mapRef.current = map;
    fitted.current = '';
    styleReady.current = false;
    map.once('style.load', () => {
      styleReady.current = true;
    });
    return () => {
      liveMarkers.current.clear();
      map.remove();
      mapRef.current = null;
    };
    // The map is rebuilt when the theme changes, so it picks up the matching base map.
  }, [showLocate, theme]);

  const editable = Boolean(onMoveHandoff);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: legs.map((leg, i) => ({
          type: 'Feature',
          properties: { color: COLORS[theme][i % 2], highlight: leg.id === highlightLegId, dim: Boolean(highlightLegId) && leg.id !== highlightLegId },
          geometry: { type: 'LineString', coordinates: leg.geometry },
        })),
      };
      const source = map.getSource('legs') as MapLibre.GeoJSONSource | undefined;
      if (source) source.setData(data);
      else {
        map.addSource('legs', { type: 'geojson', data });
        map.addLayer({
          id: 'legs-casing',
          type: 'line',
          source: 'legs',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': theme === 'dark' ? '#0b1220' : '#ffffff', 'line-width': ['case', ['get', 'highlight'], 10, 7], 'line-opacity': 0.9 },
        });
        map.addLayer({
          id: 'legs-line',
          type: 'line',
          source: 'legs',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['get', 'highlight'], 6, 4],
            'line-opacity': ['case', ['get', 'dim'], 0.45, 1],
          },
        });
      }

      for (const m of markers.current) m.remove();
      markers.current = [];
      const addPin = (lngLat: [number, number], label: string, kind: string, title: string, handoffIndex?: number) => {
        const el = document.createElement('div');
        el.className = `pin ${kind}`;
        el.textContent = label;
        el.title = title;
        const draggable = editable && handoffIndex !== undefined;
        if (draggable) el.classList.add('pin-draggable');
        const marker = new maplibregl.Marker({ element: el, draggable }).setLngLat(lngLat).addTo(map);
        if (draggable) {
          marker.on('dragend', () => {
            const p = marker.getLngLat();
            onMove.current?.(handoffIndex, { lat: p.lat, lng: p.lng });
          });
        }
        markers.current.push(marker);
      };
      legs.forEach((leg, i) => {
        if (i === 0) addPin([leg.start.lng, leg.start.lat], 'A', 'pin-start', `Start: ${leg.start.name}`);
        if (i === legs.length - 1) addPin([leg.end.lng, leg.end.lat], 'B', 'pin-end', `Destination: ${leg.end.name}`);
        else addPin([leg.end.lng, leg.end.lat], String(i + 1), '', `Handoff ${i + 1}: ${leg.end.name}`, i);
      });

      const target = legs.find((l) => l.id === highlightLegId);
      const fitKey = `${highlightLegId ?? ''}|${legs.length}|${legs[0]?.start.lat},${legs[legs.length - 1]?.end.lat}`;
      if (legs.length > 0 && fitKey !== fitted.current) {
        fitted.current = fitKey;
        const bounds = new maplibregl.LngLatBounds();
        for (const leg of target ? [target] : legs) for (const c of leg.geometry) bounds.extend(c);
        map.fitBounds(bounds, { padding: 48, duration: 400, maxZoom: 13 });
      }
    };
    if (styleReady.current) draw();
    else map.once('style.load', draw);
    return () => {
      map.off('style.load', draw);
    };
  }, [legs, highlightLegId, editable, theme]);

  // Kept apart from the route drawing above, so a moving dot does not redraw the whole map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const p of live ?? []) {
      seen.add(p.legId);
      let marker = liveMarkers.current.get(p.legId);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'pin-live';
        el.innerHTML =
          '<svg viewBox="-17 -16 34 31" aria-hidden="true"><ellipse cx="0" cy="6" rx="9" ry="7.5"/><circle cx="-12" cy="-3" r="4"/><circle cx="-5" cy="-11" r="4.4"/><circle cx="5" cy="-11" r="4.4"/><circle cx="12" cy="-3" r="4"/></svg>';
        marker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
        liveMarkers.current.set(p.legId, marker);
      } else marker.setLngLat([p.lng, p.lat]);
      marker.getElement().title = p.title;
    }
    for (const [legId, marker] of liveMarkers.current) {
      if (!seen.has(legId)) {
        marker.remove();
        liveMarkers.current.delete(legId);
      }
    }
  }, [live, theme, showLocate]);

  return <div ref={container} className={className ?? 'h-72 w-full overflow-hidden rounded-xl ring-1 ring-slate-200 sm:h-96'} />;
}
