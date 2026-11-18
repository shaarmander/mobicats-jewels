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
test("full eternity carries staggered lanes across the rear with a regular shared-grain interval", () => {
  const o = {
    ...options,
    rows: 3,
    width: 5.5,
    front: 5.5,
    pave: 0,
    coverage: "full",
  };
  const plan = layout(o);
  assert.equal(plan.requested, plan.seats.length);
  assert.equal(new Set(plan.seats.map((s) => s.id)).size, plan.seats.length);
  for (let row = 0; row < 3; row++) {
    const lane = plan.seats.filter((s) => s.row === row);
    assert.ok(lane.length > 25);
    assert.ok(
      plan.rowPitches[row] >= o.pitch && plan.rowPitches[row] < o.pitch * 1.04,
    );
    const seam = lane.findIndex((s, i) => i > 0 && s.side !== lane[i - 1].side);
    assert.ok(seam > 0 && Math.abs(lane[seam].a) > 2.9);
    assert.ok(
      Math.abs(
        lane[seam].p.distanceTo(lane[seam - 1].p) - plan.rowPitches[row],
      ) < 0.015,
    );
    assert.equal(grainMatrices(lane).length, 2 * lane.length + 2);
  }
});
test("three-quarter fills past the shoulders and older shared bands retain their position count", () => {
  const o = { ...options, pave: 3 };
  delete o.coverage;
  const restored = validBand(o);
  assert.equal(restored.coverage, "shoulders");
  assert.equal(layout(restored).seats.length, 6);
  const extended = layout({
    ...restored,
    coverage: "threeQuarter",
    pave: 0,
  }).seats;
  assert.ok(
    extended.length > 6 && extended.some((s) => Math.abs(s.a) > Math.PI / 2),
  );
  assert.ok(extended.every((s) => Math.abs(s.a) < (3 * Math.PI) / 4));
  const narrow = layout({
    ...restored,
    coverage: "full",
    front: 4,
    width: 1.6,
    sizing: "fixed",
  });
  assert.ok(
    narrow.seats.length < narrow.requested &&
      narrow.seats.every((s) => Math.abs(s.a) < Math.PI - 0.2),
  );
});
