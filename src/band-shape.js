import * as T from "three";
import { paveDefaults } from "./pave.js";

const tau = Math.PI * 2;
const smooth = T.MathUtils.smoothstep;
export const bandChoices = {
  coverage: ["shoulders", "threeQuarter", "full"],
  sizing: ["graduated", "fixed"],
  shape: ["round", "flat", "domed", "knife"],
  shoulders: ["straight", "taper", "flare", "split"],
  finish: ["polished", "brushed", "hammered"],
  edge: ["plain", "bevel", "beaded"],
};
export const bandRanges = {
  width: [1.6, 6],
  thickness: [1.4, 3.4],
  front: [1.6, 6.5],
  pave: [0, 14],
  pitch: [0.9, 3.5],
  weight: [0.002, 0.075],
  rows: [1, 3],
};

export function validBand(value) {
  if (!value || typeof value !== "object") return null;
  value = { ...paveDefaults, ...value };
  const options = {};
  for (const [key, choices] of Object.entries(bandChoices)) {
    if (!choices.includes(value[key])) return null;
    options[key] = value[key];
  }
  for (const [key, [min, max]] of Object.entries(bandRanges)) {
    const n = value[key];
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (["pave", "rows"].includes(key) && !Number.isInteger(n))
    )
      return null;
    options[key] = n;
  }
  return options;
}

export function bandDefaults(studio) {
  const fit = studio.fit,
    p = fit.mesh.geometry.attributes.position.array;
  let width = 0,
    inner = Infinity,
    outer = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1] >= 0 || Math.abs(p[i]) > 0.7) continue;
    const r = Math.hypot(p[i], p[i + 1]);
    inner = Math.min(inner, r);
    outer = Math.max(outer, r);
    width = Math.max(width, 2 * Math.abs(p[i + 2]));
  }
  const dim = (n, key) =>
    T.MathUtils.clamp(Math.round(n * 10) / 10, ...bandRanges[key]);
  const style = studio.state.setting;
  return {
    ...paveDefaults,
    ...(style === "cluster" ? { weight: 0.004, pitch: 1.16 } : {}),
    width: dim(width, "width"),
    thickness: dim(outer - inner, "thickness"),
    front: dim(
      style === "dome" ? 5.6 : style === "knife" ? 3.6 : Math.max(2.7, width),
      "front",
    ),
    shape:
      { knife: "knife", eastwest: "flat", dome: "domed" }[style] || "round",
    shoulders: style === "split" ? "split" : "straight",
    finish: "polished",
    edge: "plain",
    pave: Math.min(
      14,
      fit.stones.filter((m) => m.userData.role === "pave").length / 2,
    ),
  };
}

// Cross-sections are in millimetres. The shank sweeps around the XY plane;
// its width runs along Z. The inner bore stays fixed as the exterior grows.
export function bandSurface(style, o, bore) {
  const split = o.shoulders === "split";
  const strands = split
    ? 1
    : { cable: 2, interlace: 2, double: 2, marquise: 2, fluted: 5 }[style] || 1;
  function section(a, strand, side, t) {
    const angle = Math.abs(a),
      upper =
        1 -
        smooth(
          angle,
          o.shoulders === "flare" ? 0.62 : 0.38,
          o.shoulders === "taper" ? 1.85 : 2.55,
        );
    const width = Math.max(
      2.6 * (1 - smooth(angle, 0.15, 0.65)),
      T.MathUtils.lerp(
        o.width,
        split ? Math.max(3.4, o.front) : o.front,
        upper,
      ),
    );
    const depth = T.MathUtils.lerp(
      o.thickness,
      Math.max(1.85, o.thickness),
      upper,
    );
    let w = width,
      h = depth,
      zc = 0,
      dr = 0,
      roll = 0;
    const sign = strand ? 1 : -1;
    const blend = smooth(angle, 0.12, 0.55);
    if (strands === 2) {
      w *= 0.58;
      if (style === "cable") {
        zc = sign * width * 0.21 * Math.sin(12 * a);
        dr = sign * depth * 0.18 * Math.cos(12 * a);
        h *= 0.75;
      } else if (style === "interlace") {
        zc = sign * 0.27 * width * Math.cos(3 * a);
        dr = sign * 0.15 * depth * Math.sin(3 * a);
        h *= 0.8;
      } else if (style === "marquise")
        zc = sign * width * (0.09 + 0.3 * Math.sin(3 * a) ** 2);
      else zc = sign * width * 0.25;
    } else if (strands === 5) {
      w *= 0.32;
      zc = (strand - 2) * width * 0.17;
      h *= 1 - 0.07 * Math.abs(strand - 2);
    }
    if (style === "wishbone")
      zc += 1.9 * Math.exp(-(a * a) / 0.15) - 0.97 * Math.exp(-(a * a) / 0.98);
    if (style === "bypass") {
      zc += 1.35 * Math.sin(2 * a) * Math.exp((-a * a) / 0.94);
      dr += 0.65 * Math.exp((-a * a) / 0.35);
    }
    if (style === "ribbon") roll = 0.68 * Math.sin(3 * a) * blend;
    const fork = split
      ? (1 - smooth(angle, 0.75, 1.65)) * smooth(angle, 0.04, 0.4)
      : 0;
    const gap = smooth(fork, 0.4, 1) * Math.max(0, Math.min(0.5, 1 - 2.1 / w));
    const u = Math.sin(t),
      upperFace = t <= Math.PI / 2;
    const exp =
      o.shape === "flat" ? 6 : o.shape === "domed" && !upperFace ? 5 : 2;
    let arch = Math.pow(Math.max(0, 1 - Math.pow(u, exp)), 1 / exp);
    if (o.shape === "knife" && upperFace)
      arch = Math.pow(Math.max(0, 1 - (u * u) / (0.07 + 0.93 * u)), 0.8);
    if (o.edge === "bevel") arch = Math.min(arch, (1 - u) * 2.1 + 0.11);
    // Round the two facing edges of the fork; each arm closes at the opening.
    if (fork > 0) {
      const v = Math.min(1, u / 0.56);
      arch *= T.MathUtils.lerp(
        1,
        Math.sqrt(Math.max(0, 1 - (1 - v) ** 2)),
        smooth(fork, 0, 0.4),
      );
    }
    const dz = (side * (gap + (1 - gap) * u) * w) / 2;
    const dy = ((upperFace ? 1 : -1) * arch * h) / 2;
    const r = bore + depth / 2 + dr + dy * Math.cos(roll) - dz * Math.sin(roll);
    const z = zc + dz * Math.cos(roll) + dy * Math.sin(roll);
    return [r * Math.sin(a), r * Math.cos(a), z];
  }
  return { strands, section };
}

export function sweepBand(surface) {
  const pos = [],
    uv = [],
    index = [];
  const steps = 192,
    cross = 20;
  for (let strand = 0; strand < surface.strands; strand++) {
    for (const side of [-1, 1]) {
      const first = pos.length / 3;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps - 0.5) * tau;
        for (let j = 0; j <= cross; j++) {
          pos.push(...surface.section(a, strand, side, (j / cross) * Math.PI));
          uv.push((i / steps) * 12, (side * j) / cross);
          if (i === steps || j === cross) continue;
          const v = first + i * (cross + 1) + j,
            b = v + cross + 1;
          if (side === 1) index.push(v, v + 1, b, b, v + 1, b + 1);
          else index.push(v, b, v + 1, b, b + 1, v + 1);
        }
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  // Adjacent UV islands share their surface normals at the middle and seam.
  const normals = g.attributes.normal.array,
    groups = new Map();
  const row = cross + 1,
    half = (steps + 1) * row;
  for (let s = 0; s < surface.strands; s++)
    for (let h = 0; h < 2; h++)
      for (let i = 0; i <= steps; i++)
        for (let j = 0; j <= cross; j++) {
          if (i !== 0 && i !== steps && j !== 0 && j !== cross) continue;
          const v = (s * 2 + h) * half + i * row + j,
            k = pos
              .slice(v * 3, v * 3 + 3)
              .map((x) => Math.round(x * 100000))
              .join(",");
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(v);
        }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const n = new T.Vector3();
    for (const v of group) n.add(new T.Vector3().fromArray(normals, v * 3));
    if (n.lengthSq() < 0.00001) continue;
    n.normalize();
    for (const v of group) n.toArray(normals, v * 3);
  }
  return g;
}

export function finishTexture(finish) {
  const size = 128,
    data = new Uint8Array(size * size * 4);
  let seed = 53;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pits = Array.from({ length: 65 }, () => [
    random() * size,
    random() * size,
    6 + random() * 9,
  ]);
  const scratches = Array.from({ length: size }, () => random());
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let height = 0.5;
      if (finish === "brushed")
        height =
          0.24 +
          0.5 * scratches[y] +
          0.18 *
            scratches[
              (y + Math.round(1.5 * Math.sin((x / size) * tau)) + size) % size
            ] +
          0.08 * random();
      else
        for (const [cx, cy, r] of pits) {
          const dx = Math.min(Math.abs(cx - x), size - Math.abs(cx - x)),
            dy = Math.min(Math.abs(cy - y), size - Math.abs(cy - y));
          height = Math.min(
            height,
            0.52 - 0.48 * Math.max(0, 1 - (dx * dx + dy * dy) / (r * r)) ** 2,
          );
        }
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(255 * height);
      data[i + 3] = 255;
    }
  const texture = new T.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.magFilter = T.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
