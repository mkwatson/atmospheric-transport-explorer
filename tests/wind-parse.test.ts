import { expect, test } from "vitest";
import { parseWindField, sampleWind, windForecastUrl } from "../app/wind";

const bounds = { west: -100, east: -98, north: 40, south: 38 } as const;
const spec = { bounds, width: 2, height: 2, levels: ["surface"] } as const;
const times = ["2024-01-01T00:00", "2024-01-01T01:00"] as const;
const gridCoordinates = [
  { latitude: 40, longitude: -100 },
  { latitude: 40, longitude: -98 },
  { latitude: 38, longitude: -100 },
  { latitude: 38, longitude: -98 },
] as const;

// Four grid points (2×2) blowing from the west at 10 m/s.
const surfaceGrid = (responseTimes: readonly string[] = times) =>
  gridCoordinates.map(({ latitude, longitude }) => ({
    latitude,
    longitude,
    elevation: 200,
    utc_offset_seconds: 0,
    hourly_units: {
      time: "iso8601",
      wind_speed_10m: "m/s",
      wind_direction_10m: "°",
    },
    hourly: {
      time: responseTimes,
      wind_speed_10m: [10, 10],
      wind_direction_10m: [270, 270],
    },
  }));

test("windForecastUrl requests the full grid from the GFS endpoint", () => {
  const url = new URL(windForecastUrl());
  const latitudes = url.searchParams.get("latitude")?.split(",") ?? [];

  expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/gfs");
  expect(latitudes).toHaveLength(15 * 9);
  expect(url.searchParams.get("models")).toBe("gfs_seamless");
  expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
  expect(url.searchParams.get("timezone")).toBe("UTC");
  expect(url.searchParams.get("hourly")).toContain("wind_speed_250hPa");
});

test("parseWindField turns a valid response into a sampleable field", () => {
  const field = parseWindField(surfaceGrid(), spec);
  expect(field.times).toHaveLength(2);
  expect(field.levels.surface?.frames).toHaveLength(2);

  const reading = sampleWind(field, 0, { lon: -99, lat: 39 }, "surface");
  expect(reading).not.toBeNull();
  expect(reading?.speed).toBeCloseTo(10, 6);
  expect(reading?.belowTerrain).toBe(false);
});

test("parseWindField rejects a grid whose location count is wrong", () => {
  expect(() => parseWindField(surfaceGrid().slice(0, 3), spec)).toThrow(
    /Expected 4 wind locations but received 3/,
  );
});

test("parseWindField rejects a response whose locations were reordered", () => {
  const [northwest, northeast, southwest, southeast] = surfaceGrid();

  expect(() =>
    parseWindField(
      [northeast, northwest, southwest, southeast],
      spec,
    ),
  ).toThrow(/Wind location 1 does not match the requested grid point/);
});

test("parseWindField rejects a requested variable with the wrong unit", () => {
  const wrongUnitGrid = surfaceGrid().map((location, index) =>
    index === 0
      ? {
          ...location,
          hourly_units: {
            ...location.hourly_units,
            wind_speed_10m: "km/h",
          },
        }
      : location,
  );

  expect(() => parseWindField(wrongUnitGrid, spec)).toThrow(
    /reported wind_speed_10m in km\/h; expected m\/s/,
  );
});

test("parseWindField rejects forecast times with the wrong cadence", () => {
  const wrongCadence = ["2024-01-01T00:00", "2024-01-01T01:30"];

  expect(() => parseWindField(surfaceGrid(wrongCadence), spec)).toThrow(
    /must increase in exact 3600-second steps/,
  );
});

test("parseWindField keeps pressure-level wind that sits below terrain", () => {
  const aloftSpec = {
    bounds,
    width: 2,
    height: 2,
    levels: ["850hPa"],
  } as const;
  const belowTerrain = gridCoordinates.map(({ latitude, longitude }) => ({
    latitude,
    longitude,
    elevation: 1_000,
    utc_offset_seconds: 0,
    hourly_units: {
      time: "iso8601",
      wind_speed_850hPa: "m/s",
      wind_direction_850hPa: "°",
      geopotential_height_850hPa: "m",
    },
    hourly: {
      time: times,
      wind_speed_850hPa: [12, 12],
      wind_direction_850hPa: [270, 270],
      // Geopotential height beneath the surface elevation -> shown and flagged.
      geopotential_height_850hPa: [400, 400],
    },
  }));

  const field = parseWindField(belowTerrain, aloftSpec);
  const reading = sampleWind(field, 0, { lon: -99, lat: 39 }, "850hPa");
  expect(reading).not.toBeNull();
  expect(reading?.speed).toBeCloseTo(12, 6);
  expect(reading?.belowTerrain).toBe(true);
});
