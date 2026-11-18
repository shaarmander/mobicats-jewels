import * as T from "three";
import { gunzipSync } from "three/addons/libs/fflate.module.js";
import melee from "./melee.json";
import {
  bandDefaults,
  bandSurface,
  sweepBand,
  finishTexture,
} from "./band-shape.js";
import { meshVolume } from "./center-fit.js";

const point = new T.Vector3(),
  matrix = new T.Matrix4();
const geometry = new T.BufferGeometry();
geometry.setAttribute(
  "position",
  new T.Float32BufferAttribute(melee.POSITION, 3),
);
geometry.setAttribute("normal", new T.Float32BufferAttribute(melee.NORMAL, 3));
geometry.setIndex(melee.indices);
const sphere = new T.SphereGeometry(1, 16, 12);
const textures = new Map();
function detailedHead(bytes) {
  const data = gunzipSync(new Uint8Array(bytes));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(4, true),
    num = view.getUint32(8, true);
  if (
    view.getUint32(0, true) !== 0x31444548 ||
    data.length !== 12 + 22 * count + 2 * num
  )
    throw Error("Invalid setting head");
  const raw = new Int16Array(data.buffer, data.byteOffset + 12, 11 * count);
  const rest = new Float32Array(3 * count),
    normal = new Float32Array(3 * count);
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      rest[3 * i + k] = raw[11 * i + k] * 0.001;
      normal[3 * i + k] = raw[11 * i + 3 + k] / 32767;
    }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.BufferAttribute(rest.slice(), 3));
  geo.setIndex(
    new T.BufferAttribute(
      new Uint16Array(data.buffer, data.byteOffset + 12 + count * 22, num),
      1,
    ),
  );
  geo.computeVertexNormals();
  const base = geo.attributes.normal.array;
  for (let j = 0; j < normal.length; j++) normal[j] -= base[j];
  return { geo, rest, normal, raw };
}
function fitHead(head, fit) {
  if (head.scale === fit.scale && head.profile === fit.profile) return;
  const { geo, rest, normal, raw } = head,
    pos = geo.attributes.position;
  const driver = fit.mesh.geometry.attributes.position.array;
  for (let i = 0; i < pos.count; i++) {
    const k = 11 * i,
      a = 3 * (raw[k + 6] & 65535),
      b = 3 * (raw[k + 7] & 65535),
      c = 3 * (raw[k + 8] & 65535);
    const w = raw[k + 9] / 10000,
      v = raw[k + 10] / 10000;
    for (let axis = 0; axis < 3; axis++)
      pos.array[i * 3 + axis] =
        rest[i * 3 + axis] +
        w * (driver[a + axis] - fit.rest[a + axis]) +
        v * (driver[b + axis] - fit.rest[b + axis]) +
        (1 - w - v) * (driver[c + axis] - fit.rest[c + axis]);
  }
  geo.computeVertexNormals();
  const n = geo.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] += normal[i];
  geo.normalizeNormals();
  geo.computeBoundingSphere();
  pos.needsUpdate = true;
  head.scale = fit.scale;
  head.profile = fit.profile;
  head.volume = meshVolume(geo);
}

export class CustomBand {
  constructor(studio) {
    this.studio = studio;
    this.metal = new T.MeshStandardMaterial({ metalness: 1, roughness: 0.085 });
    this.gems = [];
    this.options = null;
    this.ticket = 0;
  }
  // Finishing a stock casting should keep its exact outline, seats and stones.
  // Split the existing index into two material groups without moving vertices.
  applyNativeFinish(fit) {
    if (this.nativeFinish) return;
    const mesh = fit.mesh,
      geo = mesh.geometry,
      index = geo.getIndex();
    const uv = new Float32Array((fit.rest.length / 3) * 2);
    const bore = (this.studio.model.userData.bandDiameter || 16.5068) / 2;
    const dimensions = bandDefaults(this.studio);
    for (let i = 0; i < uv.length / 2; i++) {
      const [x, y, z] = fit.rest.subarray(i * 3, i * 3 + 3);
      uv[2 * i] = (Math.atan2(x, -y) / (2 * Math.PI) + 0.5) * 12;
      uv[2 * i + 1] =
        Math.atan2(
          z / dimensions.width,
          (Math.hypot(x, y) - bore - dimensions.thickness / 2) /
            dimensions.thickness,
        ) /
        (2 * Math.PI);
    }
    const polished = [],
      finished = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i),
        b = index.getX(i + 1),
        c = index.getX(i + 2);
      const y =
        (fit.rest[3 * a + 1] + fit.rest[3 * b + 1] + fit.rest[3 * c + 1]) / 3;
      (y < 9.9 ? finished : polished).push(a, b, c);
    }
    this.nativeFinish = {
      mesh,
      index,
      uv: geo.getAttribute("uv"),
      groups: geo.groups.slice(),
      material: mesh.material,
    };
    geo.dispose();
    geo.setAttribute("uv", new T.BufferAttribute(uv, 2));
    geo.setIndex([...polished, ...finished]);
    geo.clearGroups();
    geo.addGroup(0, polished.length, 0);
    geo.addGroup(polished.length, finished.length, 1);
    mesh.material = [this.studio.bandMat, this.metal];
  }
  clearNativeFinish() {
    if (!this.nativeFinish) return;
    const { mesh, index, uv, groups, material } = this.nativeFinish,
      geo = mesh.geometry;
    geo.dispose();
    geo.setIndex(index);
    if (uv) geo.setAttribute("uv", uv);
    else geo.deleteAttribute("uv");
    geo.groups = groups;
    mesh.material = material;
    this.nativeFinish = null;
  }
  clearGeometry() {
    this.clearNativeFinish();
    this.surface = null;
    if (!this.group) return;
    this.group.removeFromParent();
    this.shank.geometry.dispose();
    this.beads?.dispose();
    this.beads = null;
    this.group = null;
    this.gems = [];
    this.volume = null;
    this.studio.fit.mesh.visible = true;
    this.studio.stones = this.studio.fit.stones;
    for (const m of this.studio.stones) m.visible = true;
  }
  detach() {
    this.ticket++;
    this.clearGeometry();
    this.head = null;
    this.options = null;
  }
  async edit(options) {
    const s = this.studio,
      fit = s.fit,
      ticket = ++this.ticket;
    if (!options) {
      this.clearGeometry();
      this.options = null;
      s.focusPick = null;
      fit.scale = undefined;
      s.setGems(s.state.center, s.state.accent);
      return true;
    }
    if (
      this.group &&
      this.options &&
      Object.keys(options).every(
        (k) => k === "finish" || options[k] === this.options[k],
      )
    ) {
      this.options = options;
      this.refreshFinish();
      s.invalidate(true);
      return true;
    }
    const defaults = bandDefaults(s);
    if (
      Object.keys(defaults).every(
        (k) => k === "finish" || defaults[k] === options[k],
      )
    ) {
      if (this.group) {
        this.clearGeometry();
        s.focusPick = null;
        fit.scale = undefined;
        s.setGems(s.state.center, s.state.accent);
      }
      this.options = options;
      this.refreshFinish();
      if (options.finish === "polished") this.clearNativeFinish();
      else this.applyNativeFinish(fit);
      s.invalidate(true);
      return true;
    }
    // Keep the last valid ring on screen until its replacement is ready.
    if (!fit.headPromise)
      fit.headPromise = fetch(
        "/assets/heads/" + s.state.setting + "-" + s.state.cut + ".head",
      )
        .then((r) => {
          if (!r.ok) throw Error("Setting head unavailable");
          return r.arrayBuffer();
        })
        .then(detailedHead)
        .catch((e) => {
          fit.headPromise = null;
          throw e;
        });
    const head = await fit.headPromise;
    if (ticket !== this.ticket || s.fit !== fit) return false;
    this.head = head;
    this.options = options;
    this.clearGeometry();
    s.focusPick = null;
    fitHead(head, fit);
    const original = fit.stones;
    s.stones = original.filter((m) => m.userData.role !== "pave");
    original.forEach((m) => (m.visible = m.userData.role !== "pave"));
    fit.mesh.visible = false;
    this.group = new T.Group();
    s.model.add(this.group);
    const mount = new T.Mesh(head.geo, s.bandMat);
    mount.name = "setting-head";
    mount.userData.role = "head";
    mount.castShadow = true;
    this.group.add(mount);
    this.bore = (s.model.userData.bandDiameter || 16.5068) / 2;
    const surface = bandSurface(s.state.setting, options, this.bore);
    this.shank = new T.Mesh(sweepBand(surface), this.metal);
    this.shank.name = "custom-shank";
    this.shank.userData.role = "band";
    this.shank.castShadow = true;
    this.group.add(this.shank);
    this.surface = surface;
    this.refreshFinish();
    this.populate();
    s.setGems(s.state.center, s.state.accent);
    return true;
  }
  refreshFinish() {
    const s = this.studio,
      finish = this.options.finish,
      m = this.metal;
    m.color.copy(s.bandMat.color);
    m.envMap = s.bandMat.envMap;
    if (finish !== "polished" && !textures.has(finish))
      textures.set(finish, finishTexture(finish));
    const map = textures.get(finish) || null;
    if (!!m.bumpMap !== !!map) m.needsUpdate = true;
    m.bumpMap = map;
    m.bumpScale = finish === "brushed" ? 0.014 : 0.095;
    m.roughness = {
      polished: s.polishRoughness,
      brushed: 0.34,
      hammered: 0.16,
    }[finish];
  }
  firstAngle() {
    let start = 0.26;
    for (const mesh of this.studio.fit.stones) {
      if (mesh.userData.role === "pave") continue;
      const a = Math.abs(Math.atan2(mesh.position.x, mesh.position.y));
      const width =
        mesh.geometry.boundingBox ||
        (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox);
      const radius = Math.max(width.max.x, -width.min.x) * mesh.scale.x;
      start = Math.max(
        start,
        a +
          Math.atan2(
            radius + 0.45,
            Math.hypot(mesh.position.x, mesh.position.y),
          ),
      );
    }
    return start;
  }
  row() {
    const start = this.firstAngle(),
      span = Math.max(0.05, Math.PI / 2 - start);
    const nativeCount =
      this.studio.fit.stones.filter((m) => m.userData.role === "pave").length /
      2;
    const max = Math.min(
      14,
      Math.max(nativeCount, 1 + Math.floor(span / 0.143)),
    );
    const pitch = Math.min(0.143, span / Math.max(1, max - 1));
    return {
      start,
      pitch,
      max,
      size: pitch / 0.143,
      count: Math.min(this.options?.pave || 0, max),
    };
  }
  populate() {
    const s = this.studio,
      count = this.options.pave;
    for (let i = 0; i < count; i++)
      for (const side of [-1, 1]) {
        const m = new T.Mesh(geometry, this.metal);
        m.name = "pave-" + (2 * i + (side > 0 ? 1 : 0));
        m.userData = { ...melee.extras };
        m.scale.setScalar(melee.scale);
        m.userData.mmPerUnit = melee.scale;
        this.group.add(m);
        this.gems.push(m);
        s.stones.push(m);
      }
  }
  stonePoint(angle, side = 1, t = 0.0) {
    return this.surface.section(angle, 0, side, t);
  }
  layout() {
    if (!this.group) return;
    const s = this.studio,
      fit = s.fit;
    fitHead(this.head, fit);
    const { start, pitch, count, size } = this.row();
    // A wider center can cover a row's first seat. Rebuild its active stones on the next fit.
    const active = Math.min(count, this.gems.length / 2);
    const beadList = [];
    let extraVolume = 0;
    for (let j = 0; j < this.gems.length; j++) {
      const i = Math.floor(j / 2),
        sign = j % 2 ? 1 : -1,
        m = this.gems[j];
      m.userData.bandHidden = i >= active;
      m.visible = !m.userData.bandHidden;
      if (!m.visible) continue;
      m.scale.setScalar(melee.scale * size);
      m.userData.mmPerUnit = m.scale.x;
      m.userData.diamondCarats = melee.extras.diamondCarats * size ** 3;
      const a = sign * (start + i * pitch);
      // Put the bearing on the crown of the chosen strand. A split or
      // twisted shoulder can have its crown well off the central plane.
      let crown,
        t = 0,
        highest = -Infinity;
      for (let j = 0; j <= 16; j++) {
        const u = (1.3 * j) / 16,
          sample = this.stonePoint(a, 1, u),
          radius = Math.hypot(sample[0], sample[1]);
        if (radius > highest) {
          highest = radius;
          crown = sample;
          t = u;
        }
      }
      const tangent = new T.Vector3()
        .fromArray(this.stonePoint(a + 0.002, 1, t))
        .sub(new T.Vector3().fromArray(this.stonePoint(a - 0.002, 1, t)))
        .normalize();
      const across = new T.Vector3()
        .fromArray(this.stonePoint(a, 1, t + 0.012))
        .sub(
          new T.Vector3().fromArray(
            t > 0.012
              ? this.stonePoint(a, 1, t - 0.012)
              : this.stonePoint(a, -1, 0.012 - t),
          ),
        )
        .normalize();
      const normal = across.clone().cross(tangent).normalize();
      if (normal.dot(new T.Vector3(Math.sin(a), Math.cos(a), 0)) < 0)
        normal.negate();
      across.crossVectors(tangent, normal).normalize();
      m.position.fromArray(crown).addScaledVector(normal, 0.075 * size);
      m.quaternion.setFromRotationMatrix(
        matrix.makeBasis(tangent, normal, across),
      );
      for (const dz of [-0.47, 0.47])
        for (const offset of [-0.46, 0.46]) {
          const p = m.position
            .clone()
            .addScaledVector(tangent, offset * size)
            .addScaledVector(across, dz * size)
            .addScaledVector(normal, 0.045 * size);
          beadList.push([p.x, p.y, p.z, 0.195 * size]);
        }
    }
    if (this.options.edge === "beaded") {
      for (let i = 0; i < 154; i++)
        for (const side of [-1, 1]) {
          const a = (i / 154) * 2 * Math.PI - Math.PI;
          const p = this.surface.section(
            a,
            side < 0 ? 0 : this.surface.strands - 1,
            side,
            1.19,
          );
          beadList.push([...p, 0.125]);
        }
    }
    if (this.beads && this.beads.count !== beadList.length) {
      if (s.focusPick?.object === this.beads) s.focusPick = null;
      this.beads.removeFromParent();
      this.beads.dispose();
      this.beads = null;
    }
    if (beadList.length) {
      const mesh =
        this.beads ?? new T.InstancedMesh(sphere, s.bandMat, beadList.length);
      beadList.forEach(([x, y, z, r], i) => {
        matrix.makeScale(r, r, r);
        matrix.setPosition(x, y, z);
        mesh.setMatrixAt(i, matrix);
        extraVolume += ((0.5 * 4) / 3) * Math.PI * r ** 3;
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.name = "band-beads";
      mesh.userData.role = "band";
      if (!mesh.parent) this.group.add(mesh);
      this.beads = mesh;
    }
    this.shankVolume ??= new WeakMap();
    if (!this.shankVolume.has(this.shank.geometry))
      this.shankVolume.set(
        this.shank.geometry,
        meshVolume(this.shank.geometry),
      );
    this.volume =
      this.shankVolume.get(this.shank.geometry) +
      this.head.volume +
      extraVolume;
    // Use the edited shank, head and visible stones as floor supports.
    const points = [
      this.shank.geometry.attributes.position.array,
      this.head.geo.attributes.position.array,
    ];
    for (const m of s.stones) {
      if (m.userData.bandHidden) continue;
      m.updateMatrix();
      const v = m.geometry.attributes.position,
        out = new Float32Array(v.count * 3);
      for (let i = 0; i < v.count; i++)
        point
          .fromBufferAttribute(v, i)
          .applyMatrix4(m.matrix)
          .toArray(out, i * 3);
      points.push(out);
    }
    if (beadList.length) {
      const shell = [];
      for (const [x, y, z, r] of beadList)
        for (let j = 0; j < 16; j++)
          shell.push(
            x,
            y + r * Math.cos((j * Math.PI) / 8),
            z + r * Math.sin((j * Math.PI) / 8),
          );
      points.push(shell);
    }
    fit.restOnFloor(points[0], points.slice(1));
    s.model.updateMatrixWorld(true);
  }
}
