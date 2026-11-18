const vector = (v) => v.toArray().map((n) => +n.toFixed(5));

export function designLink(studio) {
  const s = studio.state;
  const p = new URLSearchParams({ v: "1" });
  for (const key of [
    "setting",
    "cut",
    "profile",
    "center",
    "accent",
    "metal",
    "rig",
    "carats",
    "rotation",
    "exposure",
    "aperture",
  ])
    p.set(key, s[key]);
  p.set("sparkle", studio.lens.sparkle);
  p.set("eye", vector(studio.camera.position));
  p.set("target", vector(studio.controls.target));
  p.set("move", vector(studio.assembly.position));
  if (studio.focusPick) {
    const { object, face, barycoord } = studio.focusPick;
    p.set(
      "focus",
      [object.name, face.a, face.b, face.c, ...vector(barycoord)].join(","),
    );
  }
  for (const [name, gem] of studio.accentOverrides)
    p.append("stone", name + ":" + gem);
  const url = new URL("/", location.origin);
  url.search = "";
  url.hash = p.toString();
  return url.href;
}

export function readDesign(fragment, lib, rigs) {
  const p = new URLSearchParams(fragment.slice(1));
  if (p.get("v") !== "1") return null;
  const s = {};
  for (const [key, items] of Object.entries({
    setting: lib.settings,
    cut: lib.cuts,
    metal: lib.metals,
    rig: rigs,
    center: lib.gems,
    accent: lib.gems,
  })) {
    if (items.some((item) => item.id === p.get(key))) s[key] = p.get(key);
  }
  if (["fine", "classic", "bold"].includes(p.get("profile")))
    s.profile = p.get("profile");
  for (const [key, lo, hi] of [
    ["carats", 0.5, 3],
    ["exposure", 2 ** -1.5, 2 ** 1.5],
    ["rotation", -180, 180],
    ["aperture", 0, 1],
    ["sparkle", 0, 1],
  ]) {
    const n = Number(p.get(key));
    if (p.get(key)?.trim() && Number.isFinite(n) && n >= lo && n <= hi)
      s[key] = n;
  }
  for (const key of ["eye", "target", "move"]) {
    if (!p.has(key)) continue;
    const parts = p.get(key).split(",");
    const v = parts.map(Number);
    if (
      parts.length === 3 &&
      parts.every((x) => x.trim()) &&
      v.every((n) => Number.isFinite(n) && Math.abs(n) <= 200)
    )
      s[key] = v;
  }
  s.stones = new Map();
  for (const entry of p.getAll("stone")) {
    const [name, id] = entry.split(":");
    if (/^(side|pave)-\d+$/.test(name) && lib.gems.some((g) => g.id === id))
      s.stones.set(name, id);
  }
  s.focus = p.get("focus")?.split(",");
  return s;
}

export function restoreView(studio, s) {
  const pose = s.move;
  if (pose) {
    studio.assembly.position.set(
      Math.max(-18, Math.min(18, pose[0])),
      0,
      Math.max(-18, Math.min(18, pose[2])),
    );
    studio.floorUniforms.origin.value.set(
      studio.assembly.position.x,
      studio.assembly.position.z,
    );
    studio.assembly.updateMatrixWorld(true);
  }
  for (const mesh of studio.stones)
    if (s.stones.has(mesh.name))
      studio.accentOverrides.set(mesh.name, s.stones.get(mesh.name));
  if (s.stones.size) studio.setGems(studio.state.center, studio.state.accent);
  studio.setAngle(studio.state.rotation);
  studio.focusCenter();
  if (s.eye && s.target) {
    studio.camera.position.fromArray(s.eye);
    studio.controls.target.fromArray(s.target);
    studio.controls.update();
  }
  if (s.focus?.length === 7) {
    const [name, ...values] = s.focus,
      mesh = studio.model.getObjectByName(name);
    const [a, b, c, x, y, z] = values.map(Number),
      pos = mesh?.geometry?.attributes.position;
    if (
      pos &&
      [a, b, c].every((i) => Number.isInteger(i) && i >= 0 && i < pos.count) &&
      [x, y, z].every((n) => n >= 0 && n <= 1) &&
      Math.abs(x + y + z - 1) < 0.001
    ) {
      const barycoord = studio.focusPoint.clone().set(x, y, z);
      studio.focusPick = { object: mesh, face: { a, b, c }, barycoord };
      studio.focusRole = "picked";
      studio.fitCenter(
        studio.lib.gems.find((g) => g.id === studio.state.center),
      );
    }
  }
  studio.invalidate(true);
}

let lastPreview;
export async function previewLink(studio, legacy) {
  if (lastPreview?.design === legacy) return lastPreview.url;
  const { blob: image, state: captured } = await studio.captureImage(true, () =>
    designLink(studio),
  );
  const response = await fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: image,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error("Preview unavailable");
  const { id } = await response.json();
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid preview");
  const url = new URL("/s/" + id, location.origin);
  url.search = new URL(captured).hash.slice(1);
  lastPreview = { design: captured, url: url.href };
  return url.href;
}
