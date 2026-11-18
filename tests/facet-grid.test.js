import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFacetGrid } from "../src/facet-grid.js";

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const slants = ([x, y, z]) => [x + y, x - y, z + y, z - y];
function farBound(p, d, lo, hi) {
  return Math.min(
    ...p.map((v, i) =>
      d[i] === 0 ? Infinity : ((d[i] > 0 ? hi[i] : lo[i]) - v) / d[i],
    ),
  );
}
function meshForCut(cut) {
  const bytes = readFileSync(
    new URL(
      "../public/assets/rings/solitaire-" + cut + ".glb",
      import.meta.url,
    ),
  );
  const length = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.toString("utf8", 20, 20 + length));
  const gem = doc.nodes.find((n) => n.extras?.role === "center");
  const position =
    doc.accessors[doc.meshes[gem.mesh].primitives[0].attributes.POSITION];
  const offset =
    28 +
    length +
    (doc.bufferViews[position.bufferView].byteOffset ?? 0) +
    (position.byteOffset ?? 0);
  return {
    positions: new Float32Array(
      bytes.buffer,
      bytes.byteOffset + offset,
      position.count * 3,
    ),
    planes: gem.extras.planes,
  };
}
test("the candidate mask retains the first facet through repeated internal reflections", () => {
  let seed = 27;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (const cut of [
    "round",
    "emerald",
    "princess",
    "cushion",
    "portuguese",
    "oval",
    "pear",
    "marquise",
    "checkerboard",
    "old-european",
    "asscher",
  ]) {
    const { positions, planes } = meshForCut(cut),
      grid = buildFacetGrid(positions, planes);
    const { lo, hi, diagonalLo, diagonalHi, resolution, masks } = grid;
    for (let i = 0; i < 100; i++) {
      let p = [0, 0, 0],
        d =
          i < 3
            ? [0, 1, 2].map((j) => Number(j === i))
            : [random() - 0.5, random() - 0.5, random() - 0.5];
      d = d.map((v) => v / Math.hypot(...d));
      for (let bounce = 0; bounce < 8; bounce++) {
        let first = -1,
          length = Infinity;
        planes.forEach((n, j) => {
          const denom = dot(d, n),
            t = (n[3] - dot(p, n)) / denom;
          if (denom > 1e-6 && t > 0.000008 && t < length) {
            length = t;
            first = j;
          }
        });
        assert.ok(first >= 0);
        const end = Math.min(
          farBound(p, d, lo, hi),
          farBound(slants(p), slants(d), diagonalLo, diagonalHi),
        );
        const [x, y, z] = p.map((v, j) =>
          Math.min(
            resolution - 1,
            Math.max(
              0,
              Math.floor(
                ((v + end * d[j] - lo[j]) * resolution) / (hi[j] - lo[j]),
              ),
            ),
          ),
        );
        const bits =
          masks[4 * ((z * resolution + y) * resolution + x) + (first >> 5)];
        assert.ok(bits & (1 << (first % 32)), cut + " omitted facet " + first);
        p = p.map((v, j) => v + length * d[j]);
        const normal = planes[first],
          projection = dot(d, normal);
        d = d.map((v, j) => v - 2 * projection * normal[j]);
      }
    }
  }
});
