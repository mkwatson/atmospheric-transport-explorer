import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACE_HOURS,
  buildBackwardTrace,
  meteorologicalWindToVector,
  relativeHourLabel,
} from "../app/wind.ts";

test("meteorological wind from the west flows east", () => {
  const wind = meteorologicalWindToVector(10, 270);
  assert.ok(Math.abs(wind.u - 10) < 1e-9);
  assert.ok(Math.abs(wind.v) < 1e-9);
});

test("a backward trace moves against the modeled wind", () => {
  const frame = {
    u: [10, 10, 10, 10],
    v: [0, 0, 0, 0],
    heights: [10, 10, 10, 10],
  };
  const field = {
    times: [0, 1, 2, 3].map((hour) => new Date(hour * 3_600_000)),
    levels: { surface: { frames: [frame, frame, frame, frame] } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [0, 0, 0, 0],
    width: 2,
    height: 2,
    bounds: { west: -128, east: -65, north: 52, south: 22 },
  };
  const start = { lon: -100, lat: 40 };
  const trace = buildBackwardTrace(field, 3, start, "surface", 3);

  assert.equal(trace.length, 4);
  assert.ok(trace.at(-1).lon < start.lon);
  assert.ok(Math.abs(trace.at(-1).lat - start.lat) < 1e-9);
});

test("the earliest displayed arrival has a complete hidden-history trace", () => {
  const frame = {
    u: [1, 1, 1, 1],
    v: [0, 0, 0, 0],
    heights: [10, 10, 10, 10],
  };
  const frames = Array.from({ length: TRACE_HOURS + 1 }, () => frame);
  const field = {
    times: frames.map((_, hour) => new Date(hour * 3_600_000)),
    levels: { surface: { frames } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [0, 0, 0, 0],
    width: 2,
    height: 2,
    bounds: { west: -128, east: -65, north: 52, south: 22 },
  };

  const trace = buildBackwardTrace(
    field,
    TRACE_HOURS,
    { lon: -100, lat: 40 },
  );

  assert.equal(trace.length - 1, TRACE_HOURS);
  assert.equal(relativeHourLabel(TRACE_HOURS, TRACE_HOURS + 24), "-24 h");
});
