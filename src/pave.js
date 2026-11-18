import * as T from "three";

// Calibrated from the round melee mesh (diameter in millimetres at its native scale).
export const meleeDiameter = 1.2999999523162842;
export const meleeCarats = 0.00796800758689642;
export const paveDefaults = {
  rows: 1,
  pitch: 1.45,
  weight: 0.008,
  sizing: "graduated",
};
export const diameterFor = (ct) => meleeDiameter * Math.cbrt(ct / meleeCarats);
export const weightFor = (d) => meleeCarats * (d / meleeDiameter) ** 3;
const border = 0.5,
  clearance = 0.1,
  minimum = 0.78;
const staggerSpacing = Math.sqrt(3) / 2;
const radial = (p) => Math.hypot(p.x, p.y);

// Sample the upper skin of each strand. Keep openings in split shoulders open.
function crossSection(surface, a, inner = false) {
  const lines = [],
    spans = [];
  for (let k = 0; k < surface.strands; k++) {
    for (const side of [-1, 1]) {
      const line = [];
      for (let j = 0; j <= 12; j++)
        line.push(
          new T.Vector3(
            ...surface.section(
              a,
              k,
              side,
              inner ? Math.PI - (j * Math.PI) / 24 : (j * Math.PI) / 24,
            ),
          ),
        );
      lines.push(line);
      const zs = line.map((p) => p.z);
      spans.push([Math.min(...zs), Math.max(...zs)]);
    }
  }
  const islands = [];
  for (const [lo, hi] of spans.sort((a, b) => a[0] - b[0])) {
    const last = islands.at(-1);
    if (last && lo <= last[1] + 0.0001) last[1] = Math.max(last[1], hi);
    else islands.push([lo, hi]);
  }
  function at(z) {
    let best = null;
    for (const line of lines)
      for (let j = 1; j < line.length; j++) {
        const p = line[j - 1],
          q = line[j];
        if (
          z < Math.min(p.z, q.z) - 1e-6 ||
          z > Math.max(p.z, q.z) + 1e-6 ||
          Math.abs(q.z - p.z) < 1e-8
        )
          continue;
        const t = (z - p.z) / (q.z - p.z);
        const h = p.clone().lerp(q, t);
        if (!best || radial(h) > radial(best)) best = h;
      }
    return best;
  }
  return { islands, at };
}
function lanes(section, o, target) {
  // Assign lanes to solid strips. A three-row layout can straddle a split
  // only if each stone has a full bearing and border on its own arm.
  const strips = section.islands.map(([lo, hi]) => ({ lo, hi, n: 0 }));
  for (let i = 0; i < o.rows; i++) {
    let best,
      largest = -Infinity;
    for (const strip of strips) {
      const available =
        (strip.hi -
          strip.lo -
          2 * border -
          strip.n * staggerSpacing * clearance) /
        (1 + strip.n * staggerSpacing);
      if (available > largest + 0.0001) {
        best = strip;
        largest = available;
      }
    }
    best.n++;
  }
  const result = [];
  for (const { lo, hi, n } of strips) {
    const room = hi - lo - 2 * border;
    const d = Math.max(
      0,
      Math.min(
        target,
        (room - (n - 1) * staggerSpacing * clearance) /
          (1 + (n - 1) * staggerSpacing),
      ),
    );
    for (let j = 0; j < n; j++) {
      const valid =
        d >= minimum && (o.sizing === "graduated" || d >= target - 0.001);
      result.push({
        valid,
        d,
        z: (hi + lo) / 2 + (j - (n - 1) / 2) * (d + clearance) * staggerSpacing,
      });
    }
  }
  return result;
}
function pathsAlongShoulder(surface, o, diameter, start, sign) {
  const tracks = Array.from({ length: o.rows }, () => []);
  for (let i = 0; i <= 48; i++) {
    const a = sign * T.MathUtils.lerp(start, Math.PI / 2, i / 48),
      section = crossSection(surface, a);
    for (const [j, lane] of lanes(section, o, diameter).entries()) {
      const p =
        section.at(lane.z) ?? new T.Vector3(...surface.section(a, 0, 1, 0.48));
      const prev = tracks[j].at(-1),
        distance = prev ? prev.distance + prev.p.distanceTo(p) : 0;
      tracks[j].push({ a, p, distance });
    }
  }
  return tracks.map((samples) => ({
    length: samples.at(-1).distance,
    angle(distance) {
      const i = samples.findIndex((v) => v.distance >= distance);
      if (i <= 0) return (i === 0 ? samples[0] : samples.at(-1)).a;
      const l = samples[i - 1],
        r = samples[i];
      return T.MathUtils.lerp(
        l.a,
        r.a,
        (distance - l.distance) / (r.distance - l.distance),
      );
    },
  }));
}
export function paveLayout(surface, o, start) {
  const diameter = diameterFor(o.weight),
    pitch = Math.max(o.pitch, diameter + clearance);
  const seats = [],
    paths = [-1, 1].map((sign) =>
      pathsAlongShoulder(surface, o, diameter, start, sign),
    );
  const length = Math.min(...paths.map((tracks) => tracks[0].length));
  const max =
    start >= Math.PI / 2
      ? 0
      : Math.max(
          0,
          Math.min(14, 1 + Math.floor((length - diameter / 2) / pitch)),
        );
  const angles = Array.from({ length: max }, (_, i) =>
    Math.abs(paths[1][0].angle(i * pitch)),
  );
  for (const [side, tracks] of paths.entries())
    for (let i = 0; i < Math.min(o.pave, max); i++) {
      for (let row = 0; row < o.rows; row++) {
        const track = tracks[row];
        const dist = (i + (row % 2) * 0.5) * pitch;
        if (dist + diameter / 2 > track.length) continue;
        const a = track.angle(dist),
          section = crossSection(surface, a),
          lane = lanes(section, o, diameter)[row];
        if (!lane.valid) continue;
        const { d, z } = lane,
          p = section.at(z),
          left = section.at(z - 0.025),
          right = section.at(z + 0.025);
        if (!p || !left || !right) continue;
        const ahead = crossSection(surface, a + 0.002).at(z),
          behind = crossSection(surface, a - 0.002).at(z);
        if (!ahead || !behind) continue;
        const along = ahead.sub(behind).normalize(),
          across = right.sub(left).normalize();
        const normal = across.clone().cross(along).normalize();
        if (normal.dot(p.clone().setZ(0)) < 0) normal.negate();
        across.crossVectors(along, normal).normalize();
        // Verify the entire girdle has metal beneath it, including narrow valleys
        // on rolled or intertwined shanks. Preserve a metal floor under the pavilion.
        const bottom = crossSection(surface, a, true).at(z);
        if (!bottom || p.clone().sub(bottom).dot(normal) < d * 0.55 + 0.25)
          continue;
        const supported = [-0.44, 0.44].every((f) => {
          const rim = p.clone().addScaledVector(across, d * f),
            skin = section.at(rim.z);
          return skin && skin.sub(rim).dot(normal) > -d * 0.22;
        });
        if (
          !supported ||
          seats.some((s) => s.p.distanceTo(p) < (s.d + d) / 2 + 0.07)
        )
          continue;
        seats.push({
          i,
          row,
          side,
          a,
          p,
          d,
          along,
          across,
          normal,
          id: row * 100 + i * 2 + side,
        });
      }
    }
  return {
    seats,
    start,
    max,
    angles,
    pitchMm: pitch,
    pitch: pitch / radial(new T.Vector3(...surface.section(start, 0, 1, 0))),
    count: Math.min(o.pave, max),
  };
}

// A domed, tapered grain with a buried foot and a small burnished tip.
// The shared grain widens at the girdles and rounds over both crown edges.
const profile = [
  [0, 0.55],
  [0.24, 0.65],
  [0.47, 0.83],
  [0.65, 0.98],
  [0.74, 1],
  [0.84, 0.93],
  [0.92, 0.75],
  [0.975, 0.44],
  [1, 0],
];
export const grainGeometry = new T.LatheGeometry(
  profile.map(([y, r]) => new T.Vector2(r, y)),
  14,
);
export function grainMatrices(seats) {
  const out = [],
    groups = new Map();
  for (const s of seats) {
    const k = s.side + ":" + s.row;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  function lip(s, root) {
    const dir = root.clone().sub(s.p);
    dir.addScaledVector(s.normal, -dir.dot(s.normal)).normalize();
    const tip = s.p
      .clone()
      .addScaledVector(dir, s.d * 0.468)
      .addScaledVector(s.normal, s.d * 0.053);
    const axis = tip.clone().sub(root),
      height = axis.length();
    axis.normalize();
    const z = axis.clone().cross(dir).normalize(),
      x = axis.clone().cross(z).normalize();
    const m = new T.Matrix4()
      .makeBasis(x, axis, z)
      .scale(new T.Vector3(s.d * 0.09, height, s.d * 0.08))
      .setPosition(root);
    out.push(m);
  }
  function terminal(s, end) {
    for (const sign of [-1, 1]) {
      const dir = s.along
        .clone()
        .multiplyScalar(end * 0.8)
        .addScaledVector(s.across, sign * 0.6);
      lip(
        s,
        s.p
          .clone()
          .addScaledVector(dir, 0.53 * s.d)
          .addScaledVector(s.normal, -0.12 * s.d),
      );
    }
  }
  for (const line of groups.values()) {
    const forward = line[0].side ? 1 : -1;
    terminal(line[0], -forward);
    for (let i = 1; i < line.length; i++) {
      const s = line[i - 1],
        t = line[i],
        gap = s.p.distanceTo(t.p) - (s.d + t.d) / 2;
      if (t.i !== s.i + 1 || gap > 0.32 * Math.min(s.d, t.d)) {
        terminal(s, forward);
        terminal(t, -forward);
        continue;
      }
      for (const sign of [-1, 1]) {
        const d = Math.min(s.d, t.d),
          axis = s.normal.clone().add(t.normal).normalize();
        const along = t.p.clone().sub(s.p);
        along.addScaledVector(axis, -along.dot(axis)).normalize();
        const across = along.clone().cross(axis).normalize();
        const offset = sign * 0.19 * d;
        // Endpoints lie just inside both girdles. The polished cap spans the
        // measured alley and rises from one common foot in the remaining metal.
        const edge = (stone, direction) =>
          stone.p
            .clone()
            .addScaledVector(across, offset)
            .addScaledVector(
              along,
              direction * Math.sqrt((stone.d * 0.48) ** 2 - offset ** 2),
            );
        const left = edge(s, 1),
          right = edge(t, -1),
          foot = left
            .clone()
            .lerp(right, 0.5)
            .addScaledVector(axis, -0.115 * d);
        out.push(
          new T.Matrix4()
            .makeBasis(along, axis, across)
            .scale(
              new T.Vector3(
                Math.max(0.075 * d, left.distanceTo(right) * 0.56),
                0.19 * d,
                0.08 * d,
              ),
            )
            .setPosition(foot),
        );
      }
    }
    terminal(line.at(-1), forward);
  }
  return out;
}
