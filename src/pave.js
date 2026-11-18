import * as T from "three";

// Calibrated from the round melee mesh (diameter in millimetres at its native scale).
export const meleeDiameter = 1.2999999523162842;
export const meleeCarats = 0.00796800758689642;
export const paveDefaults = {
  coverage: "shoulders",
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
function pathsAlongShoulder(surface, o, diameter, start, end, sign) {
  const tracks = Array.from({ length: o.rows }, () => []);
  const steps = Math.ceil((48 * end) / (Math.PI / 2));
  for (let i = 0; i <= steps; i++) {
    const a = sign * T.MathUtils.lerp(start, end, i / steps),
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
function layoutPositions(o, paths, pitch, diameter, end, start) {
  const positions = [],
    angles = [],
    rowPitches = [];
  const manual = o.coverage === "shoulders" || !o.coverage;
  if (o.coverage === "full") {
    // Treat the two shoulders as one path from one side of the setting to
    // the other. The back seam is an ordinary interval on that path.
    const lengths = paths[0].map(
      (track, row) => track.length + paths[1][row].length,
    );
    const intervals = Math.floor(Math.min(...lengths) / pitch);
    if (start < end && intervals > 0) {
      for (let row = 0; row < o.rows; row++) {
        const spacing = lengths[row] / intervals,
          offset = (row % 2) * 0.5;
        rowPitches.push(spacing);
        for (let order = 0; order + offset <= intervals; order++) {
          const distance = (order + offset) * spacing;
          const side = distance <= paths[1][row].length ? 1 : 0;
          const fromHead = side
            ? distance
            : Math.max(0, lengths[row] - distance);
          const i = side ? order : intervals - order - (row % 2);
          positions.push({
            a: paths[side][row].angle(fromHead),
            side,
            i,
            row,
            order,
          });
        }
      }
    }
    return { positions, angles, max: 0, count: 0, rowPitches };
  }
  const length = Math.min(...paths.map((t) => t[0].length));
  const max =
    start >= end
      ? 0
      : Math.max(
          0,
          Math.min(
            manual ? 14 : Infinity,
            1 + Math.floor((length - diameter / 2) / pitch),
          ),
        );
  const count = manual ? Math.min(o.pave, max) : max;
  for (let i = 0; i < max; i++)
    angles.push(Math.abs(paths[1][0].angle(i * pitch)));
  for (const [side, tracks] of paths.entries())
    for (let i = 0; i < count; i++)
      for (let row = 0; row < o.rows; row++) {
        const distance = (i + (row % 2) * 0.5) * pitch;
        if (distance + diameter / 2 <= tracks[row].length)
          positions.push({ a: tracks[row].angle(distance), side, i, row });
      }
  return { positions, angles, max, count, rowPitches: [pitch] };
}
export function paveLayout(surface, o, start) {
  const diameter = diameterFor(o.weight),
    pitch = Math.max(o.pitch, diameter + clearance);
  const end =
    o.coverage === "full"
      ? Math.PI
      : o.coverage === "threeQuarter"
        ? (3 * Math.PI) / 4
        : Math.PI / 2;
  const paths = [-1, 1].map((sign) =>
    pathsAlongShoulder(surface, o, diameter, start, end, sign),
  );
  const { positions, angles, max, count, rowPitches } = layoutPositions(
    o,
    paths,
    pitch,
    diameter,
    end,
    start,
  );
  const seats = [];
  for (const { a, side, i, row, order } of positions) {
    const section = crossSection(surface, a),
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
      order,
      id:
        i < 50 ? row * 100 + 2 * i + side : 300 + 6 * (i - 50) + 2 * row + side,
    });
  }
  return {
    seats,
    requested: positions.length,
    rowPitches,
    start,
    max,
    angles,
    pitchMm: rowPitches[0] ?? pitch,
    pitch: pitch / radial(new T.Vector3(...surface.section(start, 0, 1, 0))),
    count,
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
    const k = s.order === undefined ? s.side + ":" + s.row : "wrap:" + s.row;
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
    const forward = line[0].order !== undefined || line[0].side ? 1 : -1;
    terminal(line[0], -forward);
    for (let i = 1; i < line.length; i++) {
      const s = line[i - 1],
        t = line[i],
        gap = s.p.distanceTo(t.p) - (s.d + t.d) / 2;
      if (
        (t.order ?? t.i) !== (s.order ?? s.i) + 1 ||
        gap > 0.32 * Math.min(s.d, t.d)
      ) {
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
