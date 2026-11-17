import * as T from "three";

// Fit the existing polished casting around the resized center. The lower shank
// stays at its native US size. Accent seats translate with their stones.
export class CenterFit {
  constructor(model, stones) {
    this.model = model;
    this.stones = stones;
    this.center = stones.find((m) => m.userData.role === "center");
    this.centerScale = this.center.scale.x;
    this.origins = stones.map((m) => m.position.clone());
    this.mesh = model.getObjectByName("band");
    const geo = this.mesh.geometry;
    this.rest = geo.attributes.position.array.slice();
    this.normals = geo.attributes.normal.array.slice();
    this.delta = new Float32Array(this.rest.length);
    this.linear = new Float32Array(this.rest.length);
    this.quadratic = new Float32Array(this.rest.length);
    this.nativePose = {
      position: model.position.clone(),
      rotation: model.quaternion.clone(),
    };
    const c = this.center.position;
    const box = new T.Box3();
    const p = new T.Vector3();
    this.center.updateMatrix();
    const verts = this.center.geometry.attributes.position;
    for (let i = 0; i < verts.count; i++)
      box.expandByPoint(
        p.fromBufferAttribute(verts, i).applyMatrix4(this.center.matrix),
      );
    const half = box.getSize(new T.Vector3()).multiplyScalar(0.5);
    const foot = Math.min(c.y - 1.5, 9.5);
    const shoulder = (value, limit) => {
      const extra = Math.max(0, Math.abs(value) - limit);
      return extra
        ? Math.sign(value) * (limit + extra / (1 + extra / 0.35))
        : value;
    };
    const field = (v, out) => {
      const w = T.MathUtils.smoothstep(v.y, foot - 1.5, c.y - 0.65);
      return out
        .set(
          shoulder(v.x - c.x, half.x + 0.55),
          v.y - foot,
          shoulder(v.z - c.z, half.z + 0.55),
        )
        .multiplyScalar(w);
    };
    this.shifts = this.origins.map((v) => field(v, new T.Vector3()));
    const seats = stones.flatMap((stone, i) => {
      if (stone === this.center) return [];
      stone.geometry.computeBoundingSphere();
      return [
        {
          position: this.origins[i],
          radius: stone.geometry.boundingSphere.radius * stone.scale.x,
          shift: this.shifts[i],
        },
      ];
    });
    const displacement = (v, out) => {
      field(v, out);
      for (const seat of seats) {
        const d = v.distanceToSquared(seat.position);
        const outer = seat.radius + 0.65;
        if (d < outer * outer)
          out.lerp(
            seat.shift,
            1 - T.MathUtils.smoothstep(Math.sqrt(d), seat.radius * 0.8, outer),
          );
      }
      return out;
    };
    const n = new T.Vector3(),
      u = new T.Vector3(),
      v = new T.Vector3();
    const d = new T.Vector3(),
      du = new T.Vector3(),
      dv = new T.Vector3(),
      temp = new T.Vector3(),
      cross = new T.Vector3();
    for (let i = 0; i < this.rest.length; i += 3) {
      p.fromArray(this.rest, i);
      displacement(p, d).toArray(this.delta, i);
      n.fromArray(this.normals, i);
      u.set(0, 1, 0);
      if (Math.abs(n.y) > 0.9) u.set(1, 0, 0);
      u.cross(n).normalize();
      v.crossVectors(n, u);
      displacement(temp.copy(p).addScaledVector(u, 0.01), du)
        .sub(d)
        .multiplyScalar(100);
      displacement(temp.copy(p).addScaledVector(v, 0.01), dv)
        .sub(d)
        .multiplyScalar(100);
      // Cofactors of the deforming tangent frame preserve the welded shading normals.
      cross
        .crossVectors(du, v)
        .add(temp.crossVectors(u, dv))
        .toArray(this.linear, i);
      cross.crossVectors(du, dv).toArray(this.quadratic, i);
    }
    this.stonePoints = new Float32Array(
      stones.reduce((n, m) => n + m.geometry.attributes.position.count * 3, 0),
    );
  }
  apply(scale) {
    if (this.scale === scale) return;
    this.scale = scale;
    const t = scale - 1,
      t2 = t * t;
    const geo = this.mesh.geometry,
      pos = geo.attributes.position,
      normal = geo.attributes.normal;
    for (let i = 0; i < this.rest.length; i++) {
      pos.array[i] = this.rest[i] + t * this.delta[i];
      normal.array[i] =
        this.normals[i] + t * this.linear[i] + t2 * this.quadratic[i];
    }
    pos.needsUpdate = normal.needsUpdate = true;
    geo.computeBoundingSphere();
    this.center.scale.setScalar(this.centerScale * scale);
    this.center.userData.mmPerUnit = this.center.scale.x;
    const p = new T.Vector3();
    let offset = 0;
    this.stones.forEach((m, i) => {
      m.position.copy(this.origins[i]).addScaledVector(this.shifts[i], t);
      m.updateMatrix();
      const vertices = m.geometry.attributes.position;
      for (let k = 0; k < vertices.count; k++, offset += 3)
        p.fromBufferAttribute(vertices, k)
          .applyMatrix4(m.matrix)
          .toArray(this.stonePoints, offset);
    });
    this.model.position.copy(this.nativePose.position);
    this.model.quaternion.copy(this.nativePose.rotation);
    if (Math.abs(t) > 0.00001) this.restOnFloor(pos.array);
    this.model.updateMatrixWorld(true);
  }
  restOnFloor(metal) {
    // Balance front and rear contacts after a wider basket changes the resting angle.
    let low = -0.45,
      high = 0.85,
      pitch,
      contact;
    for (let i = 0; i < 14; i++) {
      pitch = (low + high) / 2;
      const a = Math.sin(pitch),
        b = Math.cos(pitch);
      let front = Infinity,
        rear = Infinity;
      for (const vertices of [metal, this.stonePoints]) {
        for (let j = 1; j < vertices.length; j += 3) {
          const y = vertices[j],
            height = a * y + b * vertices[j + 1];
          if (y > 0) front = Math.min(front, height);
          else rear = Math.min(rear, height);
        }
      }
      contact = Math.min(front, rear);
      if (front > rear) high = pitch;
      else low = pitch;
    }
    const half = (pitch - Math.PI / 2) / 2;
    this.model.quaternion.set(0, Math.cos(half), -Math.sin(half), 0);
    this.model.position.y = -contact;
  }
}
