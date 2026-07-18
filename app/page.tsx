"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl, { Marker, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  DISPLAY_PAST_HOURS,
  SPEED_PALETTE,
  TRACE_HOURS,
  WIND_LEVELS,
  buildBackwardTrace,
  clampBounds,
  containsCoordinate,
  fetchWindField,
  formatCoordinate,
  formatHeight,
  nearestTimeIndex,
  NATIONAL_WIND_BOUNDS,
  quantizeBounds,
  relativeHourLabel,
  sampleWind,
  textureBounds,
  timeAtPosition,
  timePositionForTimeline,
  windLevel,
  windTexture,
  type Coordinate,
  type TracePoint,
  type WindBounds,
  type WindField,
  type WindLevelId,
  type WindReading,
} from "./wind";

type LoadState = "loading" | "ready" | "error";
type RefinementState = "national" | "loading" | "regional";
type WeatherLayersModule = typeof import("weatherlayers-gl");

type TraceDatum = Readonly<{
  id: WindLevelId;
  path: readonly TracePoint[];
  color: readonly [number, number, number, number];
  selected: boolean;
}>;

const validTimeFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const PLAYBACK_MILLISECONDS_PER_HOUR = 1_150;
const REGIONAL_ZOOM = 4.35;
const REGIONAL_GRID = { desktop: [21, 13], mobile: [17, 11] } as const;
const FIELD_WARMUP_MILLISECONDS = 1_200;
const FIELD_FADE_MILLISECONDS = 800;
const PLAYBACK_STATE_SYNC_MILLISECONDS = 250;
const SCRUB_STATE_SYNC_MILLISECONDS = 150;
const VIEWPORT_DEBOUNCE_MILLISECONDS = 250;
const PARTICLE_SPEED_FACTOR: Readonly<Record<WindLevelId, number>> = {
  surface: 1.5,
  "850hPa": 1.05,
  "500hPa": 0.82,
  "250hPa": 0.65,
};
const COMPACT_LEVEL_LABELS: Readonly<Record<WindLevelId, string>> = {
  surface: "Ground",
  "850hPa": "Low",
  "500hPa": "Mid",
  "250hPa": "Jet",
};
const textureCache = new WeakMap<
  WindField,
  Map<string, NonNullable<ReturnType<typeof windTexture>>>
>();

const textureFor = (
  field: WindField,
  levelId: WindLevelId,
  frameIndex: number,
) => {
  const cache = textureCache.get(field) ?? new Map();
  textureCache.set(field, cache);
  const key = `${levelId}:${frameIndex}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const texture = windTexture(field, levelId, frameIndex);
  if (texture) cache.set(key, texture);
  return texture;
};

const texturePair = (
  field: WindField,
  levelId: WindLevelId,
  timePosition: number,
) => {
  const lowerIndex = Math.max(0, Math.floor(timePosition));
  const upperIndex = Math.min(field.times.length - 1, Math.ceil(timePosition));
  return {
    image: textureFor(field, levelId, lowerIndex),
    image2: textureFor(field, levelId, upperIndex),
    imageWeight: timePosition - lowerIndex,
  };
};

const regionalViewport = (map: MapLibreMap) => {
  if (map.getZoom() < REGIONAL_ZOOM) return null;
  const center = map.getCenter();
  const canvas = map.getCanvas();
  const degreesPerPixel = 360 / (512 * 2 ** map.getZoom());
  const pitchStretch = 1 + Math.sin((map.getPitch() * Math.PI) / 180) * 0.45;
  const halfLongitude = degreesPerPixel * canvas.clientWidth * 0.68;
  const halfLatitude =
    degreesPerPixel *
    canvas.clientHeight *
    0.68 *
    Math.cos((center.lat * Math.PI) / 180) *
    pitchStretch;
  const viewport = clampBounds({
    west: center.lng - halfLongitude,
    east: center.lng + halfLongitude,
    north: center.lat + halfLatitude,
    south: center.lat - halfLatitude,
  });
  return viewport ? clampBounds(quantizeBounds(viewport)) : null;
};

const regionalKey = (bounds: WindBounds, levelId: WindLevelId) =>
  `${levelId}:${bounds.west}:${bounds.south}:${bounds.east}:${bounds.north}`;

const particleFieldId = (field: WindField, levelId: WindLevelId) =>
  `wind:${regionalKey(field.bounds, levelId)}:${field.width}x${field.height}`;

const speedMph = (reading: WindReading) =>
  Math.round(reading.speed * 2.236_936);

const sampleReading = (
  nationalField: WindField,
  regionalField: WindField | null,
  nationalTimePosition: number,
  coordinate: Coordinate,
  levelId: WindLevelId,
): WindReading | null => {
  const field =
    regionalField?.levels[levelId] &&
    containsCoordinate(regionalField.bounds, coordinate)
      ? regionalField
      : nationalField;
  const fieldTimePosition = timePositionForTimeline(
    nationalField.times,
    nationalTimePosition,
    field.times,
  );
  return sampleWind(field, fieldTimePosition, coordinate, levelId);
};

type LayerBuilderInputs = Readonly<{
  weatherLayers: WeatherLayersModule | null;
  timelineField: WindField | null;
  primaryField: WindField | null;
  previousField: WindField | null;
  blend: number;
  levelId: WindLevelId;
  timePosition: number;
  traces: readonly TraceDatum[];
  reducedMotion: boolean;
  particleCount: number;
  isMobile: boolean;
  selectedColor: readonly [number, number, number, number];
}>;

type StableLayerBuilderInputs = Omit<
  LayerBuilderInputs,
  "blend" | "timePosition"
>;

const buildDeckLayers = ({
  weatherLayers,
  timelineField,
  primaryField,
  previousField,
  blend,
  levelId,
  timePosition,
  traces,
  reducedMotion,
  particleCount,
  isMobile,
  selectedColor,
}: LayerBuilderInputs): Layer[] => {
  const layers: Layer[] = [];
  if (!weatherLayers) return layers;
  const {
    GridLayer,
    GridStyle,
    ImageInterpolation,
    ImageType,
    ParticleLayer,
  } = weatherLayers;
  const positionForField = (field: WindField): number =>
    timelineField
      ? timePositionForTimeline(
          timelineField.times,
          timePosition,
          field.times,
        )
      : timePosition;
  const particleLayerFor = (
    field: WindField | null,
    opacity: number,
  ): Layer | null => {
    if (!field?.levels[levelId]) return null;
    const pair = texturePair(field, levelId, positionForField(field));
    if (!pair.image || !pair.image2) return null;
    return new ParticleLayer({
      id: particleFieldId(field, levelId),
      image: pair.image,
      image2: pair.image2,
      imageWeight: pair.imageWeight,
      imageType: ImageType.VECTOR,
      imageInterpolation: ImageInterpolation.CUBIC,
      bounds: textureBounds(field.bounds),
      palette: SPEED_PALETTE.map(([value, color]) => [value, color]),
      numParticles: particleCount,
      maxAge: 110,
      speedFactor: PARTICLE_SPEED_FACTOR[levelId],
      width: isMobile ? 1.2 : 1.55,
      opacity: opacity * 0.92,
      animate: !reducedMotion,
      pickable: false,
    });
  };

  // Layer-array mutation is contained in this builder because this is the measured rendering hot path.
  const previousParticles = particleLayerFor(previousField, 1 - blend);
  const currentParticles = particleLayerFor(primaryField, blend);
  if (previousParticles) layers.push(previousParticles);
  if (currentParticles) layers.push(currentParticles);

  if (reducedMotion && primaryField?.levels[levelId]) {
    const pair = texturePair(
      primaryField,
      levelId,
      positionForField(primaryField),
    );
    if (pair.image && pair.image2) {
      layers.push(
        new GridLayer({
          id: "reduced-motion-wind",
          image: pair.image,
          image2: pair.image2,
          imageWeight: pair.imageWeight,
          imageType: ImageType.VECTOR,
          imageInterpolation: ImageInterpolation.CUBIC,
          bounds: textureBounds(primaryField.bounds),
          style: GridStyle.ARROW,
          density: 1,
          iconBounds: [0, 40],
          iconSize: [8, 21],
          iconColor: selectedColor,
          opacity: 0.88,
        }),
      );
    }
  }

  if (traces.length > 0) {
    const tracePath = (datum: TraceDatum): [number, number, number][] =>
      datum.path.map(({ lon, lat }) => [lon, lat, 0]);
    layers.push(
      new PathLayer<TraceDatum>({
        id: "backward-trace-glow",
        data: traces,
        getPath: tracePath,
        getColor: ({ color, selected }) => [
          color[0],
          color[1],
          color[2],
          selected ? 55 : 20,
        ],
        getWidth: ({ selected }) => (selected ? 10 : 5),
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: false,
      }),
      new PathLayer<TraceDatum>({
        id: "backward-traces",
        data: traces,
        getPath: tracePath,
        getColor: ({ color, selected }) => [
          color[0],
          color[1],
          color[2],
          selected ? 245 : 155,
        ],
        getWidth: ({ selected }) => (selected ? 2.8 : 1.35),
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: false,
      }),
    );

    const origins = traces.map((trace) => ({
      trace,
      position: trace.path.at(-1),
    }));
    layers.push(
      new ScatterplotLayer({
        id: "trace-origins",
        data: origins,
        getPosition: ({ position }: (typeof origins)[number]) => [
          position?.lon ?? 0,
          position?.lat ?? 0,
          0,
        ],
        getFillColor: ({ trace }: (typeof origins)[number]) => trace.color,
        getLineColor: [5, 12, 18, 220],
        getRadius: ({ trace }: (typeof origins)[number]) =>
          trace.selected ? 4 : 2.6,
        radiusUnits: "pixels",
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
        pickable: false,
      }),
    );
  }

  return layers;
};

export default function Home() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const selectedMarkerRef = useRef<Marker | null>(null);
  const regionalCacheRef = useRef(new Map<string, WindField>());
  const lastPrimaryFieldRef = useRef<WindField | null>(null);
  const fieldBlendRef = useRef(1);
  const timePositionRef = useRef(0);
  const viewportUpdateTimeoutRef = useRef<number | null>(null);
  const scrubSyncTimeoutRef = useRef<number | null>(null);
  const lastScrubSyncRef = useRef(0);
  const [mapReady, setMapReady] = useState(false);
  const [nationalField, setNationalField] = useState<WindField | null>(null);
  const [regionalField, setRegionalField] = useState<WindField | null>(null);
  const [previousPrimaryField, setPreviousPrimaryField] = useState<WindField | null>(null);
  const [timePosition, setTimePosition] = useState(0);
  const [minuteClock, setMinuteClock] = useState(() => Date.now());
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [refinementState, setRefinementState] = useState<RefinementState>("national");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Coordinate | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<WindLevelId>("surface");
  const [showAllPaths, setShowAllPaths] = useState(false);
  const [selectionExpanded, setSelectionExpanded] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [viewportBounds, setViewportBounds] = useState<WindBounds | null>(null);
  const [viewportPixels, setViewportPixels] = useState(1_000_000);
  const [isMobile, setIsMobile] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [weatherLayers, setWeatherLayers] = useState<WeatherLayersModule | null>(null);

  const applyViewportBounds = useCallback((map: MapLibreMap) => {
    const nextBounds = regionalViewport(map);
    setViewportBounds(nextBounds);
    if (!nextBounds) {
      setRegionalField(null);
      setRefinementState("national");
    }
  }, []);

  const updateViewport = useCallback((map: MapLibreMap, debounce: boolean) => {
    const canvas = map.getCanvas();
    setViewportPixels(canvas.clientWidth * canvas.clientHeight);
    setIsMobile(canvas.clientWidth < 720);

    if (viewportUpdateTimeoutRef.current !== null) {
      window.clearTimeout(viewportUpdateTimeoutRef.current);
      viewportUpdateTimeoutRef.current = null;
    }
    if (!debounce) {
      applyViewportBounds(map);
      return;
    }
    viewportUpdateTimeoutRef.current = window.setTimeout(() => {
      viewportUpdateTimeoutRef.current = null;
      applyViewportBounds(map);
    }, VIEWPORT_DEBOUNCE_MILLISECONDS);
  }, [applyViewportBounds]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setMinuteClock(Date.now());
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://tiles.openfreemap.org/styles/dark",
      center: [-98.5, 38.5],
      zoom: 3.15,
      pitch: 18,
      bearing: -7,
      maxPitch: 68,
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
        ? { top: 100, right: 24, bottom: 190, left: 24 }
        : { top: 110, right: 72, bottom: 155, left: 72 };
      map.fitBounds(
        [
          [NATIONAL_WIND_BOUNDS.west, NATIONAL_WIND_BOUNDS.south],
          [NATIONAL_WIND_BOUNDS.east, NATIONAL_WIND_BOUNDS.north],
        ],
        { padding, duration: 0 },
      );

      const overlay = new MapboxOverlay({
        interleaved: false,
        layers: [],
        useDevicePixels: true,
        deviceProps: { debug: false, debugGPUTime: false },
        onError: (reason) => {
          console.error("Atmospheric renderer error", reason);
        },
      });
      map.addControl(overlay as unknown as maplibregl.IControl);
      overlayRef.current = overlay;
      updateViewport(map, false);
      setMapReady(true);
    });

    map.on("moveend", () => updateViewport(map, true));
    map.on("resize", () => updateViewport(map, true));
    map.on("click", ({ lngLat }) => {
      const coordinate = { lon: lngLat.lng, lat: lngLat.lat };
      if (!containsCoordinate(NATIONAL_WIND_BOUNDS, coordinate)) {
        setLocationError("Choose a point inside the contiguous U.S. wind field.");
        return;
      }
      setSelected(coordinate);
      setSelectionExpanded(true);
      setLocationError("");
    });

    mapRef.current = map;
    return () => {
      if (viewportUpdateTimeoutRef.current !== null) {
        window.clearTimeout(viewportUpdateTimeoutRef.current);
        viewportUpdateTimeoutRef.current = null;
      }
      overlayRef.current?.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [updateViewport]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const renderer = import("weatherlayers-gl").catch(() => {
      throw new Error("The atmospheric renderer could not be loaded.");
    });
    Promise.all([fetchWindField(controller.signal), renderer])
      .then(([field, module]) => {
        if (!current) return;
        const nowIndex = nearestTimeIndex(field.times, new Date());
        timePositionRef.current = nowIndex;
        setTimePosition(nowIndex);
        setNationalField(field);
        setWeatherLayers(module);
        setLoadState("ready");
      })
      .catch((reason: unknown) => {
        if (!current) return;
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Live wind data is unavailable.");
        setLoadState("error");
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!nationalField || !viewportBounds) return;

    const key = regionalKey(viewportBounds, selectedLevel);
    const controller = new AbortController();
    const [width, height] = isMobile
      ? REGIONAL_GRID.mobile
      : REGIONAL_GRID.desktop;
    const loadRegionalField = async () => {
      const cached = regionalCacheRef.current.get(key);
      if (cached) {
        setRegionalField(cached);
        setRefinementState("regional");
        return;
      }

      setRefinementState("loading");
      try {
        const field = await fetchWindField(controller.signal, {
          bounds: viewportBounds,
          width,
          height,
          levels: [selectedLevel],
        });
        const cache = regionalCacheRef.current;
        cache.set(key, field);
        if (cache.size > 6) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        setRegionalField(field);
        setRefinementState("regional");
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setRegionalField(null);
        setRefinementState("national");
      }
    };
    void loadRegionalField();

    return () => controller.abort();
  }, [isMobile, nationalField, selectedLevel, viewportBounds]);

  const desiredPrimaryField =
    regionalField?.levels[selectedLevel] ? regionalField : nationalField;

  const minimumTimePosition = TRACE_HOURS;
  const maximumTimePosition = Math.max(
    minimumTimePosition,
    (nationalField?.times.length ?? 1) - 1,
  );
  const nowIndex = useMemo(
    () =>
      nationalField
        ? nearestTimeIndex(nationalField.times, new Date(minuteClock))
        : DISPLAY_PAST_HOURS + TRACE_HOURS,
    [minuteClock, nationalField],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === "Escape") {
        setInfoOpen(false);
        return;
      }
      if (event.code !== "Space" || target?.matches("button, input, a")) return;
      event.preventDefault();
      setPlaying((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  const particleCount = Math.max(
    isMobile ? 1_800 : 4_800,
    Math.min(
      isMobile ? 5_500 : 12_000,
      Math.round(viewportPixels / 160),
    ),
  );
  const selectedMetadata = windLevel(selectedLevel);
  const validTime = nationalField
    ? timeAtPosition(nationalField.times, timePosition)
    : null;

  const levelReadings = useMemo(
    () =>
      selected && nationalField
        ? WIND_LEVELS.map((level) => ({
            level,
            reading: sampleReading(
              nationalField,
              regionalField,
              timePosition,
              selected,
              level.id,
            ),
          }))
        : [],
    [nationalField, regionalField, selected, timePosition],
  );

  const selectedReading = useMemo(() => {
    if (!selected || !nationalField) return null;
    return sampleReading(
      nationalField,
      regionalField,
      timePosition,
      selected,
      selectedLevel,
    );
  }, [nationalField, regionalField, selected, selectedLevel, timePosition]);

  const traces = useMemo<readonly TraceDatum[]>(() => {
    if (!selected || !nationalField) return [];
    // Traces stay national because regional bounds are too small for 18-hour paths.
    const levels = showAllPaths
      ? WIND_LEVELS.map(({ id }) => id)
      : [selectedLevel];
    return levels
      .map((levelId) => ({
        id: levelId,
        path: buildBackwardTrace(
          nationalField,
          timePosition,
          selected,
          levelId,
        ),
        color: windLevel(levelId).color,
        selected: levelId === selectedLevel,
      }))
      .filter(({ path }) => path.length > 1);
  }, [nationalField, selected, selectedLevel, showAllPaths, timePosition]);

  const stableLayerInputsRef = useRef<StableLayerBuilderInputs>({
    weatherLayers,
    timelineField: nationalField,
    primaryField: desiredPrimaryField,
    previousField: previousPrimaryField,
    levelId: selectedLevel,
    traces,
    reducedMotion,
    particleCount,
    isMobile,
    selectedColor: selectedMetadata.color,
  });

  useEffect(() => {
    // Builder-input mutation stays in the imperative renderer shell because this is the measured rendering hot path.
    stableLayerInputsRef.current = {
      weatherLayers,
      timelineField: nationalField,
      primaryField: desiredPrimaryField,
      previousField: previousPrimaryField,
      levelId: selectedLevel,
      traces,
      reducedMotion,
      particleCount,
      isMobile,
      selectedColor: selectedMetadata.color,
    };
  }, [
    desiredPrimaryField,
    isMobile,
    nationalField,
    particleCount,
    previousPrimaryField,
    reducedMotion,
    selectedLevel,
    selectedMetadata.color,
    traces,
    weatherLayers,
  ]);

  const updateOverlayLayers = useCallback(() => {
    // Direct overlay mutation is contained here because this is the measured rendering hot path.
    overlayRef.current?.setProps({
      layers: buildDeckLayers({
        ...stableLayerInputsRef.current,
        blend: fieldBlendRef.current,
        timePosition: timePositionRef.current,
      }),
    });
  }, []);

  const deckLayers = useMemo(
    () =>
      buildDeckLayers({
        weatherLayers,
        timelineField: nationalField,
        primaryField: desiredPrimaryField,
        previousField: previousPrimaryField,
        blend: previousPrimaryField ? 0 : 1,
        levelId: selectedLevel,
        timePosition,
        traces,
        reducedMotion,
        particleCount,
        isMobile,
        selectedColor: selectedMetadata.color,
      }),
    [
      desiredPrimaryField,
      isMobile,
      nationalField,
      particleCount,
      previousPrimaryField,
      reducedMotion,
      selectedLevel,
      selectedMetadata.color,
      timePosition,
      traces,
      weatherLayers,
    ],
  );

  useEffect(() => {
    overlayRef.current?.setProps({ layers: deckLayers });
  }, [deckLayers, mapReady]);

  useEffect(() => {
    if (!desiredPrimaryField) return;
    const previous = lastPrimaryFieldRef.current;
    lastPrimaryFieldRef.current = desiredPrimaryField;
    const sameParticleField =
      previous &&
      particleFieldId(previous, selectedLevel) ===
        particleFieldId(desiredPrimaryField, selectedLevel);
    // Blend ref mutation stays in the imperative renderer shell because this is the measured rendering hot path.
    if (!previous || sameParticleField || reducedMotion) {
      fieldBlendRef.current = 1;
      setPreviousPrimaryField(null);
      return;
    }

    fieldBlendRef.current = 0;
    setPreviousPrimaryField(previous);
  }, [desiredPrimaryField, reducedMotion, selectedLevel]);

  useEffect(() => {
    if (!previousPrimaryField || reducedMotion) return;
    const startedAt = performance.now();
    let animationFrame = 0;
    const animate = (now: number) => {
      const fadeProgress = Math.min(
        1,
        Math.max(
          0,
          (now - startedAt - FIELD_WARMUP_MILLISECONDS) /
            FIELD_FADE_MILLISECONDS,
        ),
      );
      const nextBlend = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
      // Blend ref mutation is contained here because this is the measured rendering hot path.
      fieldBlendRef.current = nextBlend;
      updateOverlayLayers();
      if (nextBlend < 1) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        setPreviousPrimaryField(null);
      }
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [previousPrimaryField, reducedMotion, updateOverlayLayers]);

  const updateLayerTimePosition = useCallback(
    (position: number) => {
      const bounded = Math.min(
        maximumTimePosition,
        Math.max(minimumTimePosition, position),
      );
      // Time ref mutation is contained here because this is the measured rendering hot path.
      timePositionRef.current = bounded;
      updateOverlayLayers();
      return bounded;
    },
    [maximumTimePosition, minimumTimePosition, updateOverlayLayers],
  );

  const updateTimePosition = useCallback(
    (position: number) => {
      const bounded = updateLayerTimePosition(position);
      if (scrubSyncTimeoutRef.current !== null) {
        window.clearTimeout(scrubSyncTimeoutRef.current);
        scrubSyncTimeoutRef.current = null;
      }
      lastScrubSyncRef.current = performance.now();
      setTimePosition(bounded);
    },
    [updateLayerTimePosition],
  );

  const scrubTimePosition = useCallback(
    (position: number) => {
      const bounded = updateLayerTimePosition(position);
      const now = performance.now();
      const remaining =
        SCRUB_STATE_SYNC_MILLISECONDS - (now - lastScrubSyncRef.current);
      if (remaining <= 0) {
        if (scrubSyncTimeoutRef.current !== null) {
          window.clearTimeout(scrubSyncTimeoutRef.current);
          scrubSyncTimeoutRef.current = null;
        }
        lastScrubSyncRef.current = now;
        setTimePosition(bounded);
        return;
      }

      if (scrubSyncTimeoutRef.current !== null) {
        window.clearTimeout(scrubSyncTimeoutRef.current);
      }
      scrubSyncTimeoutRef.current = window.setTimeout(() => {
        scrubSyncTimeoutRef.current = null;
        lastScrubSyncRef.current = performance.now();
        setTimePosition(timePositionRef.current);
      }, remaining);
    },
    [updateLayerTimePosition],
  );

  useEffect(() => {
    if (!playing || !nationalField) return;
    let animationFrame = 0;
    let previousTimestamp = performance.now();
    let lastStateSync = previousTimestamp;
    const animate = (timestamp: number) => {
      const elapsed = timestamp - previousTimestamp;
      previousTimestamp = timestamp;
      let next =
        timePositionRef.current + elapsed / PLAYBACK_MILLISECONDS_PER_HOUR;
      if (next > maximumTimePosition) {
        next = minimumTimePosition + (next - maximumTimePosition);
      }
      next = updateLayerTimePosition(next);
      if (timestamp - lastStateSync >= PLAYBACK_STATE_SYNC_MILLISECONDS) {
        lastStateSync = timestamp;
        setTimePosition(next);
      }
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrame);
      setTimePosition(timePositionRef.current);
    };
  }, [
    maximumTimePosition,
    minimumTimePosition,
    nationalField,
    playing,
    updateLayerTimePosition,
  ]);

  useEffect(
    () => () => {
      if (scrubSyncTimeoutRef.current !== null) {
        window.clearTimeout(scrubSyncTimeoutRef.current);
      }
    },
    [],
  );

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
        setLocating(false);
        if (!containsCoordinate(NATIONAL_WIND_BOUNDS, coordinate)) {
          setLocationError("Your location is outside the contiguous U.S. wind field.");
          return;
        }
        setSelected(coordinate);
        setSelectionExpanded(true);
        mapRef.current?.easeTo({
          center: [coordinate.lon, coordinate.lat],
          zoom: 5.4,
          duration: reducedMotion ? 0 : 1_400,
        });
      },
      () => {
        setLocating(false);
        setLocationError("Your location could not be used.");
      },
      { enableHighAccuracy: false, timeout: 8_000 },
    );
  }, [reducedMotion]);

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
        aria-label="Interactive globe of forecast winds at multiple atmospheric levels over the United States"
      />
      <div className="map-light" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>Atmosphere</strong>
            <span>United States · four atmospheric levels</span>
          </div>
        </div>
        <div className="top-actions">
          <a
            href="https://github.com/mkwatson/atmospheric-transport-explorer"
            target="_blank"
            rel="noreferrer"
            className="round-action"
            aria-label="View source on GitHub"
            title="View source on GitHub"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
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

      <section className="field-key" aria-label="Wind field and atmospheric level">
        <fieldset className="altitude-control">
          <legend>Altitude</legend>
          <div className="altitude-options">
            {WIND_LEVELS.slice().reverse().map((level) => (
              <label
                className={level.id === selectedLevel ? "altitude-option selected" : "altitude-option"}
                key={level.id}
              >
                <input
                  type="radio"
                  name="atmospheric-level"
                  value={level.id}
                  checked={level.id === selectedLevel}
                  onChange={() => setSelectedLevel(level.id)}
                  aria-label={`${level.label}, ${level.pressureLabel}, ${level.approximateHeightLabel}`}
                />
                <i style={{ background: `rgb(${level.color.slice(0, 3).join(" ")})` }} aria-hidden="true" />
                <span>
                  <b>
                    <span className="level-label-full">{level.label}</span>
                    <span className="level-label-compact">{COMPACT_LEVEL_LABELS[level.id]}</span>
                  </b>
                  <small>{level.pressureLabel} · {level.approximateHeightLabel}</small>
                </span>
                <em aria-hidden="true">{level.id === selectedLevel ? "●" : ""}</em>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="selected-level-detail">
          <i style={{ background: `rgb(${selectedMetadata.color.slice(0, 3).join(" ")})` }} aria-hidden="true" />
          <span>
            <b>{selectedMetadata.label}</b>
            <small>{selectedMetadata.pressureLabel} · {selectedMetadata.approximateHeightLabel}</small>
          </span>
        </div>
        <div className="field-key-heading"><span>{selectedMetadata.label} wind speed</span><strong>m/s</strong></div>
        <div className="speed-ramp" aria-hidden="true" />
        <div className="speed-labels" aria-hidden="true"><span>0</span><span>10</span><span>20</span><span>35+</span></div>
      </section>

      {loadState !== "ready" && (
        <div className={loadState === "error" ? "data-status error" : "data-status"} role="status">
          {loadState === "loading" ? (
            <><span className="status-pulse" aria-hidden="true" /> Loading atmospheric field and renderer</>
          ) : (
            <><span>{error}</span><button type="button" onClick={retryWind}>Retry</button></>
          )}
        </div>
      )}

      {loadState === "ready" && refinementState === "loading" && (
        <div className="refinement-status" role="status">
          <span className="status-pulse" aria-hidden="true" /> Refining this view
        </div>
      )}

      {selected ? (
        <section
          className={selectionExpanded ? "selection-card expanded" : "selection-card collapsed"}
          aria-live="polite"
        >
          <button
            className="selection-toggle"
            type="button"
            onClick={() => setSelectionExpanded((current) => !current)}
            aria-expanded={selectionExpanded}
            aria-controls="selection-details"
            aria-label={selectionExpanded ? "Collapse atmospheric comparison" : "Expand atmospheric comparison"}
          >
            <span aria-hidden="true">⌃</span>
          </button>
          <button className="selection-close" type="button" onClick={() => setSelected(null)} aria-label="Clear selected point">×</button>
          <div className="selection-heading">
            <div>
              <span className="hud-label">Atmosphere arriving here</span>
              <p className="selection-coordinate">{formatCoordinate(selected)}</p>
            </div>
            {selectedReading && (
              <div className="selection-peek">
                <strong>{speedMph(selectedReading)} mph</strong>
                <span>{selectedMetadata.label}</span>
                {selectedReading.belowTerrain && <small>Below terrain</small>}
              </div>
            )}
          </div>
          <div className="selection-details" id="selection-details">
            <div className="air-column">
              {levelReadings.slice().reverse().map(({ level, reading }) => (
                <button
                  type="button"
                  className={level.id === selectedLevel ? "selected" : ""}
                  key={level.id}
                  disabled={!reading}
                  onClick={() => setSelectedLevel(level.id)}
                >
                  <i style={{ background: `rgb(${level.color.slice(0, 3).join(" ")})` }} />
                  <span><b>{level.label}</b><small>{level.pressureLabel}</small></span>
                  {reading ? (
                    <>
                      <em style={{ transform: `rotate(${reading.direction + 180}deg)` }}>↑</em>
                      <strong>{speedMph(reading)}<small> mph</small></strong>
                      <u>{reading.belowTerrain ? "Below local terrain" : formatHeight(level.id, reading.heightMeters)}</u>
                    </>
                  ) : (
                    <u>No data</u>
                  )}
                </button>
              ))}
            </div>
            <div className="trajectory-control">
              <span>Trajectories</span>
              <div role="group" aria-label="Visible backward trajectories">
                <button
                  type="button"
                  className={!showAllPaths ? "active" : ""}
                  onClick={() => setShowAllPaths(false)}
                  aria-pressed={!showAllPaths}
                >
                  Selected level
                </button>
                <button
                  type="button"
                  className={showAllPaths ? "active" : ""}
                  onClick={() => setShowAllPaths(true)}
                  aria-pressed={showAllPaths}
                >
                  All four
                </button>
              </div>
            </div>
            {selectedReading && (
              <div className="trace-summary">
                <span className="trace-line" style={{ background: `rgb(${selectedMetadata.color.slice(0, 3).join(" ")})` }} aria-hidden="true" />
                <span><strong>{TRACE_HOURS}-hour {selectedMetadata.label.toLowerCase()} path</strong>Modeled horizontal flow at {selectedMetadata.pressureLabel}</span>
              </div>
            )}
          </div>
        </section>
      ) : (
        <div className="map-hint"><span aria-hidden="true">+</span> Click anywhere to compare all four levels and trace where the air came from</div>
      )}

      {locationError && <div className="location-error" role="status">{locationError}</div>}

      <section className="timeline" aria-label="Forecast time controls">
        <button
          className="play-control"
          type="button"
          onClick={() => setPlaying((current) => !current)}
          disabled={!nationalField}
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
            min={minimumTimePosition}
            max={maximumTimePosition}
            step="0.02"
            value={timePosition}
            onInput={(event) => {
              setPlaying(false);
              scrubTimePosition(Number(event.currentTarget.value));
            }}
            disabled={!nationalField}
            aria-label="Forecast valid time"
          />
          <div className="timeline-meta">
            <span>−{DISPLAY_PAST_HOURS} h</span>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                updateTimePosition(nowIndex);
              }}
              disabled={!nationalField}
            >
              Now
            </button>
            <span>+48 h</span>
          </div>
        </div>
        <span className="relative-time">{nationalField ? relativeHourLabel(timePosition, nowIndex) : ""}</span>
      </section>

      <div className={infoOpen ? "info-scrim open" : "info-scrim"} onClick={() => setInfoOpen(false)} aria-hidden="true" />
      <aside className={infoOpen ? "info-panel open" : "info-panel"} aria-hidden={!infoOpen}>
        <button className="info-close" type="button" onClick={() => setInfoOpen(false)} aria-label="Close information">×</button>
        <span className="hud-label">About the field</span>
        <h1>Read the atmosphere,<br />not a dashboard.</h1>
        <p className="info-intro">Particles show the selected forecast wind field. The altitude rail moves between four pressure levels; clicking the map compares the full air column and traces its modeled flow backward. Zooming requests a denser regional sample, and time blends continuously between hourly model frames.</p>

        <dl className="facts">
          <div><dt>Model</dt><dd>NOAA GFS + HRRR seamless</dd></div>
          <div><dt>Levels</dt><dd>10 m · 850 · 500 · 250 hPa</dd></div>
          <div><dt>Coverage</dt><dd>Contiguous United States</dd></div>
          <div><dt>Delivery</dt><dd>Open-Meteo · live JSON</dd></div>
        </dl>

        <section className="method-note">
          <h2>Pressure levels and height</h2>
          <p>Pressure surfaces use modeled geopotential height above sea level, so their actual altitude changes with place and time. Surface wind remains ten metres above local ground.</p>
        </section>

        <section className="method-note">
          <h2>When you select a point</h2>
          <p>Each highlighted line follows the gridded wind backward one hour at a time while remaining on its selected pressure surface. It is a useful kinematic estimate—not an observation, source-apportionment result, or HYSPLIT trajectory.</p>
        </section>

        <section className="method-note">
          <h2>Scientific limits</h2>
          <p>Particles are a visual reading of interpolated forecast fields. Turbulence, chemistry, dispersion, and vertical parcel motion are not represented. Pressure-level values below local ground are model extrapolations rather than physical air, and are flagged wherever the model provides them.</p>
        </section>

        <div className="source-links">
          <a href="https://open-meteo.com/en/docs/gfs-api" target="_blank" rel="noreferrer">Forecast documentation ↗</a>
          <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast" target="_blank" rel="noreferrer">About NOAA GFS ↗</a>
        </div>
      </aside>
    </main>
  );
}
