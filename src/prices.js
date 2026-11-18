/* Reference values in USD. See docs/pricing.md for the source, date and
   quality assumptions. Missing varieties intentionally have no price. */
export const coloredRates = {
  "chrome-diopside": 25,
  sphene: 5,
  heliodor: 24,
  kyanite: 25,
  fluorite: 4,
  "white-sapphire": 132,
  chrysoberyl: 116,
  pyrope: 12,
  "verneuil-ruby": 15,
  "flux-ruby": 240,
  "hydrothermal-emerald": 92,
  emerald: [790, 1790],
  ruby: 1600,
  "blue-sapphire": [1200, 2600],
  "pink-sapphire": [1000, 2900],
  "yellow-sapphire": [650, 1300],
  aquamarine: 180,
  morganite: 225,
  "red-spinel": 1700,
  "pink-spinel": 380,
  amethyst: 25,
  citrine: 25,
  "rose-quartz": 5,
  "rock-crystal": 6,
  "smoky-quartz": 9,
  "rutilated-quartz": 30,
  "sky-blue-topaz": 8,
  "london-blue-topaz": 19,
  "white-topaz": 8,
  "imperial-topaz": 900,
  "green-tourmaline": [48, 85],
  indicolite: 500,
  rubellite: 230,
  "blue-zircon": [33, 100],
  "white-zircon": [40, 30],
  "red-zircon": [58, 125],
  peridot: [125, 220],
  tanzanite: [230, 315],
  apatite: [40, 70],
  kunzite: 22,
  andalusite: 150,
  iolite: 40,
  almandine: 37,
  hessonite: 19,
  rhodolite: 200,
  spessartine: 950,
  tsavorite: [1500, 2700],
  "fire-opal": 32,
  cz: 2,
  moissanite: 140,
};

const alloys = {
  platinum: [45.78, 0.95],
  palladium: [30.67, 0.95],
  silver: [1.52, 0.925],
  "yellow-gold": [123.86, 0.75],
  "white-gold": [123.86, 0.75],
  "rose-gold": [123.86, 0.75],
  "yellow-gold-14k": [123.86, 14 / 24],
};
const diamondSizes = [0.5, 1, 1.5, 2, 2.5, 3];
const natural = [1077, 3850, 8360, 17380, 27800, 41010],
  lab = [395, 540, 791, 1055, 1260, 1591];
// Relative shape premiums at .5, 1 and 2 ct from the same natural index.
const naturalShape = {
  round: [1218, 4696, 19964],
  oval: [982, 3978, 19454],
  emerald: [712, 2809, 15142],
  princess: [721, 2848, 13257],
  cushion: [784, 2772, 13546],
  pear: [996, 3730, 19638],
};
function interpolate(x, weights, values) {
  if (x <= weights[0]) return values[0];
  for (let i = 1; i < weights.length; i++)
    if (x <= weights[i]) {
      const t = (x - weights[i - 1]) / (weights[i] - weights[i - 1]);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  return values.at(-1);
}
export function stonePrice(id, ct, cut) {
  if (id === "natural-diamond" || id === "lab-diamond") {
    const mined = id === "natural-diamond";
    if (ct < 0.5) {
      // Per-stone values; the small round diamond references are melee stock.
      const weights = [0, 0.015, 0.05, 0.11, 0.19, 0.3, 0.4, 0.5];
      const values = mined
        ? [0, 6, 23, 65, 139, 566, 723, 1077]
        : [0, 3, 10, 23, 55, 76, 98, 395];
      return interpolate(ct, weights, values);
    }
    const shape = naturalShape[cut];
    const ratio =
      mined && shape
        ? interpolate(
            ct,
            [0.5, 1, 2],
            shape.map((x, i) => x / [1077, 3850, 17380][i]),
          )
        : 1;
    return interpolate(ct, diamondSizes, mined ? natural : lab) * ratio;
  }
  const rate = coloredRates[id];
  if (rate === undefined) return null;
  return ct * (Array.isArray(rate) ? interpolate(ct, [1, 2.5], rate) : rate);
}
export function estimate(studio) {
  if (!studio?.fit) return null;
  const { state, lib } = studio,
    metal = lib.metals.find((m) => m.id === state.metal);
  const grams =
    ((studio.band?.volume ?? studio.fit.volume) * metal.density) / 1000;
  const [spot, fine] = alloys[metal.id];
  const metalCost = grams * spot * fine;
  const center = stonePrice(state.center, state.carats, state.cut);
  let accents = 0,
    accentCarats = 0,
    count = 0;
  const missing = new Set();
  for (const mesh of studio.stones) {
    if (mesh.userData.role === "center" || mesh.userData.bandHidden) continue;
    const id = studio.accentOverrides.get(mesh.name) ?? state.accent;
    const gem = lib.gems.find((g) => g.id === id);
    const ct = (mesh.userData.diamondCarats * gem.density) / 3.52;
    const cost = stonePrice(id, ct, mesh.userData.cut);
    if (cost === null) missing.add(gem.name);
    else accents += cost;
    accentCarats += ct;
    count++;
  }
  const accentKnown = missing.size === 0;
  if (center === null)
    missing.add(lib.gems.find((g) => g.id === state.center).name);
  return {
    grams,
    metalCost,
    center,
    centerCarats: state.carats,
    accents: accentKnown ? accents : null,
    count,
    accentCarats,
    missing: [...missing],
    total: missing.size ? null : metalCost + center + accents,
  };
}
