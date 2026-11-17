import * as T from "three";
import { CenterFit } from "./center-fit.js";
import { BrandContrast } from "./brand.js";
import { CausticMap } from "./caustics.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { cutMaterial, setStoneOptics, Lens } from "./optics.js";

export class JewelryStudio {
  constructor(canvas, lib, rigs, poses, onFrame, onFocus) {
    this.lib = lib;
    this.rigs = rigs;
    this.poses = poses;
    this.onFrame = onFrame;
    this.onFocus = onFocus;
    this.state = {
      setting: "trilogy",
      cut: "emerald",
      carats: 1.5,
      center: "emerald",
      accent: "natural-diamond",
      metal: "yellow-gold",
      rig: "softbox",
      rotation: 0,
      exposure: 1,
      aperture: 0,
      spin: false,
      tool: "orbit",
    };
    this.canvas = canvas;
    this.renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        matchMedia("(pointer:coarse)").matches ? 2.5 : 2,
      ),
    );
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.brand = new BrandContrast(
      this.renderer,
      document.querySelector(".brand-mark"),
    );
    this.scene = new T.Scene();
    this.scene.background = new T.Color("#dfdfd5");
    this.camera = new T.PerspectiveCamera(29, 1, 0.3, 1400);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.11;
    this.controls.enablePan = false;
    this.controls.minDistance = 22;
    this.controls.maxDistance = 150;
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.autoRotateSpeed = 1.7;
    this.controls.rotateSpeed = 0.8;
    this.lens = new Lens(this.renderer, this.camera);
    this.assembly = new T.Group();
    this.scene.add(this.assembly);
    this.model = null;
    this.stones = [];
    this.accentOverrides = new Map();
    this.materials = [];
    this.assets = new Map();
    this.lightCache = new Map();
    this.gltf = new GLTFLoader();
    this.hdr = new HDRLoader();
    this.texLoader = new T.TextureLoader();
    const compactGPU =
      matchMedia("(pointer:coarse)").matches ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4);
    this.compactGPU = compactGPU;
    const probeSize = Math.min(
      compactGPU ? 512 : 1024,
      this.renderer.capabilities.maxCubemapSize,
      Math.floor(this.renderer.capabilities.maxTextureSize / 4),
    );
    this.probeTarget = new T.WebGLCubeRenderTarget(probeSize, {
      type: this.renderer.extensions.has("EXT_color_buffer_float")
        ? T.HalfFloatType
        : T.UnsignedByteType,
      generateMipmaps: true,
      minFilter: T.LinearMipmapLinearFilter,
    });
    // Each shoulder sees a different gallery and shank. Reuse its local view
    // across the small pav� stones on that shoulder.
    this.shoulderProbes = [0, 1].map(() => {
      const target = new T.WebGLCubeRenderTarget(probeSize / 2, {
        type: this.probeTarget.texture.type,
        generateMipmaps: true,
        minFilter: T.LinearMipmapLinearFilter,
      });
      const camera = new T.CubeCamera(0.06, 190, target);
      this.scene.add(camera);
      return { target, camera, stone: null };
    });
    this.metalTarget = new T.WebGLCubeRenderTarget(probeSize, {
      type: this.probeTarget.texture.type,
    });
    this.metalCamera = new T.CubeCamera(0.15, 190, this.metalTarget);
    this.scene.add(this.metalCamera);
    this.prefilter = new T.PMREMGenerator(this.renderer);
    this.metalReflection = null;
    this.probeCamera = new T.CubeCamera(0.12, 190, this.probeTarget);
    this.scene.add(this.probeCamera);
    this.bandMat = new T.MeshStandardMaterial({
      metalness: 1,
      roughness: 0.085,
    });
    this.scene.add(new T.HemisphereLight(0xffffff, 0xa19a8b, 0.6));
    this.key = new T.DirectionalLight(0xffffff, 1.45);
    this.key.castShadow = true;
    const sc = this.key.shadow.camera;
    Object.assign(sc, {
      left: -22,
      right: 22,
      top: 26,
      bottom: -22,
      near: 0.1,
      far: 160,
    });
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.radius = 10;
    this.key.shadow.blurSamples = 10;
    this.key.shadow.bias = -0.00028;
    this.key.shadow.normalBias = 0.022;
    this.scene.add(this.key, this.key.target);
    this.emptyFloor = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.emptyFloor.needsUpdate = true;
    this.causticMap = new CausticMap(this.renderer);
    this.floorUniforms = {
      mask: { value: this.emptyFloor },
      causticMap: { value: this.causticMap.target.texture },
      origin: { value: new T.Vector2() },
    };
    this.floorMat = new T.MeshStandardMaterial({
      color: "#ccc9c0",
      metalness: 0,
      roughness: 1,
      envMapIntensity: 0.33,
    });
    this.floorMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.floorUniforms);
      shader.vertexShader =
        "varying vec2 floorPosition;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n floorPosition=(modelMatrix*vec4(position,1.)).xz;",
        );
      shader.fragmentShader =
        "varying vec2 floorPosition;uniform sampler2D mask,causticMap;uniform vec2 origin;\n" +
        shader.fragmentShader
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
        vec2 floorUV=(floorPosition-origin)/58.+.5;
        vec3 m=texture2D(mask,clamp(floorUV,0.,1.)).rgb;
        float edge=smoothstep(0.,.03,min(min(floorUV.x,1.-floorUV.x),min(floorUV.y,1.-floorUV.y)));
        float broad=exp(-dot(floorPosition-vec2(-10.,-3.),floorPosition-vec2(-10.,-3.))*.00031);
        diffuseColor.rgb*=mix(.79,1.045,broad);
        vec3 causticLight=vec3(0.);
        if(edge>0.){
          vec3 light=exp2(8.*texture2D(causticMap,floorUV).rgb)-1.;
          causticLight=edge*diffuseColor.rgb*light;
          diffuseColor.rgb*=1.-.72*edge*m.r;
        }
      `,
          )
          .replace(
            "#include <opaque_fragment>",
            "outgoingLight+=causticLight;\n#include <opaque_fragment>",
          );
    };
    this.ground = new T.Mesh(new T.PlaneGeometry(2200, 2200), this.floorMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.ray = new T.Raycaster();
    this.ndc = new T.Vector2();
    this.focusPoint = new T.Vector3(0, 14, 0);
    this.focusRole = "center";
    this.revision = 0;
    this.rigRevision = 0;
    this.raf = 0;
    this.moving = false;
    this.frames = [];
    this.lastTime = 0;
    this.lastStats = 0;
    this.probeDirty = true;
    this.lastProbe = 0;
    this.controls.addEventListener("change", () => this.invalidate());
    this.controls.addEventListener("start", () => {
      this.moving = true;
      this.invalidate();
    });
    this.controls.addEventListener("end", () => {
      this.moving = false;
      this.invalidate();
    });
    this.connectPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.reset();
    this.resize();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.invalidate();
    });
  }
  resize() {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = T.MathUtils.radToDeg(
      2 *
        Math.atan(
          Math.tan(T.MathUtils.degToRad(14.5)) * Math.max(1, 0.9 / (w / h)),
        ),
    );
    const side = w >= 900 ? -Math.min(w * 0.065, 108) : 0;
    this.camera.setViewOffset(w, h, side, w < 700 ? h * 0.045 : 0, w, h);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }
  reset() {
    this.assembly.position.set(0, 0, 0);
    this.controls.target.set(0, 2.4, 1.5);
    this.camera.position.set(-25, 34, 44);
    this.controls.update();
    this.key.target.position.set(0, 0, 0);
    this.setAngle(this.state.rotation);
    this.floorUniforms.origin.value.set(0, 0);
    this.focusCenter();
    this.invalidate();
  }
  zoom(factor) {
    const delta = this.camera.position.clone().sub(this.controls.target);
    this.camera.position
      .copy(this.controls.target)
      .add(
        delta.setLength(T.MathUtils.clamp(delta.length() * factor, 22, 150)),
      );
    this.controls.update();
    this.invalidate();
  }
  async geometry(setting, cut) {
    const id = setting + "-" + cut;
    if (!this.assets.has(id)) {
      const work = Promise.all([
        this.gltf.loadAsync("/assets/rings/" + id + ".glb"),
        this.texLoader.loadAsync("/assets/floors/" + id + ".png"),
        this.texLoader.loadAsync("/assets/floors/" + id + "-transport.png"),
      ]).then(([gltf, floor, keyAtlas]) => {
        for (const tex of [floor, keyAtlas]) {
          tex.flipY = false;
          tex.colorSpace = T.NoColorSpace;
          tex.anisotropy = Math.min(
            4,
            this.renderer.capabilities.getMaxAnisotropy(),
          );
        }
        keyAtlas.generateMipmaps = false;
        keyAtlas.minFilter = T.LinearFilter;
        keyAtlas.anisotropy = 1;
        const materials = new Set();
        gltf.scene.traverse((mesh) => {
          if (mesh.isMesh) materials.add(mesh.material);
        });
        materials.forEach((material) => material.dispose());
        return { scene: gltf.scene, floor, keyAtlas };
      });
      this.assets.set(id, work);
      work.catch(() => {
        if (this.assets.get(id) === work) this.assets.delete(id);
      });
    }
    return this.assets.get(id);
  }
  async setDesign(setting, cut) {
    const stamp = ++this.revision;
    const asset = await this.geometry(setting, cut);
    if (stamp !== this.revision) return false;
    if (this.state.setting !== setting) this.accentOverrides.clear();
    Object.assign(this.state, { setting, cut });
    if (this.model) this.assembly.remove(this.model);
    this.materials.forEach((m) => m.dispose());
    this.materials = [];
    this.model = asset.scene;
    this.focusPick = null;
    this.stones = [];
    const id = setting + "-" + cut;
    const recent = this.assets.get(id);
    this.assets.delete(id);
    this.assets.set(id, recent);
    // Retain two fitted designs to bound GPU texture memory while browsing.
    while (this.assets.size > 2) {
      const [oldId, pending] = this.assets.entries().next().value;
      this.assets.delete(oldId);
      pending.then(
        (old) => {
          old.floor.dispose();
          old.keyAtlas.dispose();
          const meshes = new Set();
          old.scene.traverse((node) => {
            if (node.isMesh) meshes.add(node.geometry);
          });
          meshes.forEach((geometry) => geometry.dispose());
        },
        () => {},
      );
    }
    const pose = this.poses[id];
    this.model.quaternion.fromArray(pose.rotation);
    this.model.position.fromArray(pose.translation);
    this.assembly.add(this.model);
    this.assembly.updateMatrixWorld(true);
    this.model.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const role = mesh.userData.role;
      mesh.frustumCulled = true;
      if (role === "head" || role === "band") {
        mesh.material = this.bandMat;
        mesh.castShadow = true;
      } else this.stones.push(mesh);
    });
    asset.fit ??= new CenterFit(this.model, this.stones);
    this.fit = asset.fit;
    // A cached model may have been returned to its native pose above.
    this.fit.scale = undefined;
    for (let side = 0; side < 2; side++) {
      const accents = this.stones.filter(
        (m) =>
          m.userData.role !== "center" && (m.position.x > 0 ? 1 : 0) === side,
      );
      const sideStone = accents.find((m) => m.userData.role === "side");
      this.shoulderProbes[side].stone =
        sideStone ?? accents[Math.floor(accents.length / 2)] ?? null;
    }
    // Each fitted pose touches the bake plane at Y = 0 mm.
    this.ground.position.y = -0.015;
    this.floorUniforms.mask.value = asset.floor;
    this.causticMap.uniforms.atlas.value = asset.keyAtlas;
    this.causticMap.uniforms.roles.value = this.stones.length > 1 ? 2 : 1;
    this.setGems(this.state.center, this.state.accent);
    this.focusCenter();
    this.setMetal(this.state.metal);
    this.invalidate(true);
    return true;
  }
  setCarats(value) {
    this.state.carats = T.MathUtils.clamp(value, 0.5, 3);
    this.fitCenter(this.lib.gems.find((g) => g.id === this.state.center));
    this.invalidate(true);
  }
  fitCenter(gem) {
    if (!this.fit) return;
    const stone = this.fit.center;
    const diamond = this.lib.gems.find((g) => g.id === "natural-diamond");
    const scale = Math.cbrt(
      (this.state.carats * diamond.density) /
        (stone.userData.diamondCarats * gem.density),
    );
    const baseAnchor = this.fit.origins[this.stones.indexOf(stone)]
      .clone()
      .applyQuaternion(this.fit.nativePose.rotation)
      .add(this.fit.nativePose.position);
    this.fit.apply(scale);
    this.model.updateWorldMatrix(true, true);
    const anchor = stone
      .getWorldPosition(new T.Vector3())
      .sub(this.assembly.position);
    const u = this.causticMap.uniforms;
    u.centerScale.value = scale;
    u.nativeAnchor.value.set(0.5 + baseAnchor.x / 58, 0.5 + baseAnchor.z / 58);
    u.centerAnchor.value.set(0.5 + anchor.x / 58, 0.5 + anchor.z / 58);
    this.causticMap.dirty = true;
    if (stone.material?.uniforms?.mmPerUnit)
      stone.material.uniforms.mmPerUnit.value = stone.scale.x;
    if (this.focusPick) {
      const { object, face, barycoord } = this.focusPick;
      const pos = object.geometry.attributes.position;
      const vertex = new T.Vector3();
      this.focusPoint
        .fromBufferAttribute(pos, face.a)
        .multiplyScalar(barycoord.x)
        .addScaledVector(vertex.fromBufferAttribute(pos, face.b), barycoord.y)
        .addScaledVector(vertex.fromBufferAttribute(pos, face.c), barycoord.z);
      object.localToWorld(this.focusPoint);
    } else this.focusCenter();
  }
  setMetal(id) {
    const metal = this.lib.metals.find((m) => m.id === id);
    if (!metal) return;
    this.state.metal = id;
    this.bandMat.color.fromArray(metal.reflectance);
    this.invalidate(true);
  }
  setGems(center, accent) {
    this.state.center = center;
    this.state.accent = accent;
    const colors = [center, accent].map((id) =>
      this.lib.gems.find((g) => g.id === id),
    );
    const accentMix = [];
    this.fitCenter(colors[0]);
    const shared = new Map();
    for (const mesh of this.stones) {
      const isCenter = mesh.userData.role === "center",
        gem =
          this.accentOverrides.get(mesh.name) && !isCenter
            ? this.lib.gems.find(
                (g) => g.id === this.accentOverrides.get(mesh.name),
              )
            : colors[isCenter ? 0 : 1];
      if (!isCenter && this.accentOverrides.size)
        accentMix.push({ gem, area: mesh.scale.x ** 2 });
      const side = mesh.position.x > 0 ? 1 : 0;
      const key = mesh.geometry.uuid + (isCenter ? "center" : side) + gem.id;
      let material = shared.get(key);
      if (!material) {
        material = this.materials.find((m) => m.userData.key === key);
        if (!material) {
          material = cutMaterial(
            mesh,
            isCenter,
            isCenter
              ? this.probeTarget.texture
              : this.shoulderProbes[side].target.texture,
          );
          material.userData.key = key;
          this.materials.push(material);
        }
        material.uniforms.mmPerUnit.value = mesh.userData.mmPerUnit;
        setStoneOptics(material, gem);
        shared.set(key, material);
      }
      mesh.material = material;
      mesh.onBeforeRender = (_r, _s, camera) => {
        camera.getWorldPosition(material.uniforms.localEye.value);
        mesh.worldToLocal(material.uniforms.localEye.value);
        material.uniforms.worldAxes.value.setFromMatrix4(mesh.matrixWorld);
        material.uniformsNeedUpdate = true;
      };
    }
    this.causticMap.setGems(colors, accentMix);
    this.materials = this.materials.filter((m) => {
      if (shared.has(m.userData.key)) return true;
      m.dispose();
      return false;
    });
    this.invalidate(true);
  }
  async setLight(id) {
    const ticket = ++this.rigRevision,
      rig = this.rigs.find((l) => l.id === id);
    if (!this.lightCache.has(id)) {
      const load = this.hdr
        .loadAsync(
          this.compactGPU
            ? (rig.compactEnvironment ?? rig.environment)
            : rig.environment,
        )
        .then((t) => {
          t.mapping = T.EquirectangularReflectionMapping;
          return t;
        });
      this.lightCache.set(id, load);
      load.catch(() => {
        if (this.lightCache.get(id) === load) this.lightCache.delete(id);
      });
    }
    const env = await this.lightCache.get(id);
    if (ticket !== this.rigRevision) return false;
    const retained = this.lightCache.get(id);
    this.lightCache.delete(id);
    this.lightCache.set(id, retained);
    while (this.lightCache.size > 2) {
      const [oldId, pending] = this.lightCache.entries().next().value;
      this.lightCache.delete(oldId);
      pending.then(
        (texture) => texture.dispose(),
        () => {},
      );
    }
    this.state.rig = id;
    this.activeRig = rig;
    this.env = env;
    this.scene.environment = env;
    this.scene.background = new T.Color(rig.backgroundColor);
    this.scene.fog = new T.Fog(rig.backgroundColor, 93, 230);
    this.floorMat.color.set(rig.stageColor);
    this.key.color.set(id === "gallery" ? "#ffe2af" : "#fffaf2");
    this.key.intensity = id === "darkfield" ? 0.35 : 1.1;
    this.causticMap.uniforms.gain.value =
      id === "darkfield"
        ? 5
        : id === "spotlights"
          ? 13
          : id === "gallery"
            ? 8
            : 7;
    this.causticMap.uniforms.sourceTint.value.copy(this.key.color);
    this.setAngle(this.state.rotation);
    this.setExposure(this.state.exposure);
    return true;
  }
  setExposure(v) {
    this.brand.due = 0;
    this.state.exposure = v;
    this.renderer.toneMappingExposure = v * (this.activeRig?.exposure ?? 1);
    this.invalidate();
  }
  setAngle(deg) {
    this.state.rotation = deg;
    const a = (deg * Math.PI) / 180 + (this.activeRig?.rotationY ?? 0);
    this.scene.environmentRotation.y = a;
    this.causticMap.dirty = true;
    this.causticMap.uniforms.sector.value = T.MathUtils.euclideanModulo(
      (a - 0.8) / (Math.PI / 4),
      8,
    );
    this.key.position
      .set(Math.cos(a - 0.8) * 56, 32, Math.sin(a - 0.8) * 56)
      .add(this.assembly.position);
    this.key.target.position.copy(this.assembly.position);
    this.invalidate(true);
  }
  focusCenter() {
    this.focusPick = null;
    const m = this.stones.find((s) => s.userData.role === "center");
    if (m) {
      const table = m.userData.planes.find((p) => p[1] > 0.9999);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      this.focusPoint.set(0, table?.[3] ?? m.geometry.boundingBox.max.y, 0);
      m.localToWorld(this.focusPoint);
    }
    this.focusRole = "center";
    this.onFocus("Center stone");
    this.invalidate();
  }
  setTool(tool) {
    this.state.tool = tool;
    this.controls.enabled = tool === "orbit";
    this.canvas.dataset.tool = tool;
    this.invalidate();
  }
  connectPointer() {
    const canvas = this.canvas,
      plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    let drag = null;
    const ray = (e) => {
      const r = canvas.getBoundingClientRect();
      this.ndc.set(
        (2 * (e.clientX - r.left)) / r.width - 1,
        1 - (2 * (e.clientY - r.top)) / r.height,
      );
      this.ray.setFromCamera(this.ndc, this.camera);
    };
    const hit = (e) => {
      ray(e);
      return this.model ? this.ray.intersectObject(this.model, true)[0] : null;
    };
    // A selection is committed on release, after ruling out orbit and pinch.
    const pointers = new Set();
    let tap;
    canvas.addEventListener("pointerdown", (e) => {
      pointers.add(e.pointerId);
      tap =
        pointers.size === 1 && e.button === 0 && this.state.tool === "orbit"
          ? [e.clientX, e.clientY]
          : null;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (tap && Math.hypot(e.clientX - tap[0], e.clientY - tap[1]) > 7)
        tap = null;
    });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (
        tap &&
        !pointers.size &&
        this.state.tool === "orbit" &&
        !this.tryingOn &&
        Math.hypot(e.clientX - tap[0], e.clientY - tap[1]) <= 7
      ) {
        let part = hit(e);
        if (!part && e.pointerType === "touch") {
          for (const [x, y] of [
            [0, -4],
            [-4, 0],
            [4, 0],
            [0, 4],
          ]) {
            part = hit({ clientX: e.clientX + x, clientY: e.clientY + y });
            if (part) break;
          }
        }
        if (part) this.onPart?.(part);
      }
      tap = null;
    });
    for (const event of ["pointercancel", "lostpointercapture"])
      canvas.addEventListener(event, (e) => {
        pointers.delete(e.pointerId);
        if (!pointers.size) tap = null;
      });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.state.tool === "orbit") return;
      const found = hit(e);
      if (this.state.tool === "focus") {
        if (found) {
          this.focusPick = found;
          this.focusPoint.copy(found.point);
          this.focusRole = "picked";
          this.onFocus("Picked surface");
          this.invalidate();
        }
        return;
      }
      plane.constant = -this.ground.position.y;
      const point = new T.Vector3();
      if (this.ray.ray.intersectPlane(plane, point)) {
        drag = {
          id: e.pointerId,
          origin: this.assembly.position.clone(),
          point,
        };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (drag?.id !== e.pointerId) return;
      ray(e);
      const now = this.ray.ray.intersectPlane(plane, new T.Vector3());
      if (!now) return;
      const next = drag.origin.clone().add(now.sub(drag.point));
      next.x = T.MathUtils.clamp(next.x, -18, 18);
      next.z = T.MathUtils.clamp(next.z, -18, 18);
      next.y = 0;
      const delta = next.clone().sub(this.assembly.position);
      this.focusPoint.add(delta);
      this.assembly.position.copy(next);
      this.floorUniforms.origin.value.set(next.x, next.z);
      this.key.position.add(delta);
      this.key.target.position.copy(next);
      this.renderer.shadowMap.needsUpdate = true;
      this.invalidate();
    });
    const up = () => {
      drag = null;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.state.tool !== "orbit") {
          e.preventDefault();
          this.zoom(Math.exp(Math.sign(e.deltaY) * 0.09));
        }
      },
      { passive: false },
    );
  }
  updateProbe() {
    if (!this.env || !this.model) return;
    const center = this.stones.find((s) => s.userData.role === "center");
    center.getWorldPosition(this.probeCamera.position);
    const bg = this.scene.background,
      fog = this.scene.fog;
    this.scene.background = this.env;
    this.scene.backgroundRotation.copy(this.scene.environmentRotation);
    this.scene.fog = null;
    this.bandMat.envMap = null;
    this.bandMat.needsUpdate = true;
    for (const m of this.stones) m.visible = false;
    this.probeCamera.update(this.renderer, this.scene);
    for (const shoulder of this.shoulderProbes) {
      if (!shoulder.stone) continue;
      shoulder.stone.getWorldPosition(shoulder.camera.position);
      shoulder.camera.update(this.renderer, this.scene);
    }
    for (const m of this.stones) m.visible = true;
    // A second, filtered local probe captures the opposite shoulder and gallery
    // in polished metal. Both probes are reused during camera orbit and zoom.
    this.metalCamera.position
      .copy(this.assembly.position)
      .add(new T.Vector3(0, 4, 0));
    this.ground.visible = false;
    this.metalCamera.update(this.renderer, this.scene);
    this.ground.visible = true;
    this.metalReflection = this.prefilter.fromCubemap(
      this.metalTarget.texture,
      this.metalReflection,
    );
    this.bandMat.envMap = this.metalReflection.texture;
    this.bandMat.needsUpdate = true;
    this.scene.background = bg;
    this.scene.fog = fog;
  }
  invalidate(probe = false) {
    if (probe) {
      this.probeDirty = true;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.lens.resetHistory();
    this.scheduleFrame();
  }
  scheduleFrame() {
    if (!this.raf && !document.hidden)
      this.raf = requestAnimationFrame((t) => this.frame(t));
  }
  frame(now) {
    this.raf = 0;
    if (this.tryingOn) return;
    const dt = now - this.lastTime;
    this.lastTime = now;
    this.controls.autoRotate = this.state.spin;
    this.causticMap.update();
    const changed = this.controls.update(Math.min(dt / 1000, 0.06));
    if (
      this.probeDirty &&
      this.model &&
      this.env &&
      now - this.lastProbe > 65
    ) {
      this.updateProbe();
      this.lens.resetHistory();
      this.probeDirty = false;
      this.lastProbe = now;
    }
    this.camera.updateMatrixWorld();
    const focus = -this.focusPoint
      .clone()
      .applyMatrix4(this.camera.matrixWorldInverse).z;
    if (this.selectedPart) {
      const { object, anchor, mark } = this.selectedPart;
      const screen = object.localToWorld(anchor.clone()).project(this.camera);
      const rect = this.canvas.getBoundingClientRect();
      mark.style.left = rect.left + (0.5 + screen.x * 0.5) * rect.width + "px";
      mark.style.top = rect.top + (0.5 - screen.y * 0.5) * rect.height + "px";
    }
    const refining = this.lens.draw(
      this.scene,
      focus,
      this.state.aperture,
      changed || this.state.spin || this.moving,
    );
    const samplingBrand = this.brand.update(now, this.state.rig);
    if (dt > 0 && dt < 150) this.frames.push(dt);
    else this.frames = [];
    if (this.frames.length > 90) this.frames.shift();
    if (now - this.lastStats > 350 && this.frames.length > 5) {
      this.onFrame(
        (1000 * this.frames.length) / this.frames.reduce((a, b) => a + b, 0),
      );
      this.lastStats = now;
    }
    if (
      samplingBrand ||
      refining ||
      changed ||
      this.state.spin ||
      this.moving ||
      (this.probeDirty && this.env && this.model)
    )
      this.scheduleFrame();
  }
}
