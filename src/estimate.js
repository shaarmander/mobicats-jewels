import { estimate } from "./prices.js";

const el = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const rounded = (n) =>
  n == null ? "" : n < 50 ? "< $100" : money.format(Math.round(n / 100) * 100);
let lastLabel,
  timer,
  loading = false;
function reels(label) {
  const host = el("estimate-reels");
  const parts = Array.from(label, (c, place) => {
    if (!/\d/.test(c)) return document.createTextNode(c);
    const slot = document.createElement("span"),
      strip = document.createElement("span");
    slot.className = "digit-slot";
    strip.className = "digit-strip";
    strip.style.animationDelay = place * 12 + "ms";
    for (let i = 0; i < 5; i++) {
      const digit = document.createElement("i");
      digit.textContent = String((Number(c) + i * 3) % 10);
      strip.append(digit);
    }
    slot.append(strip);
    return slot;
  });
  host.replaceChildren(...parts);
}
export function loadingEstimate() {
  clearTimeout(timer);
  loading = true;
  lastLabel = undefined;
  el("estimate").setAttribute("aria-busy", "true");
  el("estimate-live").textContent = "Calculating materials estimate";
  for (const id of [
    "price-metal",
    "price-center",
    "price-accents",
    "price-note",
  ])
    el(id).textContent = "";
  el("price-metal-label").textContent = "Metal";
  el("price-center-label").textContent = "Center";
  el("price-accents-label").hidden = el("price-accents").hidden = true;
  reels(matchMedia("(prefers-reduced-motion:reduce)").matches ? "…" : "$0,000");
}
export function updateEstimate(studio) {
  const e = estimate(studio);
  el("estimate").setAttribute("aria-busy", "false");
  if (e) {
    el("price-metal-label").textContent =
      "Metal · " + e.grams.toFixed(2) + " g";
    el("price-metal").textContent = rounded(e.metalCost);
    el("price-center-label").textContent =
      "Center · " + e.centerCarats.toFixed(2) + " ct";
    el("price-center").textContent = rounded(e.center);
    el("price-accents-label").hidden = el("price-accents").hidden = !e.count;
    el("price-accents-label").textContent =
      "Accents · " + e.accentCarats.toFixed(2) + " ct";
    el("price-accents").textContent = rounded(e.accents);
  }
  el("price-note").textContent = e?.missing.length
    ? "No reference price for " + e.missing.join(", ") + "."
    : "";
  const label = rounded(e?.total);
  if (label === lastLabel && !loading) return;
  lastLabel = label;
  loading = false;
  clearTimeout(timer);
  reels(label);
  timer = setTimeout(() => {
    el("estimate-live").textContent = label
      ? "Estimated materials " + label + " USD"
      : "Materials estimate unavailable";
  }, 380);
}
