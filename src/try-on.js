import * as T from "three";
import { HandTracker } from "./hand-tracker.js";

const el = (id) => document.getElementById(id);
const handPrompt = "Show the back of your hand and spread your fingers.";
function cameraMessage(error) {
  if (["NotAllowedError", "SecurityError"].includes(error.name))
    return "Camera access is off. Allow camera access for this site, then try again.";
  if (error.name === "NotFoundError")
    return "No camera was found on this device.";
  if (error.name === "NotReadableError")
    return "The camera is busy. Close the other camera app and try again.";
  return "Couldn’t start the camera or hand tracker. Try again.";
}

export class TryOn {
  constructor(studio, onClose) {
    this.studio = studio;
    this.onClose = onClose;
    this.tracker = new HandTracker();
    this.video = document.createElement("video");
    this.video.autoplay = this.video.muted = this.video.playsInline = true;
    this.input = document.createElement("canvas");
    this.ctx = this.input.getContext("2d", { alpha: false });
    this.crop = new T.Vector4();
    this.targetPosition = new T.Vector3();
    this.targetRotation = new T.Quaternion();
    this.targetScale = 1;
    this.detectedAt = -Infinity;
    this.lastFrame = -1;
    this.lastTime = 0;
    this.frame = this.frame.bind(this);
    this.hide = () => {
      if (document.hidden) this.close();
    };
    this.exit = () => this.close();
  }
  status(text) {
    if (el("try-status").textContent !== text)
      el("try-status").textContent = text;
  }
  async start() {
    el("try-panel").hidden = false;
    document.body.classList.add("trying-on");
    el("try-panel").append(this.video);
    el("try-close").focus({ preventScroll: true });
    el("try-retry").hidden = el("try-fit").hidden = true;
    this.status(
      "Allow camera access to try on your ring. Video stays on this device.",
    );
    document.addEventListener("visibilitychange", this.hide);
    window.addEventListener("pagehide", this.exit);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.fail(
          "Camera access requires HTTPS and a browser with camera support.",
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () =>
        this.fail("The camera disconnected. Reconnect it and try again.");
      this.video.srcObject = stream;
      await this.video.play();
      if (this.closed || this.failed) return;
      this.makeScene();
      this.status("Loading hand tracking on this device…");
      this.raf = requestAnimationFrame(this.frame);
      await this.tracker.open();
      if (this.closed || this.failed) return;
      this.ready = true;
      this.status(handPrompt);
      el("try-fit").hidden = false;
    } catch (e) {
      if (!this.closed && !this.failed) {
        console.warn("Try-on startup", e.name, e.message);
        this.fail(cameraMessage(e));
      }
    }
  }
  makeScene() {
    const s = this.studio;
    if (s.probeDirty && s.model && s.env) s.updateProbe();
    s.tryingOn = true;
    s.controls.enabled = false;
    this.scene = new T.Scene();
    this.videoMap = new T.VideoTexture(this.video);
    this.videoMap.colorSpace = T.SRGBColorSpace;
    this.scene.background = this.videoMap;
    this.scene.environment = s.env;
    this.scene.environmentRotation.copy(s.scene.environmentRotation);
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.camera.position.z = 2000;
    this.mount = new T.Group();
    const ring = s.model.clone(true);
    ring.position.set(0, 0, 0);
    ring.quaternion.identity();
    ring.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.material.uniforms?.localEye) return;
      mesh.onBeforeRender = (_r, _s, c) => {
        const u = mesh.material.uniforms;
        c.getWorldPosition(u.localEye.value);
        mesh.worldToLocal(u.localEye.value);
        u.worldAxes.value.setFromMatrix4(mesh.matrixWorld);
        mesh.material.uniformsNeedUpdate = true;
      };
    });
    this.mount.add(ring);
    // Native ring coordinates are millimetres, with the finger along +Z.
    const diameter = s.model.userData.bandDiameter || 16.5068;
    this.bandDiameter = diameter;
    this.mask = new T.Mesh(
      new T.CylinderGeometry(
        diameter * 0.492,
        diameter * 0.49,
        diameter * 1.85,
        40,
      ),
      new T.MeshBasicMaterial({ colorWrite: false, depthWrite: true }),
    );
    this.mask.rotation.x = Math.PI / 2;
    this.mask.renderOrder = -10;
    this.mount.add(this.mask);
    this.mount.visible = false;
    this.scene.add(this.mount);
    this.scene.add(new T.HemisphereLight(0xffffff, 0xb1a69d, 0.65));
    const key = new T.DirectionalLight(0xfff9ee, 1.4);
    key.position.set(-1, 2, 3);
    this.scene.add(key);
  }
  fitViewport() {
    const canvas = this.studio.canvas,
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    const sw = this.video.videoWidth,
      sh = this.video.videoHeight;
    if (!sw || !sh || !w || !h) return false;
    if (
      w === this.width &&
      h === this.height &&
      sw === this.sw &&
      sh === this.sh
    )
      return true;
    Object.assign(this, { width: w, height: h, sw, sh });
    const cover = Math.max(w / sw, h / sh),
      cw = w / cover,
      ch = h / cover;
    this.crop.set((sw - cw) / 2, (sh - ch) / 2, cw, ch);
    this.videoMap.repeat.set(cw / sw, ch / sh);
    this.videoMap.offset.set((1 - cw / sw) / 2, (1 - ch / sh) / 2);
    const ratio = 640 / Math.max(w, h);
    this.input.width = Math.max(1, Math.round(w * ratio));
    this.input.height = Math.max(1, Math.round(h * ratio));
    Object.assign(this.camera, {
      left: -w / 2,
      right: w / 2,
      top: h / 2,
      bottom: -h / 2,
    });
    this.camera.updateProjectionMatrix();
    this.detectedAt = -Infinity;
    this.layoutVersion = (this.layoutVersion ?? 0) + 1;
    return true;
  }
  pose(result, time) {
    const image = result?.landmarks?.[0],
      world = result?.worldLandmarks?.[0];
    if (!image || !world) return;
    const point = (i) => new T.Vector3(world[i].x, -world[i].y, -world[i].z);
    const pixel = (i) =>
      new T.Vector2(
        (image[i].x - 0.5) * this.width,
        (0.5 - image[i].y) * this.height,
      );
    const axis = point(14).sub(point(13)).normalize();
    const back = point(17).sub(point(5)).cross(axis);
    if (back.lengthSq() < 0.000001) return;
    back.normalize();
    const label = result.handedness?.[0]?.[0]?.categoryName;
    const fresh = time - this.detectedAt > 350 || label !== this.hand;
    if (fresh) this.backSign = back.z < 0 ? -1 : 1;
    this.hand = label;
    back.multiplyScalar(this.backSign);
    const across = new T.Vector3().crossVectors(back, axis);
    this.targetRotation.setFromRotationMatrix(
      new T.Matrix4().makeBasis(across, back, axis),
    );
    const anchor = pixel(13).lerp(pixel(14), 0.3);
    this.targetPosition.set(anchor.x, anchor.y, 0);
    // Estimate local pixels per metre from the projected palm and proximal bones.
    let pixels = 0,
      metres = 0;
    for (const [a, b] of [
      [5, 17],
      [0, 9],
      [13, 14],
    ]) {
      pixels += pixel(a).distanceTo(pixel(b));
      const delta = point(a).sub(point(b));
      metres += Math.hypot(delta.x, delta.y);
    }
    const spacing =
      (point(13).distanceTo(point(9)) + point(13).distanceTo(point(17))) / 2;
    this.targetScale = T.MathUtils.clamp(
      (0.84 * spacing * pixels) / (Math.max(0.001, metres) * this.bandDiameter),
      0.12,
      Math.max(this.width, this.height) / 45,
    );
    this.detectedAt = time;
    if (fresh) {
      this.mount.position.copy(this.targetPosition);
      this.mount.quaternion.copy(this.targetRotation);
      this.mount.scale.setScalar(
        (this.targetScale * Number(el("try-size").value)) / 100,
      );
    }
  }
  frame(now) {
    if (this.closed || this.failed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.fitViewport()) return;
    const interval = this.tracker.worker ? 50 : 85;
    if (
      this.ready &&
      !this.busy &&
      now - (this.detectTime ?? -Infinity) >= interval &&
      this.video.currentTime !== this.lastFrame
    ) {
      this.busy = true;
      this.detectTime = now;
      this.lastFrame = this.video.currentTime;
      const version = this.layoutVersion,
        c = this.crop;
      this.ctx.drawImage(
        this.video,
        c.x,
        c.y,
        c.z,
        c.w,
        0,
        0,
        this.input.width,
        this.input.height,
      );
      this.tracker
        .detect(this.input, now)
        .then((result) => {
          if (!this.closed && !this.failed && version === this.layoutVersion)
            this.pose(result, performance.now());
        })
        .catch(() => {
          if (!this.closed && !this.failed)
            this.fail("Hand tracking stopped. Try again.");
        })
        .finally(() => {
          this.busy = false;
        });
    }
    const t = 1 - Math.exp(-Math.min(100, now - this.lastTime) / 45);
    this.lastTime = now;
    this.mount.visible = now - this.detectedAt < 280;
    if (this.mount.visible) {
      this.mount.position.lerp(this.targetPosition, t);
      this.mount.quaternion.slerp(this.targetRotation, t);
      const fitted = (this.targetScale * Number(el("try-size").value)) / 100;
      this.mount.scale.setScalar(
        T.MathUtils.lerp(this.mount.scale.x, fitted, t),
      );
      this.status("Tracking your ring finger");
    } else if (this.ready) this.status(handPrompt);
    this.studio.renderer.setRenderTarget(null);
    this.studio.renderer.render(this.scene, this.camera);
  }
  release() {
    cancelAnimationFrame(this.raf);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
    this.video.remove();
    this.tracker.close();
    this.videoMap?.dispose();
    this.mask?.geometry.dispose();
    this.mask?.material.dispose();
    this.studio.tryingOn = false;
    this.studio.controls.enabled = this.studio.state.tool === "orbit";
    this.studio.invalidate();
  }
  fail(message) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.release();
    this.status(message);
    el("try-retry").hidden = false;
    el("try-fit").hidden = true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.failed) this.release();
    document.removeEventListener("visibilitychange", this.hide);
    window.removeEventListener("pagehide", this.exit);
    document.body.classList.remove("trying-on");
    el("try-panel").hidden = true;
    this.onClose();
  }
}
