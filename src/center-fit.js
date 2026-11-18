import * as T from "three";

// Fit the existing polished casting around the resized center. The lower shank
// stays at its native US size. Accent seats translate with their stones.
export class CenterFit {
  constructor(model, stones, binding) {
    this.model = model;
    this.stones = stones;
    this.center = stones.find((m) => m.userData.role === "center");
    this.centerScale = this.center.scale.x;
    this.origins = stones.map((m) => m.position.clone());
    this.mesh = model.getObjectByName("band");
    const geo = this.mesh.geometry;
    this.rest = geo.attributes.position.array.slice();
    this.normals = geo.attributes.normal.array.slice();
    this.nativePose = {
      position: model.position.clone(),
      rotation: model.quaternion.clone(),
    };
    const header = new DataView(binding);
    const count = geo.attributes.position.count;
    if (
      header.getUint32(0) !== 0x46495431 ||
      header.getUint32(4, true) !== count ||
      header.getUint32(8, true) !== stones.length ||
      binding.byteLength !== 12 + stones.length * 12 + count * 24
    )
      throw Error("Setting dimensions do not match the casting");
    const shifts = new Float32Array(binding, 12, stones.length * 3);
    this.shifts = stones.map((_, i) =>
      new T.Vector3().fromArray(shifts, i * 3),
    );
    this.fields = new Int16Array(binding, 12 + shifts.byteLength);
    // Preserve the polished normals from the high-resolution master after
    // the decimated casting changes shape.
    geo.computeVertexNormals();
    const base = geo.attributes.normal.array;
    for (let i = 0; i < base.length; i++) this.normals[i] -= base[i];
    this.stonePoints = new Float32Array(
      stones.reduce((n, m) => n + m.geometry.attributes.position.count * 3, 0),
    );
  }
  apply(scale, profile) {
    if (this.scale === scale && this.profile === profile) return;
    this.scale = scale;
    this.profile = profile;
    const t = scale - 1;
    const geo = this.mesh.geometry,
      pos = geo.attributes.position;
    const count = pos.count;
    const profileIndex = { fine: 1, classic: 2, bold: 3 }[profile];
    const start = profileIndex * count * 3;
    for (let axis = 0; axis < 3; axis++) {
      const a = axis * count;
      for (let i = 0; i < count; i++) {
        const j = i * 3 + axis;
        pos.array[j] =
          this.rest[j] +
          0.001 * (this.fields[a + i] * t + this.fields[start + a + i]);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const normal = geo.attributes.normal;
    for (let i = 0; i < normal.array.length; i++)
      normal.array[i] += this.normals[i];
    geo.normalizeNormals();
    geo.computeBoundingSphere();
    this.volume = meshVolume(geo);
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
    this.restOnFloor(pos.array);
    this.model.updateMatrixWorld(true);
  }
  restOnFloor(metal, other = [this.stonePoints]) {
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
      for (const vertices of [metal, ...other]) {
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

// Signed tetrahedral volumes of the closed, welded metal surface in mm³.
export function meshVolume(geometry) {
  const v = geometry.attributes.position.array,
    ids = geometry.index.array;
  let volume = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const a = 3 * ids[i],
      b = 3 * ids[i + 1],
      c = 3 * ids[i + 2];
    volume +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
      v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(volume) / 6;
}
