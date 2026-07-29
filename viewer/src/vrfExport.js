// The two corrections that put anything Source2Viewer exported into the replay's space.
//
// 1. Scale. Source2Viewer bakes a 1/39.37 unit conversion into every node matrix (it
//    treats one Source unit as one inch) while leaving the mesh data itself in Source
//    units. Scaling by 39.37 cancels that, leaving the export at its true Source size,
//    which is the space the replay positions live in. Do not "correct" this to 52.4934,
//    the real 0.75-inch conversion: the job is to match the exporter, not reality.
//
// 2. Yaw. The export ends up turned a quarter turn about the up axis relative to the
//    replay's coordinates.
//
// Both numbers were measured, not assumed: player.js's probeGround() casts a ray down
// from the player's feet on ticks where the replay says they were standing still. With
// these values the floor is a median of 0 units below the feet. Every other combination
// of scale, axis order and yaw that was tried is off by 150 units or more.
//
// They apply to the character as much as to the map, which is why they live here rather
// than in either: a model's skeleton root carries the same 0.0254 scale and the same
// quarter turn, so a body loaded without them stands two units tall and faces sideways.

export const VRF_UNITS_PER_EXPORTED_METRE = 39.37;
export const VRF_YAW_CORRECTION = Math.PI / 2;
