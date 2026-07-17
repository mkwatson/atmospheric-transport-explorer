import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackwardTrace,
  meteorologicalWindToVector,
} from "../app/wind.ts";

test("meteorological wind from the west flows east", () => {
  const wind = meteorologicalWindToVector(10, 270);
  assert.ok(Math.abs(wind.u - 10) < 1e-9);
  assert.ok(Math.abs(wind.v) < 1e-9);
});

test("a backward trace moves against the modeled wind", () => {
  const frame = { u: [10, 10, 10, 10], v: [0, 0, 0, 0] };
  const field = {
    times: [0, 1, 2, 3].map((hour) => new Date(hour * 3_600_000)),
    frames: [frame, frame, frame, frame],
    longitudes: [-128, -65],
    latitudes: [52, 22],
    width: 2,
    height: 2,
  };
  const start = { lon: -100, lat: 40 };
  const trace = buildBackwardTrace(field, 3, start, 3);

  assert.equal(trace.length, 4);
  assert.ok(trace.at(-1).lon < start.lon);
  assert.ok(Math.abs(trace.at(-1).lat - start.lat) < 1e-9);
});
