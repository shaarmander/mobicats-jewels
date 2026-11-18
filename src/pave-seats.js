import * as T from "three";

const faces = 20;
const planes = Array.from({ length: faces }, (_, i) => [
  Math.cos((2 * Math.PI * i) / faces),
  Math.sin((2 * Math.PI * i) / faces),
]);

// Clip only the outer skin at each girdle. The bearing and blind tapered seat
// share the resulting rim, so a stone can be inspected from above or below.
export function cutSeats(blank, seats) {
  if (!seats.length) return blank;
  const pos = blank.attributes.position,
    norm = blank.attributes.normal,
    uv = blank.attributes.uv;
  const positions = Array.from(pos.array),
    normals = Array.from(norm.array),
    uvs = Array.from(uv.array),
    index = [];
  const bins = new Map();
  for (const s of seats) {
    for (
      let y = Math.floor(s.p.y - s.d - 1);
      y <= Math.floor(s.p.y + s.d + 1);
      y++
    ) {
      if (!bins.has(y)) bins.set(y, []);
      bins.get(y).push(s);
    }
  }
  function vertex(p, n, u, v) {
    const id = positions.length / 3;
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    uvs.push(u, v);
    return id;
  }
  const position = (id) => new T.Vector3().fromArray(positions, 3 * id);
  const normal = (id) => new T.Vector3().fromArray(normals, 3 * id);
  function blend(a, b, t) {
    return vertex(
      position(a).lerp(position(b), t),
      normal(a).lerp(normal(b), t).normalize(),
      T.MathUtils.lerp(uvs[2 * a], uvs[2 * b], t),
      T.MathUtils.lerp(uvs[2 * a + 1], uvs[2 * b + 1], t),
    );
  }
  function triangleFan(poly) {
    for (let j = 2; j < poly.length; j++)
      index.push(poly[0], poly[j - 1], poly[j]);
  }
  function clip(poly, s) {
    const rel = (id) => position(id).sub(s.p);
    const insideRadius = 0.5 * s.d + Math.min(0.032, 0.038 * s.d);
    const coords = new Map();
    function xy(id) {
      if (!coords.has(id)) {
        const d = rel(id);
        coords.set(id, [d.dot(s.along), d.dot(s.across)]);
      }
      return coords.get(id);
    }
    const bounds = poly.map(xy),
      limit = insideRadius * 1.02;
    for (const axis of [0, 1])
      if (
        bounds.every((v) => v[axis] > limit) ||
        bounds.every((v) => v[axis] < -limit)
      )
        return [poly];
    const outside = [];
    let inside = poly;
    for (const [x, y] of planes) {
      const distance = (id) => {
        const [u, v] = xy(id);
        return u * x + v * y - insideRadius;
      };
      const dist = inside.map(distance);
      if (dist.every((d) => d > 0)) return [poly];
      if (dist.every((d) => d <= 0)) continue;
      const keep = [],
        cut = [];
      for (let k = 0; k < inside.length; k++) {
        const j = (k + 1) % inside.length,
          a = inside[k],
          b = inside[j],
          da = dist[k],
          db = dist[j];
        (da <= 0 ? keep : cut).push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const v = blend(a, b, da / (da - db));
          keep.push(v);
          cut.push(v);
        } else if (da === 0) cut.push(a);
      }
      if (cut.length >= 3) outside.push(cut);
      inside = keep;
      if (inside.length < 3) return outside;
    }
    // Only cylinder boundary edges are cut rims; other edges subdivide the old skin.
    for (let k = 0; k < inside.length; k++) {
      const a = inside[k],
        b = inside[(k + 1) % inside.length],
        aa = xy(a),
        bb = xy(b);
      const side = planes.find(
        ([x, y]) =>
          Math.abs(aa[0] * x + aa[1] * y - insideRadius) < 0.00001 &&
          Math.abs(bb[0] * x + bb[1] * y - insideRadius) < 0.00001,
      );
      if (!side || Math.hypot(aa[0] - bb[0], aa[1] - bb[1]) < 0.000001)
        continue;
      const inward = s.along
        .clone()
        .multiplyScalar(-side[0])
        .addScaledVector(s.across, -side[1]);
      const bearing = (xy, scale, h, n) =>
        vertex(
          s.p
            .clone()
            .addScaledVector(s.along, xy[0] * scale)
            .addScaledVector(s.across, xy[1] * scale)
            .addScaledVector(s.normal, h * s.d),
          n,
          xy[0],
          xy[1],
        );
      const bevel = inward.clone().addScaledVector(s.normal, 0.78).normalize();
      const rimA = vertex(position(a), bevel, ...aa),
        rimB = vertex(position(b), bevel, ...bb);
      const contact = (0.5 * s.d) / insideRadius,
        topA = bearing(aa, contact, -0.055, bevel),
        topB = bearing(bb, contact, -0.055, bevel);
      index.push(rimA, rimB, topB, rimA, topB, topA);
      const ledgeA = bearing(aa, 0.96, -0.15, inward),
        ledgeB = bearing(bb, 0.96, -0.15, inward);
      index.push(topA, topB, ledgeB, topA, ledgeB, ledgeA);
      const slope = inward.clone().addScaledVector(s.normal, 1.1).normalize();
      const shoulderA = bearing(aa, 0.96, -0.15, slope),
        shoulderB = bearing(bb, 0.96, -0.15, slope);
      const bottom = bearing([0, 0], 0, -0.55, slope);
      index.push(shoulderA, shoulderB, bottom);
    }
    return outside;
  }
  const ids = blank.index.array;
  for (let i = 0; i < ids.length; i += 3) {
    const a = ids[i],
      b = ids[i + 1],
      c = ids[i + 2],
      x = pos.getX(a),
      y = pos.getY(a),
      z = pos.getZ(a);
    let polygons;
    for (const s of bins.get(Math.floor(y)) || []) {
      const reach = s.d * 0.72 + 0.9;
      if (
        Math.abs(x - s.p.x) > reach ||
        Math.abs(y - s.p.y) > reach ||
        Math.abs(z - s.p.z) > reach
      )
        continue;
      if (
        norm.getX(a) * s.normal.x +
          norm.getY(a) * s.normal.y +
          norm.getZ(a) * s.normal.z <
        0.08
      )
        continue;
      const height =
        (x - s.p.x) * s.normal.x +
        (y - s.p.y) * s.normal.y +
        (z - s.p.z) * s.normal.z;
      if (height < -0.42 * s.d || height > 0.5 * s.d) continue;
      polygons = (polygons ?? [[a, b, c]]).flatMap((poly) => clip(poly, s));
    }
    if (polygons) for (const poly of polygons) triangleFan(poly);
    else index.push(a, b, c);
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}
