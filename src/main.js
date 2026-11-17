import "./style.css";
import lib from "../public/assets/library.json";
import rigs from "../public/assets/lights/lights.json";
import poses from "../public/assets/ring-poses.json";
import { JewelryStudio } from "./studio.js";

const $ = (id) => document.getElementById(id);
const icons = {
  star: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2m0-14-2 2M7 17l-2 2"/>',
  aperture:
    '<circle cx="12" cy="12" r="9"/><path d="m8 4 5 7m6-6-3 8m5 4-9-1m-2 5-4-8m-3-2 8-4"/>',
  down: '<path d="m7 9 5 5 5-5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  diamond: '<path d="m3 9 5-5h8l5 5-9 12zM3 9h18M8 4l4 17 4-17"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  orbit:
    '<ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-28 12 12)"/><circle cx="12" cy="12" r="2"/>',
  move: '<path d="M12 2v20M2 12h20m-13-7 3-3 3 3m4 4 3 3-3 3M9 19l3 3 3-3M5 9l-3 3 3 3"/>',
  focus:
    '<path d="M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  pause: '<path d="M8 5v14m8-14v14"/>',
  reset: '<path d="M4 10a8 8 0 1 1 0 6m0-13v7h7"/>',
  adjust:
    '<path d="M3 7h7m5 0h6M3 17h12m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>',
};
function icon(name) {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[name] + "</svg>"
  );
}
document
  .querySelectorAll("[data-icon]")
  .forEach((el) =>
    el.replaceWith(
      document.createRange().createContextualFragment(icon(el.dataset.icon)),
    ),
  );
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
const panels = ["styles", "cuts", "library", "light-panel", "lens-panel"];
function panel(id) {
  for (const p of panels) $(p).hidden = p !== id;
  for (const [a, b] of [
    ["library-open", "library"],
    ["styles-open", "styles"],
    ["cuts-open", "cuts"],
    ["light-toggle", "light-panel"],
    ["lens-toggle", "lens-panel"],
  ])
    $(a).setAttribute("aria-expanded", String(b === id));
  if (id === "library") {
    $("gem-search").value = "";
    gemList();
    if (matchMedia("(pointer:fine)").matches) $("gem-search").focus();
  }
}
function togglePanel(id) {
  panel($(id).hidden ? id : null);
}
function pressed(els, fn) {
  for (const el of els) el.setAttribute("aria-pressed", String(fn(el)));
}
let studio,
  request = 0;
let target = "center";
const currentGem = () => lib.gems.find((g) => g.id === studio.state[target]);
function paint() {
  const s = studio.state,
    gem = currentGem(),
    center = lib.gems.find((g) => g.id === s.center);
  const metal = lib.metals.find((m) => m.id === s.metal),
    cut = lib.cuts.find((c) => c.id === s.cut),
    rig = rigs.find((l) => l.id === s.rig);
  $("stone-family").textContent = gem.family;
  $("stone-name").textContent = gem.name;
  $("chip").style.setProperty("--stone", gem.color);
  $("cut-name").textContent = cut.name;
  $("cut-preview").src = "/assets/cuts/" + cut.id + ".webp";
  $("carat").value = s.carats;
  $("carat-v").value = s.carats.toFixed(2) + " ct";
  $("carat").setAttribute("aria-valuetext", $("carat-v").value);
  pressed(
    document.querySelectorAll("[data-cut]"),
    (el) => el.dataset.cut === s.cut,
  );
  pressed(
    document.querySelectorAll("[data-target]"),
    (el) => el.dataset.target === target,
  );
  $("metal-name").textContent = metal.name;
  $("light-title").textContent = rig.name;
  $("light-toggle").setAttribute("aria-label", "Lighting, " + rig.name);
  document.querySelector('[data-target="accent"]').disabled =
    !studio.stones.some((stone) => stone.userData.role !== "center");
  $("design-title").textContent =
    center.name +
    " " +
    (s.setting === "trilogy"
      ? "trilogy"
      : lib.settings
          .find((setting) => setting.id === s.setting)
          .name.toLowerCase());
  $("design-detail").textContent = cut.name + " cut · " + metal.name;
  $("focus-label").textContent =
    studio.focusRole === "center" ? "Center stone" : "Picked surface";
  $("style-name").textContent = lib.settings.find(
    (st) => st.id === s.setting,
  ).name;
  $("style-preview").src = "/assets/styles/" + s.setting + ".webp";
  document.body.style.setProperty(
    "--stage-ink",
    s.rig === "darkfield" ? "#f1f3e9" : "#223126",
  );
  pressed(
    document.querySelectorAll("[data-setting]"),
    (el) => el.dataset.setting === s.setting,
  );
  pressed(
    document.querySelectorAll("[data-metal]"),
    (el) => el.dataset.metal === s.metal,
  );
  pressed(
    document.querySelectorAll("[data-rig]"),
    (el) => el.dataset.rig === s.rig,
  );
  pressed(
    document.querySelectorAll("button[data-tool]"),
    (el) => el.dataset.tool === s.tool,
  );
  $("spin").setAttribute("aria-pressed", String(s.spin));
  $("spin").innerHTML = icon(s.spin ? "pause" : "play");
}
function gemList() {
  const q = $("gem-search").value.trim().toLowerCase();
  const list = lib.gems.filter((g) =>
    (g.name + " " + g.family).toLowerCase().includes(q),
  );
  const buttons = list.map((g) => {
    const el = document.createElement("button");
    el.className = "gem-option";
    el.dataset.gem = g.id;
    el.setAttribute("aria-pressed", String(studio.state[target] === g.id));
    const sw = document.createElement("span");
    sw.className = "facet-chip";
    sw.style.setProperty("--stone", g.color);
    const family = document.createElement("small");
    family.textContent = g.family;
    el.append(sw, document.createTextNode(g.name), family);
    el.onclick = () => {
      const s = studio.state;
      studio.setGems(
        target === "center" ? g.id : s.center,
        target === "accent" ? g.id : s.accent,
      );
      panel(null);
      paint();
      $("library-open").focus();
    };
    return el;
  });
  $("gem-list").replaceChildren(...buttons);
  $("gem-count").textContent =
    list.length + " of " + lib.gems.length + " stones";
}
async function design(setting, cut) {
  const token = ++request;
  notice("Loading setting…");
  try {
    if ((await studio.setDesign(setting, cut)) && token === request) {
      if (!studio.stones.some((stone) => stone.userData.role !== "center"))
        target = "center";
      paint();
      notice("");
    }
  } catch (e) {
    if (token === request) {
      paint();
      notice("Setting failed to load. Select it again to retry.");
    }
    console.error(e);
  }
}
let lightRequest = 0;
async function light(id) {
  const token = ++lightRequest;
  try {
    if ((await studio.setLight(id)) && token === lightRequest) {
      paint();
      notice("");
    }
  } catch (e) {
    if (token === lightRequest)
      notice("Lighting failed to load. Select it again to retry.");
    console.error(e);
  }
}
function tool(mode) {
  studio.setTool(mode);
  if (mode === "focus" && !studio.state.aperture) {
    $("dof").value = 38;
    $("dof").dispatchEvent(new Event("input"));
  }
  paint();
}
function bind() {
  for (const st of lib.settings) {
    const b = document.createElement("button");
    b.dataset.setting = st.id;
    const im = document.createElement("img");
    im.src = "/assets/styles/" + st.id + ".webp";
    im.alt = "";
    im.loading = "lazy";
    b.append(im);
    b.append(st.name);
    b.onclick = () => {
      panel(null);
      design(st.id, studio.state.cut);
      $("styles-open").focus();
    };
    $("settings").append(b);
  }
  for (const cut of lib.cuts) {
    const b = document.createElement("button");
    const im = document.createElement("img");
    im.src = "/assets/cuts/" + cut.id + ".webp";
    im.alt = "";
    b.dataset.cut = cut.id;
    b.append(im, cut.name);
    b.onclick = () => {
      panel(null);
      design(studio.state.setting, cut.id);
      $("cuts-open").focus({ preventScroll: true });
    };
    $("cut-grid").append(b);
  }
  for (const m of lib.metals) {
    const b = document.createElement("button");
    b.dataset.metal = m.id;
    b.style.setProperty("--metal", m.color);
    b.title = m.name;
    b.setAttribute("aria-label", m.name);
    b.onclick = () => {
      studio.setMetal(m.id);
      paint();
    };
    $("metals").append(b);
  }
  for (const r of rigs) {
    const b = document.createElement("button");
    b.dataset.rig = r.id;
    b.innerHTML = '<span class="rig-mark ' + r.id + '"></span>';
    b.append(r.name);
    b.onclick = () => light(r.id);
    $("rigs").append(b);
  }
  $("cuts-open").onclick = () => togglePanel("cuts");
  for (const b of document.querySelectorAll("[data-target]")) {
    b.onclick = () => {
      target = b.dataset.target;
      paint();
    };
  }
  $("carat").oninput = (e) => {
    studio.setCarats(Number(e.target.value));
    $("carat-v").value = studio.state.carats.toFixed(2) + " ct";
    e.target.setAttribute("aria-valuetext", $("carat-v").value);
  };
  $("gem-search").oninput = gemList;
  $("styles-open").onclick = () => togglePanel("styles");
  $("library-open").onclick = () => togglePanel("library");
  $("light-toggle").onclick = () => togglePanel("light-panel");
  $("lens-toggle").onclick = () => togglePanel("lens-panel");
  for (const el of document.querySelectorAll("[data-close]"))
    el.onclick = () => panel(null);
  $("fold-design").onclick = () => {
    if (
      matchMedia(
        "(max-width: 700px), (pointer: coarse) and (max-height: 520px)",
      ).matches
    ) {
      $("design").classList.remove("mobile-open");
    } else {
      const hidden = ($("design-body").hidden = !$("design-body").hidden);
      $("design").classList.toggle("folded", hidden);
      $("fold-design").innerHTML = icon(hidden ? "plus" : "minus");
      $("fold-design").setAttribute("aria-expanded", String(!hidden));
    }
  };
  $("mobile-edit").onclick = () => {
    panel(null);
    $("design").classList.toggle("mobile-open");
    $("design-body").hidden = false;
  };
  for (const el of document.querySelectorAll("button[data-tool]"))
    el.onclick = () => tool(el.dataset.tool);
  $("stage").addEventListener("pointerdown", () => {
    panel(null);
    $("design").classList.remove("mobile-open");
  });
  $("pick-focus").onclick = () => {
    tool("focus");
    panel(null);
  };
  $("center-focus").onclick = () => {
    studio.focusCenter();
    paint();
  };
  $("azimuth").oninput = (e) => {
    studio.setAngle(+e.target.value);
    $("azimuth-v").value = e.target.value + "°";
  };
  $("exposure").oninput = (e) => {
    studio.setExposure(2 ** +e.target.value);
    $("exposure-v").value = (+e.target.value).toFixed(1) + " EV";
  };
  $("sparkle").oninput = (e) => {
    studio.lens.sparkle = Number(e.target.value) / 100;
    $("sparkle-v").value = e.target.value + "%";
    studio.invalidate();
  };
  $("dof").oninput = (e) => {
    studio.state.aperture = +e.target.value / 100;
    $("dof-v").value = +e.target.value ? e.target.value + "%" : "Off";
    studio.invalidate();
  };
  $("spin").onclick = () => {
    studio.state.spin = !studio.state.spin;
    tool("orbit");
  };
  $("home").onclick = () => {
    studio.reset();
    tool("orbit");
  };
  $("zoom-out").onclick = () => studio.zoom(1.16);
  $("zoom-in").onclick = () => studio.zoom(1 / 1.16);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      panel(null);
      $("design").classList.remove("mobile-open");
      tool("orbit");
      return;
    }
    if (
      /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    if (e.code === "Space" && e.target.tagName !== "BUTTON") {
      e.preventDefault();
      $("spin").click();
    }
    if (e.code === "Home") {
      e.preventDefault();
      $("home").click();
    }
    const mode = { o: "orbit", m: "move", f: "focus" }[e.key.toLowerCase()];
    if (mode) tool(mode);
  });
}
try {
  studio = new JewelryStudio(
    $("stage"),
    lib,
    rigs,
    poses,
    (f) => ($("perf").textContent = Math.round(f) + " FPS"),
    (s) => ($("focus-label").textContent = s),
  );
  bind();
  paint();
  await Promise.all([
    studio.setLight("softbox"),
    studio.setDesign("trilogy", "emerald"),
  ]);
  paint();
  notice("");
} catch (e) {
  console.error(e);
  notice(
    "The studio could not start. Check WebGL 2 hardware acceleration and reload.",
  );
}
