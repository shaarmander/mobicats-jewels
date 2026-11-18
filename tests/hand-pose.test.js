import test from "node:test";
import assert from "node:assert/strict";
import { Group, Vector3 } from "three";
import { RingFingerPose } from "../src/hand-pose.js";

function observation(hand, palm, reportedHand = hand) {
  const direction = (hand === "Right" ? 1 : -1) * (palm ? -1 : 1);
  const wrist = { x: 0, y: 0.07, z: 0 };
  const world = Array.from({ length: 21 }, () => wrist);
  for (const [i, x, y] of [
    [5, -0.04, 0],
    [9, -0.013, 0],
    [13, 0.012, 0],
    [17, 0.035, 0.009],
    [14, 0.014, -0.035],
  ]) {
    world[i] = { x: direction * x, y, z: 0 };
  }
  return {
    worldLandmarks: [world],
    landmarks: [
      world.map(({ x, y, z }) => ({ x: 0.5 + x * 3, y: 0.5 + y * 3, z })),
    ],
    handedness: [[{ categoryName: reportedHand, score: 0.98 }]],
  };
}

for (const hand of ["Right", "Left"]) {
  test(hand + " hand can be reacquired palm-first and turn back", () => {
    const finger = new RingFingerPose(),
      mount = new Group();
    const ctx = {
      canvas: { width: 640, height: 640 },
      getImageData: (_x, _y, w, h) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    };
    const sample = (t, result) => {
      finger.update(result, t, 640, 640, ctx);
      finger.place(mount, t + 10, 16.5, 1);
      return new Vector3(0, 1, 0).applyQuaternion(mount.quaternion).z;
    };
    assert.ok(sample(1000, observation(hand, false)) > 0.9);
    assert.ok(sample(1600, observation(hand, true)) < -0.9);
    for (let t = 1650; t <= 2050; t += 50) sample(t, observation(hand, false));
    const other = hand === "Left" ? "Right" : "Left";
    assert.ok(sample(2100, observation(hand, false, other)) > 0.9);
    for (let t = 2400; t <= 2900; t += 50) sample(t, observation(other, false));
    assert.ok(sample(2950, observation(other, false)) > 0.9);
  });
}
