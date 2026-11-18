import { Matrix4, Quaternion, Vector2, Vector3, MathUtils } from "three";

const { clamp, smoothstep } = MathUtils;
const median = (values) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Look for both sides of the finger in the same cropped frame as the landmarks.
// Use local colour differences so this does not require a skin-colour threshold.
function fingerEdges(ctx, center, along, diameter) {
  const { width, height } = ctx.canvas;
  if (diameter < 8 || diameter > Math.min(width, height) / 3) return;
  const radius = Math.ceil(diameter + 3);
  const x0 = Math.floor(center.x) - radius,
    y0 = Math.floor(center.y) - radius;
  const size = radius * 2 + 1;
  if (x0 < 0 || y0 < 0 || x0 + size > width || y0 + size > height) return;
  const { data } = ctx.getImageData(x0, y0, size, size);
  const dx = -along.y,
    dy = along.x;
  const step = Math.max(1, diameter * 0.055);
  const offsets = [],
    widths = [];
  for (const slice of [-0.23, 0, 0.23]) {
    const x = center.x - x0 + along.x * slice * diameter;
    const y = center.y - y0 + along.y * slice * diameter;
    const index = (dist) =>
      4 * (Math.round(y + dy * dist) * size + Math.round(x + dx * dist));
    const edge = (sign) => {
      let best = 13,
        distance = 0;
      for (let d = Math.ceil(diameter * 0.28); d <= diameter * 0.76; ++d) {
        const a = index(sign * (d - step)),
          b = index(sign * (d + step));
        const contrast =
          (Math.abs(data[a] - data[b]) +
            Math.abs(data[a + 1] - data[b + 1]) +
            Math.abs(data[a + 2] - data[b + 2])) /
          3;
        const score = contrast / (1 + Math.abs(d / diameter - 0.5) * 2);
        if (score > best) {
          best = score;
          distance = d;
        }
      }
      return distance;
    };
    const left = edge(-1),
      right = edge(1),
      span = left + right;
    if (left && right && span > diameter * 0.72 && span < diameter * 1.32) {
      offsets.push((right - left) / 2);
      widths.push(span);
    }
  }
  if (
    offsets.length < 2 ||
    Math.max(...offsets) - Math.min(...offsets) > diameter * 0.15 ||
    Math.max(...widths) - Math.min(...widths) > diameter * 0.22
  )
    return;
  return { offset: median(offsets), width: median(widths) };
}

export class RingFingerPose {
  constructor() {
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.rotation = new Quaternion();
    this.reset();
  }
  reset() {
    this.time = -Infinity;
    this.pending = null;
    this.backSign = null;
    this.handCandidate = null;
    this.snap = true;
    this.velocity.set(0, 0, 0);
  }
  update(result, capture, width, height, ctx) {
    const image = result?.landmarks?.[0],
      world = result?.worldLandmarks?.[0];
    if (!image || !world) {
      this.pending = null;
      return;
    }
    const screen = (i) => new Vector2(image[i].x * width, image[i].y * height);
    const point = (i) => new Vector3(world[i].x, -world[i].y, -world[i].z);
    const base = screen(13),
      joint = screen(14);
    const along = joint.clone().sub(base),
      bone = point(14).sub(point(13));
    if (along.length() < 4 || bone.length() < 0.005) return;
    along.normalize();
    const center = base.lerp(joint, 0.43);
    let pixels = 0,
      metres = 0;
    for (const [a, b] of [
      [5, 17],
      [0, 9],
      [13, 14],
    ]) {
      pixels += screen(a).distanceTo(screen(b));
      const delta = point(a).sub(point(b));
      metres += Math.hypot(delta.x, delta.y);
    }
    const spacing =
      (point(13).distanceTo(point(9)) + point(13).distanceTo(point(17))) / 2;
    let diameter = (0.84 * spacing * pixels) / Math.max(0.001, metres);
    if (!(diameter >= 3 && diameter < Math.min(width, height) * 0.6)) return;
    const factor = ctx.canvas.width / width;
    const edges = fingerEdges(
      ctx,
      center.clone().multiplyScalar(factor),
      along,
      diameter * factor,
    );
    if (edges) {
      const shift = clamp(
        edges.offset / factor,
        -diameter * 0.18,
        diameter * 0.18,
      );
      center.x -= along.y * shift;
      center.y += along.x * shift;
      diameter = MathUtils.lerp(diameter, edges.width / factor, 0.55);
    }
    const position = new Vector3(
      center.x - width / 2,
      height / 2 - center.y,
      0,
    );
    let fresh = capture - this.time > 260;
    if (!fresh && position.distanceTo(this.position) > 2.4 * this.diameter) {
      // A second nearby observation confirms a fast relocation or a different hand.
      if (!this.pending || this.pending.distanceTo(position) > diameter * 0.8) {
        this.pending = position;
        return;
      }
      fresh = true;
    }
    this.pending = null;
    const acrossPalm = point(17).sub(point(5));
    const upPalm = point(9).add(point(13)).multiplyScalar(0.5).sub(point(0));
    const normal = acrossPalm.cross(upPalm).normalize();
    if (normal.lengthSq() < 0.5) return;
    // The unmirrored camera's index-to-pinky cross product points toward
    // the back of a right hand. Reacquisition can happen palm-first.
    const hand = result.handedness?.[0]?.[0] ?? result.handednesses?.[0]?.[0];
    const sign =
      hand?.score >= 0.8 ? ({ Right: 1, Left: -1 }[hand.categoryName] ?? 0) : 0;
    this.backSign ??= sign || (normal.z < 0 ? -1 : 1);
    if (!sign || sign === this.backSign) {
      this.handCandidate = null;
    } else if (this.handCandidate?.sign !== sign || capture - this.time > 260) {
      this.handCandidate = { sign, since: capture };
    } else if (capture - this.handCandidate.since >= 200) {
      this.backSign = sign;
      this.handCandidate = null;
    }
    normal.multiplyScalar(this.backSign);
    // The image supplies finger direction. Depth and roll are less certain in a
    // single view, so keep a nearly face-on stone close to the visible midline.
    const faceOn = smoothstep(normal.z, 0.48, 0.88);
    const tilt = clamp(bone.normalize().z, -0.9, 0.9) * (1 - faceOn * 0.55);
    const xy = Math.sqrt(1 - tilt * tilt);
    const axis = new Vector3(along.x * xy, -along.y * xy, tilt);
    normal.x *= 1 - 0.83 * faceOn;
    normal.y *= 1 - 0.83 * faceOn;
    const across = normal.clone().cross(axis);
    if (across.lengthSq() < 0.01) return;
    across.normalize();
    const back = axis.clone().cross(across);
    const rotation = new Quaternion().setFromRotationMatrix(
      new Matrix4().makeBasis(across, back, axis),
    );
    if (fresh) {
      this.snap = true;
      this.position.copy(position);
      this.velocity.set(0, 0, 0);
      this.rotation.copy(rotation);
      this.diameter = diameter;
    } else {
      const dt = Math.max(0.001, (capture - this.time) / 1000);
      const gain = (hz) => 1 - Math.exp(-2 * Math.PI * dt * hz);
      const delta = position.clone().sub(this.position);
      const speed = delta.length() / (this.diameter * dt);
      const follow = gain(1.5 + 12 * smoothstep(speed, 0.35, 4));
      this.velocity.lerp(delta.multiplyScalar(follow / dt), gain(3));
      this.position.lerp(position, follow);
      const angle = this.rotation.angleTo(rotation) / dt;
      this.rotation.slerp(rotation, gain(1.25 + 5 * smoothstep(angle, 0.7, 4)));
      const zoom = Math.log(diameter / this.diameter);
      this.diameter *= Math.exp(
        zoom * gain(0.95 + 4 * smoothstep(Math.abs(zoom), 0.07, 0.35)),
      );
    }
    this.time = capture;
  }
  place(mount, now, bandDiameter, fit) {
    const age = Math.max(0, now - this.time);
    mount.visible = age < 240;
    if (!mount.visible) return;
    const speed = this.velocity.length() / this.diameter;
    const prediction = Math.min(
      age / 1000,
      0.055,
      0.24 / Math.max(speed, 0.001),
    );
    mount.position
      .copy(this.position)
      .addScaledVector(this.velocity, prediction * smoothstep(speed, 0.4, 1.6));
    // Interpolate between detector results at the display cadence.
    const blend = this.snap
      ? 1
      : 1 - Math.exp(-Math.max(0, now - this.drawnAt) / 24);
    this.drawnAt = now;
    this.snap = false;
    mount.quaternion.slerp(this.rotation, blend);
    const scale = (this.diameter * fit) / bandDiameter;
    mount.scale.setScalar(MathUtils.lerp(mount.scale.x, scale, blend));
  }
}
