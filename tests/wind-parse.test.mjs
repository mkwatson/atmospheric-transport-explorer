import assert from "node:assert/strict";
import test from "node:test";
import { parseWindField, sampleWind, windForecastUrl } from "../app/wind.ts";

const bounds = { west: -100, east: -98, north: 40, south: 38 };
const spec = { bounds, width: 2, height: 2, levels: ["surface"] };
const times = ["2024-01-01T00:00", "2024-01-01T01:00"];

// Four grid points (2×2) blowing from the west at 10 m/s.
const surfaceGrid = () =>
  Array.from({ length: 4 }, () => ({
    latitude: 39,
    longitude: -99,
    elevation: 200,
    hourly: {
      time: times,
      wind_speed_10m: [10, 10],
      wind_direction_10m: [270, 270],
    },
  }));

test("windForecastUrl requests the full grid from the GFS endpoint", () => {
  const url = new URL(windForecastUrl());
  const latitudes = url.searchParams.get("latitude")?.split(",") ?? [];

  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/gfs");
  assert.equal(latitudes.length, 15 * 9);
  assert.equal(url.searchParams.get("models"), "gfs_seamless");
  assert.equal(url.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(url.searchParams.get("timezone"), "UTC");
  assert.ok(url.searchParams.get("hourly")?.includes("wind_speed_250hPa"));
});

test("parseWindField turns a valid response into a sampleable field", () => {
  const field = parseWindField(surfaceGrid(), spec);
  assert.equal(field.times.length, 2);
  assert.equal(field.levels.surface?.frames.length, 2);

  const reading = sampleWind(field, 0, { lon: -99, lat: 39 }, "surface");
  assert.ok(reading);
  assert.ok(Math.abs(reading.speed - 10) < 1e-6);
});

test("parseWindField rejects a grid whose location count is wrong", () => {
  assert.throws(
    () => parseWindField(surfaceGrid().slice(0, 3), spec),
    /Expected 4 wind locations but received 3/,
  );
});

test("parseWindField hides pressure-level wind that sits below terrain", () => {
  const aloftSpec = { bounds, width: 2, height: 2, levels: ["850hPa"] };
  const belowTerrain = Array.from({ length: 4 }, () => ({
    latitude: 39,
    longitude: -99,
    elevation: 1_000,
    hourly: {
      time: times,
      wind_speed_850hPa: [12, 12],
      wind_direction_850hPa: [270, 270],
      // Geopotential height beneath the surface elevation -> not shown.
      geopotential_height_850hPa: [400, 400],
    },
  }));

  const field = parseWindField(belowTerrain, aloftSpec);
  assert.equal(sampleWind(field, 0, { lon: -99, lat: 39 }, "850hPa"), null);
});
