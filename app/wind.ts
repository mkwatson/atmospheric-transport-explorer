import { z } from "zod";

export const WIND_BOUNDS = {
  west: -128,
  east: -65,
  north: 52,
  south: 22,
} as const;

const GRID_WIDTH = 15;
const GRID_HEIGHT = 9;
const METERS_PER_SECOND_TO_MILES_PER_HOUR = 2.236_936;
const VELOCITY_RANGE = [-100, 100] as const;

export const WIND_TEXTURE_BOUNDS: [number, number, number, number] = [
  WIND_BOUNDS.west,
  WIND_BOUNDS.north,
  WIND_BOUNDS.east,
  WIND_BOUNDS.south,
];

export const WIND_COLOR_STOPS: Array<[number, number[]]> = [
  [0, [115, 153, 232]],
  [6.7, [89, 207, 244]],
  [13.4, [102, 231, 200]],
  [20.1, [202, 235, 139]],
  [29.1, [255, 211, 112]],
  [40.3, [255, 154, 99]],
  [55.9, [247, 96, 122]],
  [78.3, [205, 132, 255]],
];

export const WIND_VELOCITY_RANGE: [number, number] = [...VELOCITY_RANGE];

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

export type WindFrame = Readonly<{
  u: readonly number[];
  v: readonly number[];
}>;

export type WindField = Readonly<{
  times: readonly Date[];
  frames: readonly WindFrame[];
  longitudes: readonly number[];
  latitudes: readonly number[];
  width: number;
  height: number;
}>;

const longitudes = Array.from(
  { length: GRID_WIDTH },
  (_, index) =>
    WIND_BOUNDS.west +
    (index * (WIND_BOUNDS.east - WIND_BOUNDS.west)) / (GRID_WIDTH - 1),
);

const latitudes = Array.from(
  { length: GRID_HEIGHT },
  (_, index) =>
    WIND_BOUNDS.north -
    (index * (WIND_BOUNDS.north - WIND_BOUNDS.south)) / (GRID_HEIGHT - 1),
);

const gridCoordinates = latitudes.flatMap((lat) =>
  longitudes.map((lon) => ({ lat, lon })),
);

const hourlySchema = z.object({
  time: z.array(z.string()),
  wind_speed_10m: z.array(z.number()),
  wind_direction_10m: z.array(z.number()),
});

const forecastLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  hourly: hourlySchema,
});

const forecastResponseSchema = z.array(forecastLocationSchema);

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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

export const parseWindField = (input: unknown): WindField => {
  const locations = forecastResponseSchema.parse(input);

  if (locations.length !== gridCoordinates.length) {
    throw new Error(
      `Expected ${gridCoordinates.length} wind locations but received ${locations.length}.`,
    );
  }

  const expectedTimes = locations[0]?.hourly.time ?? [];
  if (expectedTimes.length === 0) {
    throw new Error("The weather service returned no forecast times.");
  }

  const hasConsistentShape = locations.every(
    ({ hourly }) =>
      hourly.time.length === expectedTimes.length &&
      hourly.wind_speed_10m.length === expectedTimes.length &&
      hourly.wind_direction_10m.length === expectedTimes.length &&
      hourly.time.every((time, index) => time === expectedTimes[index]),
  );

  if (!hasConsistentShape) {
    throw new Error("The weather service returned an inconsistent wind grid.");
  }

  const frames = expectedTimes.map((_, timeIndex) => {
    const vectors = locations.map(({ hourly }) =>
      meteorologicalWindToVector(
        hourly.wind_speed_10m[timeIndex],
        hourly.wind_direction_10m[timeIndex],
      ),
    );

    return {
      u: vectors.map(({ u }) => u),
      v: vectors.map(({ v }) => v),
    };
  });

  return {
    times: expectedTimes.map(isoUtcDate),
    frames,
    longitudes,
    latitudes,
    width: GRID_WIDTH,
    height: GRID_HEIGHT,
  };
};

const windForecastUrl = () => {
  const parameters = new URLSearchParams({
    latitude: gridCoordinates.map(({ lat }) => lat.toFixed(2)).join(","),
    longitude: gridCoordinates.map(({ lon }) => lon.toFixed(2)).join(","),
    hourly: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "UTC",
    past_hours: "24",
    forecast_hours: "49",
    models: "gfs_seamless",
  });

  return `https://api.open-meteo.com/v1/gfs?${parameters}`;
};

export const fetchWindField = async (signal: AbortSignal) => {
  const response = await fetch(windForecastUrl(), { signal });
  if (!response.ok) {
    throw new Error(`Live wind data is unavailable (${response.status}).`);
  }
  return parseWindField(await response.json());
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

const bilinear = (
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
  const top = values[y0 * width + x0] * (1 - xWeight) + values[y0 * width + x1] * xWeight;
  const bottom = values[y1 * width + x0] * (1 - xWeight) + values[y1 * width + x1] * xWeight;
  return top * (1 - yWeight) + bottom * yWeight;
};

export const sampleWind = (
  field: WindField,
  frameIndex: number,
  coordinate: Coordinate,
): WindVector => {
  const x =
    (clamp(coordinate.lon, WIND_BOUNDS.west, WIND_BOUNDS.east) - WIND_BOUNDS.west) /
    (WIND_BOUNDS.east - WIND_BOUNDS.west) *
    (field.width - 1);
  const y =
    (WIND_BOUNDS.north - clamp(coordinate.lat, WIND_BOUNDS.south, WIND_BOUNDS.north)) /
    (WIND_BOUNDS.north - WIND_BOUNDS.south) *
    (field.height - 1);
  const frame = field.frames[clamp(frameIndex, 0, field.frames.length - 1)];
  const u = bilinear(frame.u, field.width, x, y);
  const v = bilinear(frame.v, field.width, x, y);

  return {
    u,
    v,
    speed: Math.hypot(u, v),
    direction: vectorToMeteorologicalDirection(u, v),
  };
};

export const buildBackwardTrace = (
  field: WindField,
  frameIndex: number,
  start: Coordinate,
  requestedHours = 18,
) => {
  const availableHours = Math.min(requestedHours, frameIndex);
  const secondsPerStep = 3_600;
  const metersPerDegreeLatitude = 111_320;

  return Array.from({ length: availableHours }).reduce<readonly Coordinate[]>(
    (points, _, stepIndex) => {
      const current = points.at(-1) ?? start;
      const wind = sampleWind(field, frameIndex - stepIndex, current);
      const longitudeScale =
        metersPerDegreeLatitude * Math.max(0.2, Math.cos((current.lat * Math.PI) / 180));

      return [
        ...points,
        {
          lon: current.lon - (wind.u * secondsPerStep) / longitudeScale,
          lat: current.lat - (wind.v * secondsPerStep) / metersPerDegreeLatitude,
        },
      ];
    },
    [start],
  );
};

const encodeVelocity = (value: number) => {
  const normalized =
    (clamp(value, VELOCITY_RANGE[0], VELOCITY_RANGE[1]) - VELOCITY_RANGE[0]) /
    (VELOCITY_RANGE[1] - VELOCITY_RANGE[0]);
  return Math.round(normalized * 255);
};

export const encodeWindFramePng = (field: WindField, frameIndex: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = field.width;
  canvas.height = field.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the wind field.");

  const image = context.createImageData(field.width, field.height);
  const frame = field.frames[frameIndex];

  // Canvas pixel buffers are an imperative browser boundary; mutation stays contained here.
  frame.u.forEach((u, index) => {
    const offset = index * 4;
    image.data[offset] = encodeVelocity(
      u * METERS_PER_SECOND_TO_MILES_PER_HOUR,
    );
    image.data[offset + 1] = encodeVelocity(
      frame.v[index] * METERS_PER_SECOND_TO_MILES_PER_HOUR,
    );
    image.data[offset + 2] = 255;
    image.data[offset + 3] = 255;
  });

  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
};

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

export const compassDirection = (degrees: number) =>
  COMPASS_POINTS[Math.round(degrees / 22.5) % COMPASS_POINTS.length];

export const formatCoordinate = (coordinate: Coordinate) =>
  `${Math.abs(coordinate.lat).toFixed(2)}°${coordinate.lat >= 0 ? "N" : "S"}, ${Math.abs(coordinate.lon).toFixed(2)}°${coordinate.lon >= 0 ? "E" : "W"}`;
