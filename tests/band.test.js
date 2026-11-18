import test from "node:test";
import assert from "node:assert/strict";
import {
  bandSurface,
  sweepBand,
  validBand,
  bandChoices,
} from "../src/band-shape.js";
import { meshVolume } from "../src/center-fit.js";
import { readDesign } from "../src/share.js";

const options = {
  width: 3,
  front: 3,
  thickness: 2,
  shape: "round",
  shoulders: "straight",
  finish: "polished",
  edge: "plain",
  pave: 0,
};
const bore = 8.25;

test("the round shank keeps the bore and has the requested width, depth and metal volume", () => {
  const surface = bandSurface("solitaire", options, bore);
  const at = (t) => surface.section(Math.PI, 0, 1, t);
  assert.ok(Math.abs(Math.hypot(...at(Math.PI).slice(0, 2)) - bore) < 1e-6);
  assert.equal(at(Math.PI / 2)[2] * 2, options.width);
  assert.equal(Math.abs(at(0)[1]), bore + options.thickness);
  const expected =
    (2 *
      Math.PI *
      (bore + options.thickness / 2) *
      Math.PI *
      options.thickness *
      options.width) /
    4;
  const volume = meshVolume(sweepBand(surface));
  assert.ok(Math.abs(volume / expected - 1) < 0.01);
});

test("split shoulders mirror around the center and merge at the palm", () => {
  const s = bandSurface(
    "solitaire",
    { ...options, shoulders: "split", front: 5 },
    bore,
  );
  for (const a of [-0.7, 0.7]) {
    const left = s.section(a, 0, -1, 0),
      right = s.section(a, 0, 1, 0);
    assert.ok(right[2] - left[2] > 1);
    assert.equal(left[2], -right[2]);
  }
  assert.ok(
    Math.abs(s.section(Math.PI, 0, -1, 0)[2] - s.section(Math.PI, 0, 1, 0)[2]) <
      1e-8,
  );
});

test("all four sections differ and custom band links reject malformed dimensions", () => {
  const profiles = bandChoices.shape.map((shape) => {
    const s = bandSurface("solitaire", { ...options, shape }, bore);
    return [0.8, 2.2]
      .map((t) => s.section(Math.PI, 0, 1, t)[1].toFixed(4))
      .join(",");
  });
  assert.equal(new Set(profiles).size, 4);
  assert.equal(validBand({ ...options, pave: 1.5 }), null);
  assert.equal(validBand({ ...options, width: -1 }), null);
  const lib = { settings: [], cuts: [], metals: [], gems: [] };
  const data = readDesign(
    "#v=1&band=" + encodeURIComponent(JSON.stringify(options)),
    lib,
    [],
  );
  assert.deepEqual(data.band, options);
  assert.equal(readDesign("#v=1", lib, []).band, undefined);
});
