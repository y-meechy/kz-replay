// Give every surface of a map a plausible colour, without any texture.
//
// A workshop map ships no materials. It only references them by path, into game
// files we do not have, so the exported world arrives as one untextured shape. But
// the paths themselves survive, and Valve names them after what they are:
//
//   materials/cbble/cobblestone_wet_blend_2.vmat
//   materials/de_overpass/nature/dirt_ground_2_blend_3.vmat
//   materials/foliage/trees/bark/foliage_bark_pine_01.vmat
//
// That is enough to colour a map. Not the real texture, and not pretending to be:
// cobblestone becomes grey, dirt becomes brown, bark becomes brown-green, and the
// level reads as a place instead of a single grey mass.
//
// Where a surface has no material path, its own mesh name is matched instead. The
// exporter builds those from the model, so a prop arrives as
// `..._nomerge0_generic_tree_large_1_wi` and still lands on the foliage rule.

/**
 * Keyword to colour, most specific first.
 *
 * Order matters and is the whole design. `wood_fence` must not be caught by a
 * generic `fence` rule before the wood rule sees it, and `dust_window_bars_metal`
 * has to reach metal rather than stopping at window. Rules are therefore listed
 * from narrow to broad, and the first hit wins.
 *
 * Colours are sRGB hex, chosen dark and desaturated on purpose. The run is drawn
 * over this in bright speed colours, and a map that competes with it is worse than
 * a grey one.
 */
const RULES = [
  // The KZ timer zones. Not scenery: these are the start and end of the run, and
  // seeing where they are is worth more than any texture on them.
  [["startzone"], "#2f7d4f"],
  [["endzone"], "#8c3b3b"],
  [["splitzone", "splitzonebright"], "#3a6ea8"],

  // Growing things.
  [["moss", "topmoss"], "#4a5c3a"],
  [
    ["ivy", "vine", "leaves", "leaf", "foliage", "bush", "shrub", "fern"],
    "#465c3c",
  ],
  [["bark", "trunk", "tree", "cypress", "pine", "poplar", "birch"], "#4a4335"],
  [["grass", "hedge", "weed", "plant"], "#4c5b3b"],

  // Ground.
  [["cobble", "cobblestone"], "#5a5751"],
  [["gravel", "rubble"], "#57544d"],
  [["sand", "dune"], "#6d6350"],
  [["dirt", "mud", "ground", "soil", "earth"], "#5b4d3c"],

  // Built surfaces. Wood before fence and door, so a wooden one is not read as metal.
  [["wood", "plank", "timber", "lumber"], "#5b4936"],
  [["brick"], "#6b4c40"],
  [["plaster", "stucco"], "#6e6a61"],
  [["marble", "granite", "limestone"], "#6a6862"],
  [["stone", "rock", "cliff", "cladding", "boulder"], "#5c5a55"],
  [["concrete", "cement", "asphalt", "tarmac"], "#54555a"],
  [["roof", "shingle", "terracotta"], "#6a4a3c"],
  [["tile", "ceramic"], "#5f6165"],

  // Metal and glass. Rust before metal: a rusted panel is orange, not grey.
  [["rust", "corrode"], "#6b4a35"],
  [["gold", "brass", "bronze"], "#7a6538"],
  [
    ["metal", "steel", "iron", "aluminium", "aluminum", "tin", "chrome"],
    "#565c63",
  ],
  [["glass", "window"], "#4a5f6b"],

  // Water.
  [["water", "pool", "river", "sea", "ocean"], "#33566b"],
  [["snow", "ice"], "#77828c"],

  // Fittings, once the material they are made of has had its chance.
  [["fence", "railing", "grate", "bars"], "#585c60"],
  [["door", "gate", "hatch"], "#5a5248"],
  [["sign", "poster", "banner", "decal", "graffiti"], "#63615c"],
  [["fabric", "cloth", "canvas", "tarp", "curtain"], "#5f5750"],
  [["paint", "painted"], "#5d5f63"],

  // Named non-colours, last: a path ending in `black` means it.
  [["black"], "#26292e"],
  [["white"], "#7d8087"],
];

/**
 * Everything no rule claimed.
 *
 * This one matters more than any rule. A map's own structure — the blocks and
 * platforms a run is actually made of — is usually built from meshes the world
 * gives no material name to and whose own names are just node ids, so most of what
 * you stand on lands here. It is a warm brown rather than the blue-grey the viewer
 * used before: the scene is lit by a blue sky light, which cools every up-facing
 * surface, and a neutral default came out of that looking like cold slate.
 */
export const DEFAULT_COLOUR = "#8a6647";

/**
 * Surfaces that should not be drawn at all.
 *
 * Two kinds, for the same reason: in the game they are either invisible or nearly
 * so, and here they would be solid.
 *
 * Tool textures are the compiler's own — triggers, clips, skips — and are pure
 * collision. Effect surfaces are the flat cards a mapper hangs in the air for a
 * god ray, a light shaft or a puff of smoke. The game draws those at a few percent
 * opacity, additively. Nothing in this pipeline carries opacity: the exporter
 * cannot resolve the material that would have said so, and a glTF material with no
 * alpha is opaque. So a god ray that should be a faint shaft of light arrives as a
 * solid slab hanging across the level, which is exactly what a mapper notices
 * first. Dropping them is closer to right than drawing them at full strength.
 */
const INVISIBLE = [
  // Compiler tools.
  "toolsclip",
  "toolstrigger",
  "toolsskip",
  "toolsnodraw",
  "toolsinvisible",
  "toolsblocklight",
  "toolssolidblocklight",
  // Effects, which are translucent cards in the game and slabs without opacity.
  "godray",
  "godrays",
  "god_ray",
  "lightray",
  "lightrays",
  "sunray",
  "sunrays",
  // A mapper is as likely to write `light_rays` as `lightrays`, and the underscore
  // splits it into two words. Safe on its own: word boundaries keep it out of
  // `array` and `murray`.
  "ray",
  "rays",
  "lightshaft",
  "sunshaft",
  "volumetric",
  "lightbeam",
  "beam",
  "glow",
  "flare",
  "halo",
  "smoke",
  "haze",
  "mist",
  "steam",
  "particle",
  "sprite",
  "overlay_fog",
];

const hexToLinear = (hex) => {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    // glTF baseColorFactor is linear; these are picked as sRGB.
    const srgb = ((value >> shift) & 0xff) / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return [channel(16), channel(8), channel(0)];
};

/**
 * Keywords are matched between separators, never as a substring.
 *
 * `materials/models/props/de_inferno/wood_fence.vmat` is the example that forces
 * this: a plain substring test finds "fern" inside "inferno" and paints every
 * surface of an Inferno-themed map foliage green. trimMap.js learned the same
 * lesson the same way. Word boundaries, always.
 */
const boundedPattern = (words) =>
  new RegExp(`(^|[_\\-./ ])(${words.join("|")})([_\\-./ 0-9]|$)`, "i");

const COMPILED = RULES.map(([words, hex]) => ({
  pattern: boundedPattern(words),
  hex,
}));

const INVISIBLE_PATTERN = boundedPattern(INVISIBLE);

/** True for a material that the game never draws. */
export const isInvisibleMaterial = (name) => INVISIBLE_PATTERN.test(name ?? "");

/**
 * Pick a colour for one material path or mesh name.
 *
 * @returns { hex, linear, rule } — `rule` is the keyword that matched, or null.
 */
export const colourFor = (name) => {
  const haystack = name ?? "";
  for (const { pattern, hex } of COMPILED) {
    const match = haystack.match(pattern);
    if (match) return { hex, linear: hexToLinear(hex), rule: match[2] };
  }
  return {
    hex: DEFAULT_COLOUR,
    linear: hexToLinear(DEFAULT_COLOUR),
    rule: null,
  };
};
