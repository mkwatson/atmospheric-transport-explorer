import { expect, test } from "vitest";
import {
  TRACE_HOURS,
  buildBackwardTrace,
  meteorologicalWindToVector,
  relativeHourLabel,
  sampleWind,
  timePositionForTimeline,
  type WindField,
} from "../app/wind";

const bounds = { west: -128, east: -65, north: 52, south: 22 } as const;

test("meteorological wind from the west flows east", () => {
  const wind = meteorologicalWindToVector(10, 270);
  expect(wind.u).toBeCloseTo(10, 9);
  expect(wind.v).toBeCloseTo(0, 9);
});

test("a backward trace moves against the modeled wind", () => {
  const frame = {
    u: new Float32Array([10, 10, 10, 10]),
    v: new Float32Array([0, 0, 0, 0]),
    heights: new Float32Array([10, 10, 10, 10]),
  };
  const field: WindField = {
    times: [0, 1, 2, 3].map((hour) => new Date(hour * 3_600_000)),
    levels: { surface: { frames: [frame, frame, frame, frame] } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [0, 0, 0, 0],
    width: 2,
    height: 2,
    bounds,
  };
  const start = { lon: -100, lat: 40 };
  const trace = buildBackwardTrace(field, 3, start, "surface", 3);

  expect(trace).toHaveLength(4);
  expect(trace.at(-1)?.lon).toBeLessThan(start.lon);
  expect(trace.at(-1)?.lat).toBeCloseTo(start.lat, 9);
});

test("the earliest displayed arrival has a complete hidden-history trace", () => {
  const frame = {
    u: new Float32Array([1, 1, 1, 1]),
    v: new Float32Array([0, 0, 0, 0]),
    heights: new Float32Array([10, 10, 10, 10]),
  };
  const frames = Array.from({ length: TRACE_HOURS + 1 }, () => frame);
  const field: WindField = {
    times: frames.map((_, hour) => new Date(hour * 3_600_000)),
    levels: { surface: { frames } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [0, 0, 0, 0],
    width: 2,
    height: 2,
    bounds,
  };

  const trace = buildBackwardTrace(
    field,
    TRACE_HOURS,
    { lon: -100, lat: 40 },
  );

  expect(trace.length - 1).toBe(TRACE_HOURS);
  expect(relativeHourLabel(TRACE_HOURS, TRACE_HOURS + 24)).toBe("-24 h");
});

test("fractional-time terrain flags follow the displayed height", () => {
  const frameAt = (heightMeters: number) => ({
    u: new Float32Array([10, 10, 10, 10]),
    v: new Float32Array([0, 0, 0, 0]),
    heights: new Float32Array([
      heightMeters,
      heightMeters,
      heightMeters,
      heightMeters,
    ]),
  });
  const field: WindField = {
    times: [new Date(0), new Date(3_600_000)],
    levels: { "850hPa": { frames: [frameAt(900), frameAt(1_100)] } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [1_000, 1_000, 1_000, 1_000],
    width: 2,
    height: 2,
    bounds,
  };
  const coordinate = { lon: -100, lat: 40 };

  expect(sampleWind(field, 0.25, coordinate, "850hPa")?.belowTerrain).toBe(
    true,
  );
  expect(sampleWind(field, 0.75, coordinate, "850hPa")?.belowTerrain).toBe(
    false,
  );
});

test("point sampling returns null when finite bilinear weight is below half", () => {
  const sparseFrame = {
    u: new Float32Array([10, Number.NaN, Number.NaN, Number.NaN]),
    v: new Float32Array([0, Number.NaN, Number.NaN, Number.NaN]),
    heights: new Float32Array([10, Number.NaN, Number.NaN, Number.NaN]),
  };
  const field: WindField = {
    times: [new Date(0)],
    levels: { surface: { frames: [sparseFrame] } },
    longitudes: [-128, -65],
    latitudes: [52, 22],
    elevations: [0, 0, 0, 0],
    width: 2,
    height: 2,
    bounds,
  };

  expect(sampleWind(field, 0, { lon: -96.5, lat: 37 }, "surface")).toBeNull();
});

test("time positions align by valid timestamp across shifted timelines", () => {
  const sourceTimes = [0, 1, 2].map(
    (hour) => new Date(hour * 3_600_000),
  );
  const targetTimes = [0.5, 1.5, 2.5].map(
    (hour) => new Date(hour * 3_600_000),
  );

  expect(timePositionForTimeline(sourceTimes, 1.5, targetTimes)).toBe(1);
  expect(timePositionForTimeline(sourceTimes, 0, targetTimes)).toBe(0);
  expect(timePositionForTimeline(sourceTimes, 3, targetTimes)).toBe(1.5);
});
