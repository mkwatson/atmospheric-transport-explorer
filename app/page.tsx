"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type Point = {
  lat: number;
  lon: number;
  age: number;
  time: string;
  altitude: number;
  speed?: number;
  direction?: number;
};

type Track = {
  id: string;
  label: string;
  color: string;
  level: string;
  points: Point[];
  source: "computed" | "hysplit";
};

type Place = { name: string; lat: number; lon: number };

const PRESETS: Place[] = [
  { name: "San Francisco", lat: 37.775, lon: -122.419 },
  { name: "Los Angeles", lat: 34.052, lon: -118.244 },
  { name: "Denver", lat: 39.739, lon: -104.99 },
  { name: "Chicago", lat: 41.878, lon: -87.63 },
  { name: "New York", lat: 40.713, lon: -74.006 },
];

const LEVELS = [
  { id: "1000hPa", label: "Near surface", altitude: 110, color: "#78f0c4" },
  { id: "950hPa", label: "Lower atmosphere", altitude: 500, color: "#ffc968" },
  { id: "850hPa", label: "Elevated layer", altitude: 1500, color: "#f28cff" },
];

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function destination(lat: number, lon: number, bearing: number, distanceKm: number) {
  const radius = 6371;
  const delta = distanceKm / radius;
  const theta = (bearing * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return {
    lat: (phi2 * 180) / Math.PI,
    lon: ((((lambda2 * 180) / Math.PI + 540) % 360) - 180),
  };
}

function closestIndex(times: string[], target: Date) {
  let best = 0;
  let distance = Infinity;
  times.forEach((time, index) => {
    const delta = Math.abs(new Date(`${time}Z`).getTime() - target.getTime());
    if (delta < distance) {
      distance = delta;
      best = index;
    }
  });
  return best;
}

async function windAt(lat: number, lon: number, level: string, at: Date, signal: AbortSignal) {
  const key = `ate:${level}:${lat.toFixed(2)}:${lon.toFixed(2)}:${at.toISOString().slice(0, 13)}`;
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached) as { speed: number; direction: number; altitude: number };

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: `wind_speed_${level},wind_direction_${level},geopotential_height_${level}`,
    wind_speed_unit: "ms",
    past_days: "4",
    forecast_days: "2",
    timezone: "UTC",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal });
  if (!response.ok) throw new Error(`Weather service returned ${response.status}`);
  const data = await response.json();
  const index = closestIndex(data.hourly.time, at);
  const value = {
    speed: data.hourly[`wind_speed_${level}`][index],
    direction: data.hourly[`wind_direction_${level}`][index],
    altitude: data.hourly[`geopotential_height_${level}`][index],
  };
  sessionStorage.setItem(key, JSON.stringify(value));
  return value;
}

async function computeTrack(
  arrival: Place,
  duration: number,
  level: (typeof LEVELS)[number],
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  const stepHours = 3;
  const steps = duration / stepHours;
  const arrivalTime = new Date();
  arrivalTime.setUTCMinutes(0, 0, 0);
  let lat = arrival.lat;
  let lon = arrival.lon;
  const points: Point[] = [
    { lat, lon, age: 0, time: arrivalTime.toISOString(), altitude: level.altitude },
  ];

  for (let step = 1; step <= steps; step += 1) {
    const time = new Date(arrivalTime.getTime() - (step - 1) * stepHours * 3_600_000);
    const wind = await windAt(lat, lon, level.id, time, signal);
    // Meteorological direction points toward the source. Moving backward follows that bearing.
    const next = destination(lat, lon, wind.direction, wind.speed * stepHours * 3.6);
    lat = next.lat;
    lon = next.lon;
    points.push({
      lat,
      lon,
      age: -step * stepHours,
      time: new Date(arrivalTime.getTime() - step * stepHours * 3_600_000).toISOString(),
      altitude: wind.altitude || level.altitude,
      speed: wind.speed,
      direction: wind.direction,
    });
    progress(step / steps);
  }

  return {
    id: level.id,
    label: level.label,
    color: level.color,
    level: level.id,
    points,
    source: "computed" as const,
  };
}

function trackGeoJSON(tracks: Track[], visibleHours: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  tracks.forEach((track) => {
    const points = track.points.filter((point) => Math.abs(point.age) <= visibleHours);
    if (points.length > 1) {
      features.push({
        type: "Feature",
        properties: { color: track.color, id: track.id },
        geometry: { type: "LineString", coordinates: points.map((point) => [point.lon, point.lat]) },
      });
    }
    points.forEach((point, index) => {
      if (index === 0 || index === points.length - 1 || index % 4 === 0) {
        features.push({
          type: "Feature",
          properties: { color: track.color, age: point.age, label: track.label },
          geometry: { type: "Point", coordinates: [point.lon, point.lat] },
        });
      }
    });
  });
  return { type: "FeatureCollection", features };
}

function parseHysplit(text: string): Track[] {
  const groups = new Map<string, Point[]>();
  text.split(/\r?\n/).forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 12 || !parts.slice(0, 12).every((value) => Number.isFinite(Number(value)))) return;
    const lat = Number(parts[9]);
    const lon = Number(parts[10]);
    const altitude = Number(parts[11]);
    const age = Number(parts[8]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const year = Number(parts[2]) + (Number(parts[2]) < 70 ? 2000 : 1900);
    const time = new Date(Date.UTC(year, Number(parts[3]) - 1, Number(parts[4]), Number(parts[5]), Number(parts[6])));
    const id = parts[0];
    const list = groups.get(id) ?? [];
    list.push({ lat, lon, altitude, age, time: time.toISOString() });
    groups.set(id, list);
  });
  const colors = ["#78f0c4", "#ffc968", "#f28cff", "#7bb8ff"];
  return [...groups.entries()].map(([id, points], index) => ({
    id: `hysplit-${id}`,
    label: `HYSPLIT trajectory ${id}`,
    color: colors[index % colors.length],
    level: "Imported",
    points,
    source: "hysplit",
  }));
}

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(3)}°${value >= 0 ? positive : negative}`;
}

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [place, setPlace] = useState<Place>(() => {
    if (typeof window === "undefined") return PRESETS[0];
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lon = Number(params.get("lon"));
    return Number.isFinite(lat) && Number.isFinite(lon)
      ? { name: "Shared location", lat, lon }
      : PRESETS[0];
  });
  const initialPlaceRef = useRef(place);
  const [duration, setDuration] = useState(() => {
    if (typeof window === "undefined") return 72;
    const hours = Number(new URLSearchParams(window.location.search).get("hours"));
    return [24, 48, 72].includes(hours) ? hours : 72;
  });
  const [tracks, setTracks] = useState<Track[]>([]);
  const [visibleHours, setVisibleHours] = useState(duration);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [progress, setProgress] = useState([0, 0, 0]);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const run = useCallback(async (nextPlace = place, nextDuration = duration) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError("");
    setProgress([0, 0, 0]);
    setVisibleHours(nextDuration);
    try {
      const results = await Promise.all(
        LEVELS.map((level, levelIndex) =>
          computeTrack(nextPlace, nextDuration, level, controller.signal, (value) =>
            setProgress((current) => current.map((item, index) => (index === levelIndex ? value : item))),
          ),
        ),
      );
      setTracks(results);
      setStatus("ready");
      const url = new URL(window.location.href);
      url.searchParams.set("lat", nextPlace.lat.toFixed(4));
      url.searchParams.set("lon", nextPlace.lon.toFixed(4));
      url.searchParams.set("hours", String(nextDuration));
      window.history.replaceState({}, "", url);
    } catch (reason) {
      if ((reason as Error).name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "The trajectory could not be calculated.");
      setStatus("error");
    }
  }, [duration, place]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const initialPlace = initialPlaceRef.current;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [initialPlace.lon, initialPlace.lat],
      zoom: 4.5,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    map.on("load", () => {
      map.addSource("tracks", { type: "geojson", data: EMPTY_GEOJSON });
      map.addLayer({
        id: "trajectory-glow",
        type: "line",
        source: "tracks",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": ["get", "color"], "line-width": 8, "line-opacity": 0.13, "line-blur": 5 },
      });
      map.addLayer({
        id: "trajectories",
        type: "line",
        source: "tracks",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.92 },
      });
      map.addLayer({
        id: "trajectory-points",
        type: "circle",
        source: "tracks",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#09110f",
          "circle-stroke-width": 1.5,
        },
      });
    });
    map.on("click", (event) => {
      setPlace({ name: "Selected point", lat: event.lngLat.lat, lon: event.lngLat.lng });
    });
    mapRef.current = map;
    markerRef.current = new maplibregl.Marker({ color: "#f1fff9", scale: 0.85 })
      .setLngLat([initialPlace.lon, initialPlace.lat])
      .addTo(map);
    return () => map.remove();
  }, []);

  useEffect(() => {
    markerRef.current?.setLngLat([place.lon, place.lat]);
  }, [place]);

  useEffect(() => {
    const source = mapRef.current?.getSource("tracks") as GeoJSONSource | undefined;
    source?.setData(trackGeoJSON(tracks, visibleHours));
  }, [tracks, visibleHours]);

  useEffect(() => {
    if (!playing || tracks.length === 0) return;
    const interval = window.setInterval(() => {
      setVisibleHours((current) => (current >= duration ? 0 : Math.min(duration, current + 3)));
    }, 240);
    return () => window.clearInterval(interval);
  }, [duration, playing, tracks.length]);

  const overallProgress = Math.round((progress.reduce((sum, value) => sum + value, 0) / 3) * 100);
  const oldest = useMemo(
    () => tracks.flatMap((track) => track.points).reduce((value, point) => Math.min(value, point.age), 0),
    [tracks],
  );

  function choosePreset(preset: Place) {
    setPlace(preset);
    mapRef.current?.flyTo({ center: [preset.lon, preset.lat], zoom: 5, duration: 1200 });
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition((position) => {
      const next = { name: "Your location", lat: position.coords.latitude, lon: position.coords.longitude };
      setPlace(next);
      mapRef.current?.flyTo({ center: [next.lon, next.lat], zoom: 7, duration: 1200 });
    });
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const imported = parseHysplit(await file.text());
    if (!imported.length) {
      setError("No HYSPLIT endpoint records were found in that file.");
      setStatus("error");
      return;
    }
    setTracks(imported);
    setDuration(Math.max(24, Math.abs(Math.min(...imported.flatMap((track) => track.points.map((point) => point.age))))));
    setVisibleHours(999);
    setStatus("ready");
  }

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map" aria-label="Interactive atmospheric trajectory map" />
      <div className="map-vignette" />

      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><i /><i /><i /></span>
          <div>
            <strong>Atmospheric Transport Explorer</strong>
            <span>Browser-computed air provenance</span>
          </div>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={locate}>Use my location</button>
          <button className="icon-button" onClick={() => setPanelOpen((open) => !open)} aria-label="Toggle controls">
            {panelOpen ? "×" : "☰"}
          </button>
        </div>
      </header>

      <aside className={`control-panel ${panelOpen ? "open" : ""}`}>
        <div className="eyebrow"><span className="live-dot" /> Model workspace</div>
        <h1>Trace the air<br />arriving here.</h1>
        <p className="intro">Follow modeled wind backward through three atmospheric layers. Everything runs in this browser.</p>

        <section>
          <label className="section-label">Arrival point</label>
          <div className="location-card">
            <div>
              <strong>{place.name}</strong>
              <span>{formatCoordinate(place.lat, "N", "S")} · {formatCoordinate(place.lon, "E", "W")}</span>
            </div>
            <span className="target-icon">◎</span>
          </div>
          <div className="preset-row">
            {PRESETS.slice(0, 4).map((preset) => (
              <button key={preset.name} onClick={() => choosePreset(preset)}>{preset.name.split(" ")[0]}</button>
            ))}
          </div>
          <p className="map-hint">Or click anywhere on the map.</p>
        </section>

        <section>
          <label className="section-label">Lookback</label>
          <div className="segment-control">
            {[24, 48, 72].map((hours) => (
              <button key={hours} className={duration === hours ? "active" : ""} onClick={() => setDuration(hours)}>{hours}h</button>
            ))}
          </div>
        </section>

        <section>
          <label className="section-label">Arrival layers</label>
          <div className="layers">
            {LEVELS.map((level, index) => (
              <div className="layer" key={level.id}>
                <span className="swatch" style={{ background: level.color, boxShadow: `0 0 12px ${level.color}55` }} />
                <div><strong>{level.label}</strong><span>≈ {level.altitude.toLocaleString()} m ASL · {level.id.replace("hPa", " hPa")}</span></div>
                {status === "loading" && <span className="layer-progress">{Math.round(progress[index] * 100)}%</span>}
              </div>
            ))}
          </div>
        </section>

        <button className="primary-button" onClick={() => run()} disabled={status === "loading"}>
          {status === "loading" ? <><span className="spinner" /> Sampling wind field · {overallProgress}%</> : "Compute back trajectories"}
        </button>
        {status === "error" && <p className="error-message">{error}</p>}

        <div className="import-row">
          <div><strong>Have an authoritative run?</strong><span>Import a NOAA HYSPLIT <code>tdump</code> file.</span></div>
          <label className="file-button">Import<input type="file" accept=".txt,.tdump,.dat" onChange={importFile} /></label>
        </div>
      </aside>

      {tracks.length > 0 && (
        <div className="timeline-panel">
          <div className="timeline-header">
            <div>
              <span className="eyebrow">Trajectory time</span>
              <strong>{visibleHours === 0 ? "Arrival" : `${visibleHours} hours before arrival`}</strong>
            </div>
            <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause animation" : "Play animation"}>
              {playing ? "Ⅱ" : "▶"}
            </button>
          </div>
          <input
            className="time-slider"
            type="range"
            min="0"
            max={Math.abs(oldest) || duration}
            step="3"
            value={Math.min(visibleHours, Math.abs(oldest) || duration)}
            onChange={(event) => setVisibleHours(Number(event.target.value))}
            aria-label="Hours before arrival"
          />
          <div className="timeline-labels"><span>Arrival</span><span>−{Math.abs(oldest) || duration} h</span></div>
          <div className="method-chip">{tracks[0]?.source === "hysplit" ? "Imported NOAA HYSPLIT output" : "Kinematic estimate · Open-Meteo model winds"}</div>
        </div>
      )}

      <div className="science-note">
        <strong>This is a modeled estimate, not an observation.</strong>
        <span>Paths use pressure-level winds sampled every three hours. They omit turbulence, vertical motion, and dispersion.</span>
        <a href="https://www.ready.noaa.gov/READYmetapi.php" target="_blank" rel="noreferrer">Method & limitations ↗</a>
      </div>
    </main>
  );
}
