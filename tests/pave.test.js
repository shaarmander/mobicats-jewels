import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";
import { bandSurface, sweepBand, validBand } from "../src/band-shape.js";
import {
  diameterFor,
  weightFor,
  paveDefaults,
  paveLayout,
  grainMatrices,
} from "../src/pave.js";
import { cutSeats } from "../src/pave-seats.js";
import { meshVolume } from "../src/center-fit.js";

const options = {
  ...paveDefaults,
  width: 4,
  front: 4,
  thickness: 2,
  shape: "flat",
  shoulders: "straight",
  finish: "polished",
  edge: "plain",
  pave: 5,
};
const surface = (o) => bandSurface("solitaire", o, 8.25);
const layout = (o) => paveLayout(surface(o), o, 0.52);

test("pitch follows millimetres along each lane, rows stagger and seats have clearance", () => {
  const o = { ...options, width: 5, front: 5, rows: 3 },
    plan = layout(o);
  assert.equal(plan.seats.length, 30);
  for (const s of plan.seats) {
    const prev = plan.seats.find(
      (t) => t.row === s.row && t.side === s.side && t.i === s.i - 1,
    );
    if (prev) assert.ok(Math.abs(prev.p.distanceTo(s.p) - o.pitch) < 0.025);
    assert.ok(Math.abs(weightFor(s.d) - o.weight) < 1e-7);
    for (const t of plan.seats.filter((t) => t.id < s.id))
      assert.ok(t.p.distanceTo(s.p) > (s.d + t.d) / 2 + 0.06);
  }
  assert.ok(
    plan.seats.find((s) => s.row === 1 && s.side === 1).a >
      plan.seats.find((s) => s.row === 0 && s.side === 1).a,
  );
  assert.equal(grainMatrices(layout(options).seats).length, 2 * (2 * 5 + 2));
});
test("graduation reduces carat on a taper; fixed stones stop when they no longer fit", () => {
  const o = {
    ...options,
    front: 3.3,
    width: 1.6,
    weight: 0.015,
    pave: 12,
    shoulders: "taper",
  };
  const graduated = layout(o).seats,
    fixed = layout({ ...o, sizing: "fixed" }).seats;
  assert.ok(fixed.length > 0 && fixed.length < graduated.length);
  assert.ok(
    Math.min(...graduated.map((s) => s.d)) < diameterFor(o.weight) - 0.05,
  );
  assert.ok(fixed.every((s) => Math.abs(s.d - diameterFor(o.weight)) < 0.001));
  assert.equal(
    layout({ ...options, front: 1.6, width: 1.6, rows: 3 }).seats.length,
    0,
  );
  assert.equal(validBand({ ...options, rows: 1.5 }), null);
});
test("cut seats remove metal and leave a blind floor below each pavilion", () => {
  const o = { ...options, pave: 2 },
    blank = sweepBand(surface(o)),
    seats = layout(o).seats;
  const geo = cutSeats(blank, seats);
  assert.ok(meshVolume(geo) < meshVolume(blank));
  const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ side: T.DoubleSide }));
  for (const s of seats) {
    const ray = new T.Raycaster(
      s.p.clone().addScaledVector(s.normal, 2).addScaledVector(s.along, 0.03),
      s.normal.clone().negate(),
    );
    const hit = ray.intersectObject(mesh)[0];
    assert.ok(
      hit && hit.distance > 2 + 0.45 * s.d && hit.distance < 2 + 0.56 * s.d,
    );
  }
});
