const settings = new Map(
  Object.entries({
    solitaire: "Solitaire",
    trilogy: "Trinity",
    pave: "Stardust",
    cathedral: "Cathedral",
    split: "Crossroads",
    eastwest: "Horizon",
    knife: "Ridgeline",
    dome: "Vault",
    cluster: "Constellation",
    cable: "Twine",
    ribbon: "Ribbon",
    wishbone: "Wishbone",
    bypass: "Duet",
    interlace: "Lovers’ Knot",
    double: "Twin Rivers",
    marquise: "Laurel",
    fluted: "Aria",
    petal: "Blossom",
  }),
);

// Transparent stones borrow their light from the metal. The ending echoes
// the cut's silhouette: long steps, pointed drops, or a brilliant's rays.
const metalLight = new Map(
  Object.entries({
    "yellow-gold": "Sun",
    "yellow-gold-14k": "Sun",
    "rose-gold": "Rose",
    platinum: "Star",
    "white-gold": "Moon",
    silver: "Moon",
    palladium: "Frost",
  }),
);
const cutShape = new Map(
  Object.entries({
    emerald: "spire",
    baguette: "spire",
    asscher: "well",
    princess: "crest",
    radiant: "burst",
    round: "burst",
    trillion: "crest",
    oval: "light",
    pear: "drop",
    marquise: "leaf",
    rose: "bloom",
    cushion: "glow",
    "old-mine": "glow",
    "old-european": "glow",
    hexagon: "crest",
    kite: "wing",
    portuguese: "fire",
    checkerboard: "weave",
  }),
);
const stones = new Map();
for (const [word, ids] of [
  [
    "Ember",
    "ruby verneuil-ruby flux-ruby red-spinel red-beryl red-zircon pyrope almandine rubellite fire-opal",
  ],
  [
    "Kingfisher",
    "blue-sapphire cobalt-spinel london-blue-topaz indicolite kyanite benitoite",
  ],
  [
    "Tideglass",
    "aquamarine blue-diamond sky-blue-topaz paraiba-tourmaline blue-zircon apatite",
  ],
  [
    "Briar",
    "emerald hydrothermal-emerald tsavorite chrome-diopside green-tourmaline moldavite",
  ],
  [
    "Willow",
    "green-diamond peridot hiddenite demantoid prasiolite chrysoberyl sphene",
  ],
  ["Foxglove", "amethyst tanzanite iolite fluorite kunzite"],
  [
    "Wildrose",
    "pink-diamond pink-sapphire morganite rose-quartz rhodolite pink-spinel rhodochrosite",
  ],
  [
    "Marigold",
    "cape-yellow-diamond canary-diamond yellow-sapphire citrine heliodor orthoclase",
  ],
  [
    "Afterglow",
    "padparadscha imperial-topaz spessartine hessonite oregon-sunstone amber",
  ],
  ["Honeycomb", "champagne-diamond rutilated-quartz sphalerite"],
  ["Dusk", "smoky-quartz cassiterite andalusite"],
  ["Equinox", "alexandrite"],
])
  for (const id of ids.split(" ")) stones.set(id, word);

export function ringName({ center, metal, cut, setting }, band) {
  const light = metalLight.get(metal) ?? "Sun";
  const prefix = stones.get(center) ?? light + (cutShape.get(cut) ?? "spire");
  const name = prefix + " " + (settings.get(setting) ?? "Trinity");
  if (band?.coverage === "full") return name + " · Eternity";
  if (band?.coverage === "threeQuarter") return name + " · Crescent";
  if (band?.finish === "hammered") return name + " · Forged";
  if (band?.edge === "beaded") return name + " · Milgrain";
  return name;
}
