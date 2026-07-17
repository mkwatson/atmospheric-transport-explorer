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
  depthExaggeration,
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

type SegmentDatum = Readonly<{
  source: readonly [number, number, number];
  target: readonly [number, number, number];
  color: readonly [number, number, number, number];
  width: number;
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
const PARTICLE_SPEED_FACTOR: Readonly<Record<WindLevelId, number>> = {
  surface: 1.5,
  "850hPa": 1.05,
  "500hPa": 0.82,
  "250hPa": 0.65,
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

const speedMph = (reading: WindReading) =>
  Math.round(reading.speed * 2.236_936);

const elevatedArrowSegments = (
  field: WindField,
  levelId: WindLevelId,
  timePosition: number,
  heightScale: number,
  selected: boolean,
): readonly SegmentDatum[] => {
  const metadata = windLevel(levelId);
  const gridStep = field.width > 18 ? 2 : 1;
  const lonStep = (field.bounds.east - field.bounds.west) / (field.width - 1);
  const latStep = (field.bounds.north - field.bounds.south) / (field.height - 1);
  const maximumLength = Math.min(lonStep, latStep) * 0.66;

  return field.latitudes.flatMap((lat, row) =>
    field.longitudes.flatMap((lon, column) => {
      if (row % gridStep !== 0 || column % gridStep !== 0) return [];
      const reading = sampleWind(field, timePosition, { lon, lat }, levelId);
      if (!reading || reading.speed < 0.2) return [];
      const length = maximumLength * (0.3 + Math.min(1, reading.speed / 35) * 0.7);
      const magnitude = Math.hypot(reading.u, reading.v);
      const dx = (reading.u / magnitude) * length;
      const dy = (reading.v / magnitude) * length;
      const tip: [number, number, number] = [
        lon + dx / Math.max(0.35, Math.cos((lat * Math.PI) / 180)),
        lat + dy,
        reading.heightMeters * heightScale,
      ];
      const tail: [number, number, number] = [
        lon - dx * 0.4,
        lat - dy * 0.4,
        reading.heightMeters * heightScale,
      ];
      const headLength = length * 0.28;
      const ux = dx / length;
      const uy = dy / length;
      const backX = tip[0] - ux * headLength;
      const backY = tip[1] - uy * headLength;
      const left: [number, number, number] = [
        backX - uy * headLength * 0.55,
        backY + ux * headLength * 0.55,
        tip[2],
      ];
      const right: [number, number, number] = [
        backX + uy * headLength * 0.55,
        backY - ux * headLength * 0.55,
        tip[2],
      ];
      const color = [
        metadata.color[0],
        metadata.color[1],
        metadata.color[2],
        selected ? 245 : 165,
      ] as const;
      const width = selected ? 2.4 : 1.35;

      return [
        { source: tail, target: tip, color, width },
        { source: tip, target: left, color, width },
        { source: tip, target: right, color, width },
      ];
    }),
  );
};

const atmosphericGuidePath = (
  bounds: WindBounds,
  heightMeters: number,
): [number, number, number][] => [
  [bounds.west, bounds.south, heightMeters],
  [bounds.east, bounds.south, heightMeters],
  [bounds.east, bounds.north, heightMeters],
  [bounds.west, bounds.north, heightMeters],
  [bounds.west, bounds.south, heightMeters],
];

export default function Home() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const selectedMarkerRef = useRef<Marker | null>(null);
  const regionalCacheRef = useRef(new Map<string, WindField>());
  const lastPrimaryFieldRef = useRef<WindField | null>(null);
  const timePositionRef = useRef(0);
  const previousCameraRef = useRef({ pitch: 18, bearing: -7 });
  const [mapReady, setMapReady] = useState(false);
  const [nationalField, setNationalField] = useState<WindField | null>(null);
  const [regionalField, setRegionalField] = useState<WindField | null>(null);
  const [previousPrimaryField, setPreviousPrimaryField] = useState<WindField | null>(null);
  const [fieldBlend, setFieldBlend] = useState(1);
  const [timePosition, setTimePosition] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [refinementState, setRefinementState] = useState<RefinementState>("national");
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Coordinate | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<WindLevelId>("surface");
  const [showAllPaths, setShowAllPaths] = useState(false);
  const [compareAtmosphere, setCompareAtmosphere] = useState(false);
  const [depthMode, setDepthMode] = useState(false);
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [viewportBounds, setViewportBounds] = useState<WindBounds | null>(null);
  const [mapZoom, setMapZoom] = useState(3.15);
  const [viewportPixels, setViewportPixels] = useState(1_000_000);
  const [isMobile, setIsMobile] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [weatherLayers, setWeatherLayers] = useState<WeatherLayersModule | null>(null);

  const updateViewport = useCallback((map: MapLibreMap) => {
    const nextBounds = regionalViewport(map);
    setViewportBounds(nextBounds);
    if (!nextBounds) {
      setRegionalField(null);
      setRefinementState("national");
    }
    setMapZoom(map.getZoom());
    const canvas = map.getCanvas();
    setViewportPixels(canvas.clientWidth * canvas.clientHeight);
    setIsMobile(canvas.clientWidth < 720);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let current = true;
    import("weatherlayers-gl").then((module) => {
      if (current) setWeatherLayers(module);
    });
    return () => {
      current = false;
    };
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
      updateViewport(map);
      setMapReady(true);
    });

    map.on("moveend", () => updateViewport(map));
    map.on("resize", () => updateViewport(map));
    map.on("click", ({ lngLat }) => {
      const coordinate = { lon: lngLat.lng, lat: lngLat.lat };
      setLevelMenuOpen(false);
      if (!containsCoordinate(NATIONAL_WIND_BOUNDS, coordinate)) {
        setLocationError("Choose a point inside the contiguous U.S. wind field.");
        return;
      }
      setSelected(coordinate);
      setLocationError("");
    });

    mapRef.current = map;
    return () => {
      overlayRef.current?.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [updateViewport]);

  useEffect(() => {
    const controller = new AbortController();
    fetchWindField(controller.signal)
      .then((field) => {
        const nowIndex = nearestTimeIndex(field.times, new Date());
        timePositionRef.current = nowIndex;
        setTimePosition(nowIndex);
        setNationalField(field);
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
  const activePrimaryField = desiredPrimaryField;

  useEffect(() => {
    if (!desiredPrimaryField) return;
    const previous = lastPrimaryFieldRef.current;
    lastPrimaryFieldRef.current = desiredPrimaryField;
    if (!previous || previous === desiredPrimaryField || reducedMotion) {
      setPreviousPrimaryField(null);
      setFieldBlend(1);
      return;
    }

    setPreviousPrimaryField(previous);
    setFieldBlend(0);
  }, [desiredPrimaryField, reducedMotion]);

  useEffect(() => {
    if (!previousPrimaryField || reducedMotion) return;
    const startedAt = performance.now();
    let animationFrame = 0;
    const animate = (now: number) => {
      const nextBlend = Math.min(1, (now - startedAt) / 480);
      setFieldBlend(nextBlend);
      if (nextBlend < 1) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        setPreviousPrimaryField(null);
      }
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [previousPrimaryField, reducedMotion]);

  const minimumTimePosition = TRACE_HOURS;
  const maximumTimePosition = Math.max(
    minimumTimePosition,
    (nationalField?.times.length ?? 1) - 1,
  );
  const nowIndex = nationalField
    ? nearestTimeIndex(nationalField.times, new Date())
    : DISPLAY_PAST_HOURS + TRACE_HOURS;

  const updateTimePosition = useCallback(
    (position: number) => {
      const bounded = Math.min(maximumTimePosition, Math.max(minimumTimePosition, position));
      timePositionRef.current = bounded;
      setTimePosition(bounded);
    },
    [maximumTimePosition, minimumTimePosition],
  );

  useEffect(() => {
    if (!playing || !nationalField) return;
    let animationFrame = 0;
    let previousTimestamp = performance.now();
    const animate = (timestamp: number) => {
      const elapsed = timestamp - previousTimestamp;
      previousTimestamp = timestamp;
      let next =
        timePositionRef.current + elapsed / PLAYBACK_MILLISECONDS_PER_HOUR;
      if (next > maximumTimePosition) {
        next = minimumTimePosition + (next - maximumTimePosition);
      }
      updateTimePosition(next);
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [maximumTimePosition, minimumTimePosition, nationalField, playing, updateTimePosition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === "Escape") {
        setLevelMenuOpen(false);
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
    const map = mapRef.current;
    if (!map) return;
    if (depthMode) {
      previousCameraRef.current = { pitch: map.getPitch(), bearing: map.getBearing() };
      map.easeTo({ pitch: 56, bearing: -18, duration: reducedMotion ? 0 : 850 });
      return;
    }
    const previous = previousCameraRef.current;
    map.easeTo({
      pitch: previous.pitch,
      bearing: previous.bearing,
      duration: reducedMotion ? 0 : 700,
    });
  }, [depthMode, reducedMotion]);

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

  const zoomDensity = 1 + Math.max(0, Math.min(4, mapZoom - 3.2)) * 0.18;
  const particleCount = Math.max(
    isMobile ? 1_800 : 4_800,
    Math.min(
      isMobile ? 5_500 : 12_000,
      Math.round((viewportPixels / 160) * zoomDensity),
    ),
  );
  const selectedMetadata = windLevel(selectedLevel);
  const heightScale = depthExaggeration(mapZoom);
  const validTime = nationalField
    ? timeAtPosition(nationalField.times, timePosition)
    : null;

  const levelReadings = useMemo(
    () =>
      selected && nationalField
        ? WIND_LEVELS.map((level) => ({
            level,
            reading: sampleWind(nationalField, timePosition, selected, level.id),
          }))
        : [],
    [nationalField, selected, timePosition],
  );

  const selectedReading = useMemo(() => {
    if (!selected || !nationalField) return null;
    const detailedField =
      regionalField &&
      regionalField.levels[selectedLevel] &&
      containsCoordinate(regionalField.bounds, selected)
        ? regionalField
        : nationalField;
    return sampleWind(detailedField, timePosition, selected, selectedLevel);
  }, [nationalField, regionalField, selected, selectedLevel, timePosition]);

  const traces = useMemo<readonly TraceDatum[]>(() => {
    if (!selected || !nationalField) return [];
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

  const deckLayers = useMemo(() => {
    const layers: Layer[] = [];
    if (!weatherLayers) return layers;
    const {
      GridLayer,
      GridStyle,
      ImageInterpolation,
      ImageType,
      ParticleLayer,
    } = weatherLayers;
    const particleLayerFor = (
      field: WindField | null,
      id: string,
      opacity: number,
    ) => {
      if (!field?.levels[selectedLevel] || opacity <= 0.001) return null;
      const pair = texturePair(field, selectedLevel, timePosition);
      if (!pair.image || !pair.image2) return null;
      return new ParticleLayer({
        id,
        image: pair.image,
        image2: pair.image2,
        imageWeight: pair.imageWeight,
        imageType: ImageType.VECTOR,
        imageInterpolation: ImageInterpolation.CUBIC,
        bounds: textureBounds(field.bounds),
        palette: SPEED_PALETTE.map(([value, color]) => [value, color]),
        numParticles: particleCount,
        maxAge: 110,
        speedFactor: PARTICLE_SPEED_FACTOR[selectedLevel],
        width: isMobile ? 1.2 : 1.55,
        opacity: opacity * 0.92,
        animate: !reducedMotion,
        pickable: false,
      });
    };

    if (!depthMode) {
      const previousParticles = particleLayerFor(
        previousPrimaryField,
        "primary-wind-previous",
        1 - fieldBlend,
      );
      const currentParticles = particleLayerFor(
        activePrimaryField,
        "primary-wind-current",
        fieldBlend,
      );
      if (previousParticles) layers.push(previousParticles);
      if (currentParticles) layers.push(currentParticles);
    }

    if (reducedMotion && !depthMode && activePrimaryField?.levels[selectedLevel]) {
      const pair = texturePair(activePrimaryField, selectedLevel, timePosition);
      if (pair.image && pair.image2) {
        layers.push(
          new GridLayer({
            id: "reduced-motion-wind",
            image: pair.image,
            image2: pair.image2,
            imageWeight: pair.imageWeight,
            imageType: ImageType.VECTOR,
            imageInterpolation: ImageInterpolation.CUBIC,
            bounds: textureBounds(activePrimaryField.bounds),
            style: GridStyle.ARROW,
            density: 1,
            iconBounds: [0, 40],
            iconSize: [8, 21],
            iconColor: selectedMetadata.color,
            opacity: 0.88,
          }),
        );
      }
    }

    if (compareAtmosphere && nationalField && !depthMode) {
      WIND_LEVELS.filter(({ id }) => id !== selectedLevel).forEach((level) => {
        const pair = texturePair(nationalField, level.id, timePosition);
        if (!pair.image || !pair.image2) return;
        layers.push(
          new GridLayer({
            id: `context-${level.id}`,
            image: pair.image,
            image2: pair.image2,
            imageWeight: pair.imageWeight,
            imageType: ImageType.VECTOR,
            imageInterpolation: ImageInterpolation.CUBIC,
            bounds: textureBounds(nationalField.bounds),
            style: GridStyle.ARROW,
            density: -1,
            iconBounds: [0, 50],
            iconSize: [5, 13],
            iconColor: level.color,
            opacity: 0.38,
          }),
        );
      });
    }

    if (depthMode && nationalField) {
      const segments = WIND_LEVELS.flatMap((level) =>
        elevatedArrowSegments(
          nationalField,
          level.id,
          timePosition,
          heightScale,
          level.id === selectedLevel,
        ),
      );
      layers.push(
        new PathLayer<SegmentDatum>({
          id: "elevated-wind-context",
          data: segments,
          getPath: ({ source, target }) => [source, target],
          getColor: ({ color }) => color,
          getWidth: ({ width }) => width,
          widthUnits: "pixels",
          widthMinPixels: 1,
          opacity: 0.96,
          pickable: false,
        }),
      );

      const guides = WIND_LEVELS.map((level) => ({
        id: level.id,
        path: atmosphericGuidePath(
          NATIONAL_WIND_BOUNDS,
          level.nominalHeightMeters * heightScale,
        ),
        color: [level.color[0], level.color[1], level.color[2], 42] as const,
      }));
      layers.push(
        new PathLayer({
          id: "atmospheric-level-guides",
          data: guides,
          getPath: (datum: (typeof guides)[number]) => datum.path,
          getColor: (datum: (typeof guides)[number]) => datum.color,
          getWidth: 0.8,
          widthUnits: "pixels",
          pickable: false,
        }),
      );
    }

    if (traces.length > 0) {
      const tracePath = (datum: TraceDatum): [number, number, number][] =>
        datum.path.map(({ lon, lat, heightMeters }) => [
          lon,
          lat,
          depthMode ? heightMeters * heightScale : 0,
        ]);
      layers.push(
        new PathLayer<TraceDatum>({
          id: "backward-trace-glow",
          data: traces,
          getPath: tracePath,
          getColor: ({ color, selected: isSelected }) => [
            color[0],
            color[1],
            color[2],
            isSelected ? 55 : 20,
          ],
          getWidth: ({ selected: isSelected }) => (isSelected ? 10 : 5),
          widthUnits: "pixels",
          jointRounded: true,
          capRounded: true,
          pickable: false,
          parameters: { depthCompare: depthMode ? "less-equal" : "always" },
        }),
        new PathLayer<TraceDatum>({
          id: "backward-traces",
          data: traces,
          getPath: tracePath,
          getColor: ({ color, selected: isSelected }) => [
            color[0],
            color[1],
            color[2],
            isSelected ? 245 : 155,
          ],
          getWidth: ({ selected: isSelected }) => (isSelected ? 2.8 : 1.35),
          widthUnits: "pixels",
          jointRounded: true,
          capRounded: true,
          pickable: false,
          parameters: { depthCompare: depthMode ? "less-equal" : "always" },
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
            depthMode ? (position?.heightMeters ?? 0) * heightScale : 0,
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

    if (depthMode && selected && levelReadings.length > 0) {
      const available = levelReadings.filter(
        (item): item is typeof item & { reading: WindReading } => Boolean(item.reading),
      );
      const maximumHeight = Math.max(
        0,
        ...available.map(({ reading }) => reading.heightMeters * heightScale),
      );
      const column = [
        {
          path: [
            [selected.lon, selected.lat, 0],
            [selected.lon, selected.lat, maximumHeight],
          ] as [number, number, number][],
        },
      ];
      layers.push(
        new PathLayer<(typeof column)[number]>({
          id: "selected-air-column",
          data: column,
          getPath: ({ path }) => path,
          getColor: [220, 238, 235, 125],
          getWidth: 1.2,
          widthUnits: "pixels",
          pickable: false,
        }),
        new ScatterplotLayer({
          id: "selected-air-column-levels",
          data: available,
          getPosition: ({ reading }) => [
            selected.lon,
            selected.lat,
            reading.heightMeters * heightScale,
          ],
          getFillColor: ({ level }) => level.color,
          getLineColor: [5, 12, 18, 230],
          getRadius: ({ level }) => (level.id === selectedLevel ? 6 : 3.8),
          radiusUnits: "pixels",
          stroked: true,
          getLineWidth: 1.4,
          lineWidthUnits: "pixels",
          pickable: false,
        }),
      );
    }

    return layers;
  }, [
    activePrimaryField,
    compareAtmosphere,
    depthMode,
    fieldBlend,
    heightScale,
    isMobile,
    levelReadings,
    nationalField,
    particleCount,
    previousPrimaryField,
    reducedMotion,
    selected,
    selectedLevel,
    selectedMetadata.color,
    timePosition,
    traces,
    weatherLayers,
  ]);

  useEffect(() => {
    overlayRef.current?.setProps({ layers: deckLayers });
  }, [deckLayers, mapReady]);

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

  const toggleDepth = () => {
    setDepthMode((current) => {
      const next = !current;
      if (next) setCompareAtmosphere(true);
      return next;
    });
  };

  return (
    <main className={depthMode ? "experience depth-mode" : "experience"}>
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
          {depthMode && (
            <span className="depth-status">Depth · height ×{heightScale}</span>
          )}
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
        <button
          className="level-trigger"
          type="button"
          onClick={() => setLevelMenuOpen((current) => !current)}
          aria-expanded={levelMenuOpen}
          aria-controls="level-menu"
        >
          <span>
            <i style={{ background: `rgb(${selectedMetadata.color.slice(0, 3).join(" ")})` }} />
            <b>{selectedMetadata.label}</b>
            <small>{selectedMetadata.pressureLabel}</small>
          </span>
          <em aria-hidden="true">⌄</em>
        </button>
        <div className="field-key-heading"><span>Wind speed</span><strong>m/s</strong></div>
        <div className="speed-ramp" aria-hidden="true" />
        <div className="speed-labels" aria-hidden="true"><span>0</span><span>10</span><span>20</span><span>35+</span></div>

        {levelMenuOpen && (
          <div className="level-menu" id="level-menu">
            <span className="hud-label">Atmospheric level</span>
            <div className="level-options">
              {WIND_LEVELS.slice().reverse().map((level) => (
                <button
                  type="button"
                  className={level.id === selectedLevel ? "selected" : ""}
                  key={level.id}
                  onClick={() => {
                    setSelectedLevel(level.id);
                    setLevelMenuOpen(false);
                  }}
                >
                  <i style={{ background: `rgb(${level.color.slice(0, 3).join(" ")})` }} />
                  <span><b>{level.label}</b><small>{level.pressureLabel} · {level.approximateHeightLabel}</small></span>
                  <em>{level.id === selectedLevel ? "●" : ""}</em>
                </button>
              ))}
            </div>
            <div className="level-modes">
              <button
                type="button"
                className={compareAtmosphere ? "active" : ""}
                onClick={() => setCompareAtmosphere((current) => !current)}
                aria-pressed={compareAtmosphere}
              >
                <span>Atmospheric stack</span><small>Compare all four levels</small>
              </button>
              <button
                type="button"
                className={depthMode ? "active" : ""}
                onClick={toggleDepth}
                aria-pressed={depthMode}
              >
                <span>Depth view</span><small>Tilt and separate the atmosphere</small>
              </button>
            </div>
          </div>
        )}
      </section>

      {loadState !== "ready" && (
        <div className={loadState === "error" ? "data-status error" : "data-status"} role="status">
          {loadState === "loading" ? (
            <><span className="status-pulse" aria-hidden="true" /> Loading NOAA atmospheric field</>
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
        <section className="selection-card" aria-live="polite">
          <button className="selection-close" type="button" onClick={() => setSelected(null)} aria-label="Clear selected point">×</button>
          <span className="hud-label">Wind column arriving here</span>
          <p className="selection-coordinate">{formatCoordinate(selected)}</p>
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
                    <u>{formatHeight(level.id, reading.heightMeters)}</u>
                  </>
                ) : (
                  <u>Below terrain</u>
                )}
              </button>
            ))}
          </div>
          <div className="trace-actions">
            <button
              type="button"
              className={showAllPaths ? "active" : ""}
              onClick={() => setShowAllPaths((current) => !current)}
              aria-pressed={showAllPaths}
            >
              {showAllPaths ? "Solo selected path" : "Show all four paths"}
            </button>
            <button
              type="button"
              className={depthMode ? "active" : ""}
              onClick={toggleDepth}
              aria-pressed={depthMode}
            >
              {depthMode ? "Flatten atmosphere" : "See atmospheric depth"}
            </button>
          </div>
          {selectedReading && (
            <div className="trace-summary">
              <span className="trace-line" style={{ background: `rgb(${selectedMetadata.color.slice(0, 3).join(" ")})` }} aria-hidden="true" />
              <span><strong>{TRACE_HOURS}-hour {selectedMetadata.label.toLowerCase()} path</strong>Modeled horizontal flow at {selectedMetadata.pressureLabel}</span>
            </div>
          )}
        </section>
      ) : (
        <div className="map-hint"><span aria-hidden="true">+</span> Click anywhere to compare the air column arriving there</div>
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
              updateTimePosition(Number(event.currentTarget.value));
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
        <p className="info-intro">Particles show the selected forecast wind field. Zooming requests a denser regional sample; time blends continuously between hourly model frames. The atmospheric stack compares four horizontal pressure levels without pretending they are one vertical parcel path.</p>

        <dl className="facts">
          <div><dt>Model</dt><dd>NOAA GFS + HRRR seamless</dd></div>
          <div><dt>Levels</dt><dd>10 m · 850 · 500 · 250 hPa</dd></div>
          <div><dt>Coverage</dt><dd>Contiguous United States</dd></div>
          <div><dt>Delivery</dt><dd>Open-Meteo · live JSON</dd></div>
        </dl>

        <section className="method-note">
          <h2>Atmospheric depth</h2>
          <p>Pressure surfaces use their modeled geopotential heights above sea level. Height is exaggerated by the factor shown onscreen so the atmosphere is visible at continental scale. Surface wind remains ten metres above local ground.</p>
        </section>

        <section className="method-note">
          <h2>When you select a point</h2>
          <p>Each highlighted line follows the gridded wind backward one hour at a time while remaining on its selected pressure surface. It is a useful kinematic estimate—not an observation, source-apportionment result, or HYSPLIT trajectory.</p>
        </section>

        <section className="method-note">
          <h2>Scientific limits</h2>
          <p>Particles are a visual reading of interpolated forecast fields. Turbulence, chemistry, dispersion, and vertical parcel motion are not represented. Pressure-level values below terrain are hidden.</p>
        </section>

        <div className="source-links">
          <a href="https://open-meteo.com/en/docs/gfs-api" target="_blank" rel="noreferrer">Forecast documentation ↗</a>
          <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast" target="_blank" rel="noreferrer">About NOAA GFS ↗</a>
        </div>
      </aside>
    </main>
  );
}
