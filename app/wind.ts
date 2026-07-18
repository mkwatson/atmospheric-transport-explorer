import { z } from "zod";

export const DISPLAY_PAST_HOURS = 24;
export const TRACE_HOURS = 18;
const FORECAST_HOURS = 49;
const FETCH_PAST_HOURS = DISPLAY_PAST_HOURS + TRACE_HOURS;

export const NATIONAL_WIND_BOUNDS = {
  west: -128,
  east: -65,
  north: 52,
  south: 22,
} as const;

export type WindBounds = Readonly<{
  west: number;
  east: number;
  north: number;
  south: number;
}>;

export const WIND_LEVELS = [
  {
    id: "surface",
    label: "Surface",
    atmosphericLabel: "Near the ground",
    pressureLabel: "10 m",
    approximateHeightLabel: "10 m above ground",
    nominalHeightMeters: 10,
    color: [139, 233, 220, 255] as const,
    speedVariable: "wind_speed_10m",
    directionVariable: "wind_direction_10m",
    heightVariable: null,
  },
  {
    id: "850hPa",
    label: "Lower air",
    atmosphericLabel: "Lower atmosphere",
    pressureLabel: "850 hPa",
    approximateHeightLabel: "about 1.5 km",
    nominalHeightMeters: 1_500,
    color: [255, 189, 118, 255] as const,
    speedVariable: "wind_speed_850hPa",
    directionVariable: "wind_direction_850hPa",
    heightVariable: "geopotential_height_850hPa",
  },
  {
    id: "500hPa",
    label: "Mid atmosphere",
    atmosphericLabel: "Middle atmosphere",
    pressureLabel: "500 hPa",
    approximateHeightLabel: "about 5.6 km",
    nominalHeightMeters: 5_600,
    color: [202, 159, 255, 255] as const,
    speedVariable: "wind_speed_500hPa",
    directionVariable: "wind_direction_500hPa",
    heightVariable: "geopotential_height_500hPa",
  },
  {
    id: "250hPa",
    label: "Jet stream",
    atmosphericLabel: "Upper atmosphere",
    pressureLabel: "250 hPa",
    approximateHeightLabel: "about 10.4 km",
    nominalHeightMeters: 10_400,
    color: [126, 163, 255, 255] as const,
    speedVariable: "wind_speed_250hPa",
    directionVariable: "wind_direction_250hPa",
    heightVariable: "geopotential_height_250hPa",
  },
] as const;

export type WindLevel = (typeof WIND_LEVELS)[number];
export type WindLevelId = WindLevel["id"];

export const windLevel = (id: WindLevelId) =>
  WIND_LEVELS.find((level) => level.id === id) ?? WIND_LEVELS[0];

export const SPEED_PALETTE = [
  [0, "#7399e8"],
  [3, "#59cff4"],
  [6, "#66e7c8"],
  [9, "#caeb8b"],
  [13, "#ffd370"],
  [18, "#ff9a63"],
  [25, "#f7607a"],
  [35, "#cd84ff"],
] as const;

export type Coordinate = Readonly<{
  lon: number;
  lat: number;
}>;

export type WindVector = Readonly<{
  u: number;
  v: number;
  speed: number;
  direction: number;
}>;

export type WindReading = WindVector &
  Readonly<{
    heightMeters: number;
    belowTerrain: boolean;
  }>;

export type TracePoint = Coordinate &
  Readonly<{
    heightMeters: number;
  }>;

type WindFrame = Readonly<{
  u: readonly number[];
  v: readonly number[];
  heights: readonly number[];
}>;

export type WindLevelField = Readonly<{
  frames: readonly WindFrame[];
}>;

export type WindField = Readonly<{
  times: readonly Date[];
  levels: Readonly<Partial<Record<WindLevelId, WindLevelField>>>;
  longitudes: readonly number[];
  latitudes: readonly number[];
  elevations: readonly number[];
  width: number;
  height: number;
  bounds: WindBounds;
}>;

type WindFetchSpec = Readonly<{
  bounds?: WindBounds;
  width?: number;
  height?: number;
  levels?: readonly WindLevelId[];
}>;

const numericSeriesSchema = z.array(z.number().nullable());
const hourlySchema = z.object({
  time: z.array(z.string()),
  wind_speed_10m: numericSeriesSchema.optional(),
  wind_direction_10m: numericSeriesSchema.optional(),
  wind_speed_850hPa: numericSeriesSchema.optional(),
  wind_direction_850hPa: numericSeriesSchema.optional(),
  geopotential_height_850hPa: numericSeriesSchema.optional(),
  wind_speed_500hPa: numericSeriesSchema.optional(),
  wind_direction_500hPa: numericSeriesSchema.optional(),
  geopotential_height_500hPa: numericSeriesSchema.optional(),
  wind_speed_250hPa: numericSeriesSchema.optional(),
  wind_direction_250hPa: numericSeriesSchema.optional(),
  geopotential_height_250hPa: numericSeriesSchema.optional(),
});

type Hourly = z.infer<typeof hourlySchema>;
type NumericSeriesKey = Exclude<keyof Hourly, "time">;

const forecastLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number(),
  hourly: hourlySchema,
});

const forecastResponseSchema = z.array(forecastLocationSchema);

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const unique = <T,>(values: readonly T[]) => [...new Set(values)];

const gridFor = (bounds: WindBounds, width: number, height: number) => {
  const longitudes = Array.from(
    { length: width },
    (_, index) =>
      bounds.west + (index * (bounds.east - bounds.west)) / (width - 1),
  );
  const latitudes = Array.from(
    { length: height },
    (_, index) =>
      bounds.north - (index * (bounds.north - bounds.south)) / (height - 1),
  );
  const coordinates = latitudes.flatMap((lat) =>
    longitudes.map((lon) => ({ lat, lon })),
  );

  return { coordinates, latitudes, longitudes };
};

export const meteorologicalWindToVector = (
  speed: number,
  direction: number,
): WindVector => {
  const radians = (direction * Math.PI) / 180;
  const u = -speed * Math.sin(radians);
  const v = -speed * Math.cos(radians);

  return { u, v, speed, direction };
};

const vectorToMeteorologicalDirection = (u: number, v: number) =>
  ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;

const isoUtcDate = (value: string) => {
  const timestamp = Date.parse(`${value}Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`The weather service returned an invalid time: ${value}`);
  }
  return new Date(timestamp);
};

const series = (
  hourly: Hourly,
  key: NumericSeriesKey,
  expectedLength: number,
) => {
  const values = hourly[key];
  if (!values || values.length !== expectedLength) {
    throw new Error(`The weather service omitted or truncated ${key}.`);
  }
  return values;
};

export const parseWindField = (
  input: unknown,
  spec: Required<WindFetchSpec>,
): WindField => {
  const locations = forecastResponseSchema.parse(input);
  const { coordinates, latitudes, longitudes } = gridFor(
    spec.bounds,
    spec.width,
    spec.height,
  );

  if (locations.length !== coordinates.length) {
    throw new Error(
      `Expected ${coordinates.length} wind locations but received ${locations.length}.`,
    );
  }

  const expectedTimes = locations[0]?.hourly.time ?? [];
  if (expectedTimes.length === 0) {
    throw new Error("The weather service returned no forecast times.");
  }

  const hasConsistentTimes = locations.every(
    ({ hourly }) =>
      hourly.time.length === expectedTimes.length &&
      hourly.time.every((time, index) => time === expectedTimes[index]),
  );
  if (!hasConsistentTimes) {
    throw new Error("The weather service returned an inconsistent wind grid.");
  }

  const levels = spec.levels.reduce<Partial<Record<WindLevelId, WindLevelField>>>(
    (parsed, levelId) => {
      const metadata = windLevel(levelId);
      const frames = expectedTimes.map((_, timeIndex) => {
        const values = locations.map(({ elevation, hourly }) => {
          const speed = series(
            hourly,
            metadata.speedVariable,
            expectedTimes.length,
          )[timeIndex];
          const direction = series(
            hourly,
            metadata.directionVariable,
            expectedTimes.length,
          )[timeIndex];
          const pressureHeight = metadata.heightVariable
            ? series(hourly, metadata.heightVariable, expectedTimes.length)[timeIndex]
            : elevation + metadata.nominalHeightMeters;

          if (
            speed === null ||
            direction === null ||
            pressureHeight === null
          ) {
            return { u: Number.NaN, v: Number.NaN, height: Number.NaN };
          }

          const vector = meteorologicalWindToVector(speed, direction);
          return { u: vector.u, v: vector.v, height: pressureHeight };
        });

        return {
          u: values.map(({ u }) => u),
          v: values.map(({ v }) => v),
          heights: values.map(({ height }) => height),
        };
      });

      return { ...parsed, [levelId]: { frames } };
    },
    {},
  );

  return {
    times: expectedTimes.map(isoUtcDate),
    levels,
    longitudes,
    latitudes,
    elevations: locations.map(({ elevation }) => elevation),
    width: spec.width,
    height: spec.height,
    bounds: spec.bounds,
  };
};

const normalizedSpec = (spec: WindFetchSpec = {}): Required<WindFetchSpec> => ({
  bounds: spec.bounds ?? NATIONAL_WIND_BOUNDS,
  width: spec.width ?? 15,
  height: spec.height ?? 9,
  levels: spec.levels ?? WIND_LEVELS.map(({ id }) => id),
});

export const windForecastUrl = (inputSpec: WindFetchSpec = {}) => {
  const spec = normalizedSpec(inputSpec);
  const { coordinates } = gridFor(spec.bounds, spec.width, spec.height);
  const variables = unique(
    spec.levels.flatMap((levelId) => {
      const metadata = windLevel(levelId);
      return [
        metadata.speedVariable,
        metadata.directionVariable,
        ...(metadata.heightVariable ? [metadata.heightVariable] : []),
      ];
    }),
  );
  const parameters = new URLSearchParams({
    latitude: coordinates.map(({ lat }) => lat.toFixed(2)).join(","),
    longitude: coordinates.map(({ lon }) => lon.toFixed(2)).join(","),
    hourly: variables.join(","),
    wind_speed_unit: "ms",
    timezone: "UTC",
    past_hours: String(FETCH_PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    models: "gfs_seamless",
  });

  return `https://api.open-meteo.com/v1/gfs?${parameters}`;
};

export const fetchWindField = async (
  signal: AbortSignal,
  inputSpec: WindFetchSpec = {},
) => {
  const spec = normalizedSpec(inputSpec);
  const response = await fetch(windForecastUrl(spec), { signal });
  if (!response.ok) {
    throw new Error(`Live wind data is unavailable (${response.status}).`);
  }
  return parseWindField(await response.json(), spec);
};

export const nearestTimeIndex = (times: readonly Date[], target: Date) =>
  times.reduce(
    (bestIndex, time, index) =>
      Math.abs(time.getTime() - target.getTime()) <
      Math.abs(times[bestIndex].getTime() - target.getTime())
        ? index
        : bestIndex,
    0,
  );

const bilinearFinite = (
  values: readonly number[],
  width: number,
  x: number,
  y: number,
) => {
  const x0 = Math.floor(x);
  const x1 = Math.min(width - 1, x0 + 1);
  const y0 = Math.floor(y);
  const y1 = Math.min(values.length / width - 1, y0 + 1);
  const xWeight = x - x0;
  const yWeight = y - y0;
  const samples = [
    [values[y0 * width + x0], (1 - xWeight) * (1 - yWeight)],
    [values[y0 * width + x1], xWeight * (1 - yWeight)],
    [values[y1 * width + x0], (1 - xWeight) * yWeight],
    [values[y1 * width + x1], xWeight * yWeight],
  ] as const;
  const finiteSamples = samples.filter(([value]) => Number.isFinite(value));
  const totalWeight = finiteSamples.reduce((total, [, weight]) => total + weight, 0);
  if (totalWeight <= 0) return null;
  return (
    finiteSamples.reduce((total, [value, weight]) => total + value * weight, 0) /
    totalWeight
  );
};

const spatialPosition = (field: WindField, coordinate: Coordinate) => ({
  x:
    ((clamp(coordinate.lon, field.bounds.west, field.bounds.east) -
      field.bounds.west) /
      (field.bounds.east - field.bounds.west)) *
    (field.width - 1),
  y:
    ((field.bounds.north -
      clamp(coordinate.lat, field.bounds.south, field.bounds.north)) /
      (field.bounds.north - field.bounds.south)) *
    (field.height - 1),
});

const sampleFrame = (
  field: WindField,
  levelId: WindLevelId,
  frameIndex: number,
  coordinate: Coordinate,
): WindReading | null => {
  const level = field.levels[levelId];
  if (!level) return null;
  const frame = level.frames[clamp(frameIndex, 0, level.frames.length - 1)];
  const { x, y } = spatialPosition(field, coordinate);
  const u = bilinearFinite(frame.u, field.width, x, y);
  const v = bilinearFinite(frame.v, field.width, x, y);
  const heightMeters = bilinearFinite(frame.heights, field.width, x, y);
  const elevationMeters = bilinearFinite(field.elevations, field.width, x, y);
  if (
    u === null ||
    v === null ||
    heightMeters === null ||
    elevationMeters === null
  ) return null;

  return {
    u,
    v,
    speed: Math.hypot(u, v),
    direction: vectorToMeteorologicalDirection(u, v),
    heightMeters,
    belowTerrain: levelId === "surface" ? false : heightMeters < elevationMeters,
  };
};

export const sampleWind = (
  field: WindField,
  timePosition: number,
  coordinate: Coordinate,
  levelId: WindLevelId = "surface",
): WindReading | null => {
  const lowerIndex = Math.floor(timePosition);
  const upperIndex = Math.min(field.times.length - 1, Math.ceil(timePosition));
  const lower = sampleFrame(field, levelId, lowerIndex, coordinate);
  const upper = sampleFrame(field, levelId, upperIndex, coordinate);
  if (!lower || !upper) return lower ?? upper;
  const weight = timePosition - lowerIndex;
  const u = lower.u * (1 - weight) + upper.u * weight;
  const v = lower.v * (1 - weight) + upper.v * weight;

  return {
    u,
    v,
    speed: Math.hypot(u, v),
    direction: vectorToMeteorologicalDirection(u, v),
    heightMeters:
      lower.heightMeters * (1 - weight) + upper.heightMeters * weight,
    belowTerrain: lower.belowTerrain || upper.belowTerrain,
  };
};

export const buildBackwardTrace = (
  field: WindField,
  timePosition: number,
  start: Coordinate,
  levelId: WindLevelId = "surface",
  requestedHours = TRACE_HOURS,
) => {
  const availableHours = Math.min(requestedHours, Math.floor(timePosition));
  const secondsPerStep = 3_600;
  const metersPerDegreeLatitude = 111_320;
  const startReading = sampleWind(field, timePosition, start, levelId);
  if (!startReading) return [];

  return Array.from({ length: availableHours }).reduce<readonly TracePoint[]>(
    (points, _, stepIndex) => {
      const current = points.at(-1) ?? {
        ...start,
        heightMeters: startReading.heightMeters,
      };
      const wind = sampleWind(
        field,
        timePosition - stepIndex,
        current,
        levelId,
      );
      if (!wind) return points;
      const longitudeScale =
        metersPerDegreeLatitude *
        Math.max(0.2, Math.cos((current.lat * Math.PI) / 180));

      return [
        ...points,
        {
          lon: current.lon - (wind.u * secondsPerStep) / longitudeScale,
          lat: current.lat -
            (wind.v * secondsPerStep) / metersPerDegreeLatitude,
          heightMeters: wind.heightMeters,
        },
      ];
    },
    [{ ...start, heightMeters: startReading.heightMeters }],
  );
};

export const windTexture = (
  field: WindField,
  levelId: WindLevelId,
  frameIndex: number,
) => {
  const frame = field.levels[levelId]?.frames[frameIndex];
  if (!frame) return null;
  const data = new Float32Array(field.width * field.height * 2);
  frame.u.forEach((u, index) => {
    data[index * 2] = u;
    data[index * 2 + 1] = frame.v[index];
  });
  return { data, width: field.width, height: field.height };
};

export const textureBounds = (bounds: WindBounds): [number, number, number, number] => [
  bounds.west,
  bounds.south,
  bounds.east,
  bounds.north,
];

export const timeAtPosition = (
  times: readonly Date[],
  timePosition: number,
) => {
  const lowerIndex = Math.floor(timePosition);
  const upperIndex = Math.min(times.length - 1, Math.ceil(timePosition));
  const weight = timePosition - lowerIndex;
  return new Date(
    times[lowerIndex].getTime() * (1 - weight) +
      times[upperIndex].getTime() * weight,
  );
};

export const relativeHourLabel = (timePosition: number, nowIndex: number) => {
  const hours = Math.round(timePosition - nowIndex);
  if (hours === 0) return "Now";
  return hours > 0 ? `+${hours} h` : `${hours} h`;
};

export const containsCoordinate = (
  bounds: WindBounds,
  coordinate: Coordinate,
) =>
  coordinate.lon >= bounds.west &&
  coordinate.lon <= bounds.east &&
  coordinate.lat >= bounds.south &&
  coordinate.lat <= bounds.north;

export const clampBounds = (bounds: WindBounds): WindBounds | null => {
  const clamped = {
    west: Math.max(NATIONAL_WIND_BOUNDS.west, bounds.west),
    east: Math.min(NATIONAL_WIND_BOUNDS.east, bounds.east),
    north: Math.min(NATIONAL_WIND_BOUNDS.north, bounds.north),
    south: Math.max(NATIONAL_WIND_BOUNDS.south, bounds.south),
  };
  return clamped.west < clamped.east && clamped.south < clamped.north
    ? clamped
    : null;
};

export const quantizeBounds = (bounds: WindBounds, step = 0.5): WindBounds => ({
  west: Math.floor(bounds.west / step) * step,
  east: Math.ceil(bounds.east / step) * step,
  north: Math.ceil(bounds.north / step) * step,
  south: Math.floor(bounds.south / step) * step,
});

export const formatCoordinate = (coordinate: Coordinate) =>
  `${Math.abs(coordinate.lat).toFixed(2)}°${coordinate.lat >= 0 ? "N" : "S"}, ${Math.abs(coordinate.lon).toFixed(2)}°${coordinate.lon >= 0 ? "E" : "W"}`;

export const formatHeight = (levelId: WindLevelId, heightMeters: number) =>
  levelId === "surface"
    ? "10 m AGL"
    : `${(heightMeters / 1_000).toFixed(1)} km ASL`;
