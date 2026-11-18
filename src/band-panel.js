import * as T from "three";
import {
  bandChoices,
  bandRanges,
  bandDefaults,
  bandSurface,
} from "./band-shape.js";
const $ = (id) => document.getElementById(id);
const mm = (n) => n.toFixed(1) + " mm";
const names = {
  knife: "Knife-edge",
  beaded: "Beaded",
  bevel: "Beveled",
  straight: "Straight",
};
const label = (k) => names[k] || k[0].toUpperCase() + k.slice(1);
function sectionDrawing(canvas, o, icon = false) {
  const ctx = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const surface = bandSurface(
    "solitaire",
    { ...o, shoulders: "straight" },
    8.25,
  );
  const scale = icon
    ? Math.min((w - 8) / o.width, (h - 7) / o.thickness)
    : Math.min(32, (w - 10) / o.width, (h - 10) / o.thickness);
  ctx.fillStyle = icon ? "#ad986b" : "#c3b08a";
  ctx.strokeStyle = "#6d604b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const side of [1, -1])
    for (let i = 0; i <= 64; i++) {
      const t = (Math.PI * (side === 1 ? i : 64 - i)) / 64,
        p = surface.section(Math.PI, 0, side, t);
      const x = w / 2 + p[2] * scale,
        y = h / 2 - (Math.hypot(p[0], p[1]) - 8.25 - o.thickness / 2) * scale;
      if (side === 1 && i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

export class BandPanel {
  constructor(studio, openPanel, paint) {
    this.s = studio;
    this.tab = "shape";
    this.token = 0;
    this.paintStudio = paint;
    this.handles = Array.from($("band-handles").querySelectorAll("button"));
    for (const [key, choices] of Object.entries(bandChoices)) {
      const host =
        key === "shape"
          ? document.querySelector(".band-shapes")
          : document.querySelector('[data-options="' + key + '"]');
      for (const choice of choices) {
        const b = document.createElement("button");
        b.dataset.bandKey = key;
        b.dataset.value = choice;
        if (key === "shape") {
          const c = document.createElement("canvas");
          c.width = 84;
          c.height = 40;
          sectionDrawing(
            c,
            {
              shape: choice,
              width: 3,
              thickness: 1.9,
              front: 3,
              edge: "plain",
            },
            true,
          );
          b.append(c);
        }
        b.append(label(choice));
        host.append(b);
        b.onclick = () => {
          const o = { ...this.values, [key]: choice };
          if (key === "shoulders")
            o.front = +T.MathUtils.clamp(
              o.width *
                { straight: 1, flare: 1.65, taper: 0.7, split: 1.8 }[choice],
              ...bandRanges.front,
            ).toFixed(1);
          if (choice === "split") o.front = Math.max(3.4, o.front);
          this.edit(o);
        };
      }
    }
    for (const key of Object.keys(bandRanges)) {
      const el = $("band-" + key);
      el.oninput = () => this.edit({ ...this.values, [key]: Number(el.value) });
    }
    for (const el of document.querySelectorAll("[data-band-tab]"))
      el.onclick = () => this.showTab(el.dataset.bandTab);
    $("band-reset").onclick = () => this.edit(null);
    $("band-metal").onclick = () => openPanel("setting-picker");
    $("band-open").onclick = () => {
      this.tab = "shape";
      openPanel("band-panel");
    };
    const startDrag = () => {
      studio.editingBand = true;
    };
    const endDrag = () => {
      if (studio.editingBand) {
        studio.editingBand = false;
        studio.invalidate(true);
      }
    };
    for (const control of [
      ...this.handles,
      ...document.querySelectorAll("#band-panel input[type=range]"),
    ])
      control.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
    studio.onBandFrame = () => this.place();
    for (const el of this.handles) this.bindHandle(el);
  }
  get values() {
    return this.pending ?? this.s.band.options ?? this.defaults;
  }
  open(hit) {
    if (!this.s.fit) return;
    $("design").classList.remove("mobile-open");
    this.defaults = bandDefaults(this.s);
    this.pending = null;
    if (hit) this.tab = "details";
    this.showTab(this.tab);
    this.s.resize();
    if (hit) {
      const p = this.s.model.worldToLocal(hit.point.clone());
      const edge =
        hit.object.name === "band-beads" ||
        Math.abs(p.z) > 0.35 * this.values.width;
      const group = document.querySelector(
        '[data-options="' + (edge ? "edge" : "finish") + '"]',
      );
      group
        .querySelector('[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
    }
  }
  close() {
    $("band-handles").hidden = true;
    if (this.s.fit) this.s.resize();
  }
  showTab(tab) {
    this.tab = tab;
    document
      .querySelectorAll("[data-band-page]")
      .forEach((e) => (e.hidden = e.dataset.bandPage !== tab));
    document
      .querySelectorAll("[data-band-tab]")
      .forEach((e) =>
        e.setAttribute("aria-pressed", String(e.dataset.bandTab === tab)),
      );
    this.sync();
    this.s.scheduleFrame();
  }
  sync() {
    const o = this.values;
    if (!o) return;
    for (const b of document.querySelectorAll("[data-band-key]"))
      b.setAttribute(
        "aria-pressed",
        String(o[b.dataset.bandKey] === b.dataset.value),
      );
    for (const k of Object.keys(bandRanges)) {
      const el = $("band-" + k),
        n = k === "pave" ? Math.min(o.pave, this.s.band.row().max) : o[k];
      if (k === "pave") el.max = this.s.band.row().max;
      if (k === "front")
        el.min = o.shoulders === "split" ? 3.4 : bandRanges.front[0];
      el.value = n;
      const text = k === "pave" ? String(n) : mm(n);
      $("band-" + k + "-out").value = text;
      el.setAttribute("aria-valuetext", text);
    }
    $("band-reset").disabled = !(this.s.band.options || this.pending);
    sectionDrawing($("band-section"), o);
    this.place();
  }
  edit(options) {
    const token = ++this.token;
    this.pending = options;
    this.sync();
    cancelAnimationFrame(this.queued);
    this.queued = requestAnimationFrame(async () => {
      if (!this.s.band.head && options)
        $("band-status").textContent = "Loading setting…";
      try {
        const applied = await this.s.band.edit(options);
        if (token !== this.token || !applied) return;
        this.pending = null;
        $("band-status").textContent = "";
        this.defaults = bandDefaults(this.s);
        this.sync();
        this.paintStudio();
        this.s.invalidate(true);
      } catch (e) {
        if (token !== this.token) return;
        this.pending = null;
        this.sync();
        $("band-status").textContent =
          "Couldn’t load this setting. Try the edit again.";
        console.error(e);
      }
    });
  }
  project(a) {
    const s = this.s,
      o = this.values;
    const coords =
      s.band.surface && s.band.options
        ? s.band.stonePoint(a, 1, 0.72)
        : [Math.sin(a) * 9.5, Math.cos(a) * 9.5, o.front * 0.34];
    const v = s.model.localToWorld(new T.Vector3(...coords)).project(s.camera);
    const r = s.canvas.getBoundingClientRect();
    return [
      r.left + ((v.x + 1) * r.width) / 2,
      r.top + ((1 - v.y) * r.height) / 2,
      v.z,
    ];
  }
  place() {
    if ($("band-panel").hidden || !this.s.model || !this.values) return;
    $("band-handles").hidden = this.tab === "shape";
    for (const e of this.handles) {
      const k = e.dataset.handle;
      e.hidden =
        k === "pave" ? this.tab !== "details" : this.tab !== "shoulders";
      if (e.hidden) continue;
      const row = this.s.band.row(),
        a =
          k === "width"
            ? Math.PI
            : k === "front"
              ? 0.93
              : row.start +
                (Math.min(row.max, this.values.pave) - 1) * row.pitch;
      const left = this.project(-a),
        right = this.project(a),
        p = left[2] < right[2] ? left : right;
      e.dataset.sign = left[2] < right[2] ? "-1" : "1";
      e.style.left = T.MathUtils.clamp(p[0], 36, window.innerWidth - 36) + "px";
      e.style.top = T.MathUtils.clamp(p[1], 22, window.innerHeight - 22) + "px";
    }
  }
  bindHandle(el) {
    const key = el.dataset.handle;
    let drag;
    el.onpointerdown = (e) => {
      if (drag || e.button !== 0) return;
      e.preventDefault();
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        value: this.values[key],
        sign: Number(el.dataset.sign),
      };
      el.setPointerCapture(e.pointerId);
    };
    el.onpointermove = (e) => {
      if (drag?.id !== e.pointerId) return;
      let value;
      if (key === "pave") {
        const { start, pitch, max } = this.s.band.row();
        let nearest = Infinity;
        for (let i = 0; i <= max; i++) {
          const p = this.project(drag.sign * (start + (i - 1) * pitch));
          const d = Math.hypot(p[0] - e.clientX, p[1] - e.clientY);
          if (d < nearest) {
            nearest = d;
            value = i;
          }
        }
      } else
        value = +T.MathUtils.clamp(
          drag.value + (e.clientX - drag.x) * 0.025,
          key === "front" && this.values.shoulders === "split"
            ? 3.4
            : bandRanges[key][0],
          bandRanges[key][1],
        ).toFixed(1);
      if (this.values[key] !== value)
        this.edit({ ...this.values, [key]: value });
    };
    const end = () => {
      drag = null;
    };
    el.onpointerup = end;
    el.onpointercancel = end;
    el.onlostpointercapture = end;
    el.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(e.key))
        return;
      e.preventDefault();
      const sign = ["ArrowRight", "ArrowUp"].includes(e.key) ? 1 : -1;
      this.edit({
        ...this.values,
        [key]: +T.MathUtils.clamp(
          this.values[key] + sign * (key === "pave" ? 1 : 0.1),
          key === "front" && this.values.shoulders === "split"
            ? 3.4
            : bandRanges[key][0],
          key === "pave" ? this.s.band.row().max : bandRanges[key][1],
        ).toFixed(1),
      });
    };
  }
}
