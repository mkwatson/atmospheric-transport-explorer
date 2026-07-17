"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  type CustomLayerInterface,
} from "maplibre-gl";
import { ParticleMotion } from "mapbox-exif-layer";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  WIND_BOUNDS,
  WIND_COLOR_STOPS,
  WIND_TEXTURE_BOUNDS,
  WIND_VELOCITY_RANGE,
  buildBackwardTrace,
  compassDirection,
  encodeWindFramePng,
  fetchWindField,
  formatCoordinate,
  nearestTimeIndex,
  sampleWind,
  type Coordinate,
  type WindField,
} from "./wind";

type LoadState = "loading" | "ready" | "error";

const EMPTY_TRACE: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const validTimeFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const relativeTimeLabel = (time: Date) => {
  const hours = Math.round((time.getTime() - Date.now()) / 3_600_000);
  if (Math.abs(hours) < 1) return "Now";
  return hours > 0 ? `+${hours} h` : `${hours} h`;
};

const traceGeoJson = (
  points: readonly Coordinate[],
): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features:
    points.length > 1
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: points.map(({ lon, lat }) => [lon, lat]),
            },
          },
          {
            type: "Feature",
            properties: { role: "origin" },
            geometry: {
              type: "Point",
              coordinates: [points.at(-1)?.lon ?? 0, points.at(-1)?.lat ?? 0],
            },
          },
        ]
      : [],
});

const firstSymbolLayer = (map: MapLibreMap) =>
  map.getStyle().layers?.find(({ type }) => type === "symbol")?.id;

export default function Home() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const particleLayerRef = useRef<ParticleMotion | null>(null);
  const selectedMarkerRef = useRef<Marker | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [field, setField] = useState<WindField | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Coordinate | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://tiles.openfreemap.org/styles/dark",
      center: [-98.5, 38.5],
      zoom: 3.15,
      pitch: 18,
      bearing: -7,
      maxPitch: 58,
      attributionControl: false,
      dragRotate: true,
      touchPitch: true,
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
      "bottom-right",
    );
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
    });

    map.on("load", () => {
      const padding = window.innerWidth < 720
        ? { top: 100, right: 24, bottom: 185, left: 24 }
        : { top: 110, right: 72, bottom: 155, left: 72 };

      map.fitBounds(
        [
          [WIND_BOUNDS.west, WIND_BOUNDS.south],
          [WIND_BOUNDS.east, WIND_BOUNDS.north],
        ],
        { padding, duration: 0 },
      );

      map.addSource("backward-trace", {
        type: "geojson",
        data: EMPTY_TRACE,
        lineMetrics: true,
      });

      const beforeId = firstSymbolLayer(map);
      map.addLayer(
        {
          id: "backward-trace-glow",
          type: "line",
          source: "backward-trace",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-color": "#ffbd76",
            "line-width": 11,
            "line-opacity": 0.16,
            "line-blur": 7,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: "backward-trace-line",
          type: "line",
          source: "backward-trace",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-gradient": [
              "interpolate",
              ["linear"],
              ["line-progress"],
              0,
              "#f6f1d4",
              0.45,
              "#8de7d0",
              1,
              "#ffac6f",
            ],
            "line-width": 2.5,
            "line-opacity": 0.95,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: "backward-trace-origin",
          type: "circle",
          source: "backward-trace",
          filter: ["==", ["get", "role"], "origin"],
          paint: {
            "circle-radius": 4,
            "circle-color": "#ffbd76",
            "circle-stroke-color": "rgba(5, 12, 18, .9)",
            "circle-stroke-width": 2,
          },
        },
        beforeId,
      );

      setMapReady(true);
    });

    map.on("click", ({ lngLat }) => {
      setSelected({ lon: lngLat.lng, lat: lngLat.lat });
      setLocationError("");
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchWindField(controller.signal)
      .then((nextField) => {
        setField(nextField);
        setFrameIndex(nearestTimeIndex(nextField.times, new Date()));
        setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Live wind data is unavailable.");
        setLoadState("error");
      });

    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (!mapReady || !field || particleLayerRef.current || !mapRef.current) return;

    const layer = new ParticleMotion({
      id: "surface-wind",
      source: encodeWindFramePng(field, frameIndex),
      sourceType: "jpeg",
      bounds: WIND_TEXTURE_BOUNDS,
      velocityRange: WIND_VELOCITY_RANGE,
      color: WIND_COLOR_STOPS,
      unit: "mph",
      mapRuntime: "maplibre",
      readyForDisplay: true,
      particleCount: window.innerWidth < 720 ? 1_500 : 5_200,
      velocityFactor: 0.04,
      updateInterval: 55,
      pointSize: window.innerWidth < 720 ? 1.9 : 2.25,
      trailLength: 4,
      trailSizeDecay: 0.72,
      fadeOpacity: 0.76,
      ageThreshold: 420,
      maxAge: 900,
    });

    // The package implements MapLibre's custom-layer contract at runtime, but its
    // declaration omits that structural interface. Keep the unavoidable cast here.
    mapRef.current.addLayer(
      layer as unknown as CustomLayerInterface,
      firstSymbolLayer(mapRef.current),
    );
    particleLayerRef.current = layer;
  }, [field, frameIndex, mapReady]);

  useEffect(() => {
    if (!field || !particleLayerRef.current) return;
    particleLayerRef.current.setSource(encodeWindFramePng(field, frameIndex), 0.72);
  }, [field, frameIndex]);

  useEffect(() => {
    if (!playing || !field) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % field.times.length);
    }, 850);
    return () => window.clearInterval(timer);
  }, [field, playing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code !== "Space" || target?.matches("button, input, a")) return;
      event.preventDefault();
      setPlaying((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const trace = useMemo(
    () =>
      field && selected
        ? buildBackwardTrace(field, frameIndex, selected)
        : [],
    [field, frameIndex, selected],
  );

  useEffect(() => {
    const source = mapRef.current?.getSource("backward-trace") as GeoJSONSource | undefined;
    source?.setData(traceGeoJson(trace));
  }, [trace]);

  useEffect(() => {
    selectedMarkerRef.current?.remove();
    selectedMarkerRef.current = null;
    if (!selected || !mapRef.current) return;

    const element = document.createElement("div");
    element.className = "arrival-marker";
    element.setAttribute("aria-hidden", "true");
    selectedMarkerRef.current = new maplibregl.Marker({ element })
      .setLngLat([selected.lon, selected.lat])
      .addTo(mapRef.current);
  }, [selected]);

  const selectedWind = useMemo(
    () => (field && selected ? sampleWind(field, frameIndex, selected) : null),
    [field, frameIndex, selected],
  );

  const validTime = field?.times[frameIndex] ?? null;
  const nowIndex = field ? nearestTimeIndex(field.times, new Date()) : 0;
  const traceHours = Math.max(0, trace.length - 1);

  const selectCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError("Location is not available in this browser.");
      return;
    }

    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const coordinate = { lon: coords.longitude, lat: coords.latitude };
        setSelected(coordinate);
        setLocating(false);
        mapRef.current?.easeTo({ center: [coordinate.lon, coordinate.lat], zoom: 5.4, duration: 1_400 });
      },
      () => {
        setLocating(false);
        setLocationError("Your location could not be used.");
      },
      { enableHighAccuracy: false, timeout: 8_000 },
    );
  }, []);

  const retryWind = useCallback(() => {
    setLoadState("loading");
    setError("");
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  return (
    <main className="experience">
      <div
        ref={mapContainerRef}
        className="map-canvas"
        role="application"
        aria-label="Interactive map of forecast surface winds over the United States"
      />
      <div className="map-light" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>Atmosphere</strong>
            <span>United States · surface wind</span>
          </div>
        </div>
        <div className="top-actions">
          <button
            className="round-action"
            type="button"
            onClick={selectCurrentLocation}
            aria-label="Use my location"
            title="Use my location"
          >
            <span className={locating ? "locate-icon locating" : "locate-icon"} aria-hidden="true" />
          </button>
          <button
            className="round-action info-action"
            type="button"
            onClick={() => setInfoOpen(true)}
            aria-label="About this wind field"
            title="About this wind field"
          >
            i
          </button>
        </div>
      </header>

      <section className="field-key" aria-label="Wind speed color scale">
        <div className="field-key-heading">
          <span>10 m wind speed</span>
          <strong>m/s</strong>
        </div>
        <div className="speed-ramp" aria-hidden="true" />
        <div className="speed-labels" aria-hidden="true"><span>0</span><span>10</span><span>20</span><span>35+</span></div>
      </section>

      {loadState !== "ready" && (
        <div className={loadState === "error" ? "data-status error" : "data-status"} role="status">
          {loadState === "loading" ? (
            <><span className="status-pulse" aria-hidden="true" /> Loading NOAA wind field</>
          ) : (
            <>
              <span>{error}</span>
              <button type="button" onClick={retryWind}>Retry</button>
            </>
          )}
        </div>
      )}

      {selected && selectedWind ? (
        <section className="selection-card" aria-live="polite">
          <button className="selection-close" type="button" onClick={() => setSelected(null)} aria-label="Clear selected point">×</button>
          <span className="hud-label">Air arriving here</span>
          <div className="selection-reading">
            <strong>{Math.round(selectedWind.speed * 2.23694)}</strong>
            <span>mph<br />from {compassDirection(selectedWind.direction)}</span>
          </div>
          <p>{formatCoordinate(selected)}</p>
          <div className="trace-summary">
            <span className="trace-line" aria-hidden="true" />
            <span><strong>{traceHours}-hour backward trace</strong>Kinematic model estimate</span>
          </div>
        </section>
      ) : (
        <div className="map-hint"><span aria-hidden="true">+</span> Click anywhere to trace the air arriving there</div>
      )}

      {locationError && <div className="location-error" role="status">{locationError}</div>}

      <section className="timeline" aria-label="Forecast time controls">
        <button
          className="play-control"
          type="button"
          onClick={() => setPlaying((current) => !current)}
          disabled={!field}
          aria-label={playing ? "Pause forecast" : "Play forecast"}
        >
          <span className={playing ? "pause-shape" : "play-shape"} aria-hidden="true" />
        </button>
        <div className="time-readout">
          <span>Valid time</span>
          <strong>{validTime ? validTimeFormatter.format(validTime) : "Preparing forecast"}</strong>
        </div>
        <div className="timeline-track">
          <input
            type="range"
            min="0"
            max={Math.max(0, (field?.times.length ?? 1) - 1)}
            value={frameIndex}
            onChange={(event) => {
              setPlaying(false);
              setFrameIndex(Number(event.target.value));
            }}
            disabled={!field}
            aria-label="Forecast valid time"
          />
          <div className="timeline-meta">
            <span>{field?.times[0] ? relativeTimeLabel(field.times[0]) : "−24 h"}</span>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setFrameIndex(nowIndex);
              }}
              disabled={!field}
            >
              Now
            </button>
            <span>{field?.times.at(-1) ? relativeTimeLabel(field.times.at(-1)!) : "+48 h"}</span>
          </div>
        </div>
        <span className="relative-time">{validTime ? relativeTimeLabel(validTime) : ""}</span>
      </section>

      <div className={infoOpen ? "info-scrim open" : "info-scrim"} onClick={() => setInfoOpen(false)} aria-hidden="true" />
      <aside className={infoOpen ? "info-panel open" : "info-panel"} aria-hidden={!infoOpen}>
        <button className="info-close" type="button" onClick={() => setInfoOpen(false)} aria-label="Close information">×</button>
        <span className="hud-label">About the field</span>
        <h1>Read the wind,<br />not a dashboard.</h1>
        <p className="info-intro">The moving particles reveal the direction and relative speed of forecast wind ten metres above the ground. Drag the map, rotate it, zoom, or move through time.</p>

        <dl className="facts">
          <div><dt>Model</dt><dd>NOAA GFS seamless</dd></div>
          <div><dt>Field</dt><dd>10 m wind · hourly</dd></div>
          <div><dt>Coverage</dt><dd>Contiguous United States</dd></div>
          <div><dt>Delivery</dt><dd>Open-Meteo · live JSON</dd></div>
        </dl>

        <section className="method-note">
          <h2>When you select a point</h2>
          <p>The highlighted line follows the gridded wind backward one hour at a time. It is a useful kinematic estimate—not an observation, source-apportionment result, or HYSPLIT trajectory.</p>
        </section>

        <section className="method-note">
          <h2>Scientific limits</h2>
          <p>Particles are a visual reading of an interpolated forecast field. Terrain effects, turbulence, vertical motion, chemistry, and dispersion are not represented by the backward trace.</p>
        </section>

        <div className="source-links">
          <a href="https://open-meteo.com/en/docs/gfs-api" target="_blank" rel="noreferrer">Forecast documentation ↗</a>
          <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast" target="_blank" rel="noreferrer">About NOAA GFS ↗</a>
        </div>
      </aside>
    </main>
  );
}
