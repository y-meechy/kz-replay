/** A reference position is the optical/eye position, never the player's feet. */
export const referenceCameraPose = ({
  position,
  angles,
  fov,
  fovConvention,
  aspect,
}) => {
  for (const value of [position, angles]) {
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !value.every(Number.isFinite)
    )
      throw new Error(
        "Reference camera needs finite three-component position and angles",
      );
  }
  if (angles[2] !== 0)
    throw new Error("Rolled reference cameras are not supported");
  if (!(
    Number.isFinite(fov) &&
    fov > 0 &&
    fov < 180 &&
    Number.isFinite(aspect) &&
    aspect > 0
  ))
    throw new Error("Invalid reference FOV or aspect");
  if (!["vertical", "horizontal"].includes(fovConvention))
    throw new Error(
      "Specify the actual horizontal or vertical FOV, not a game's nominal FOV setting",
    );
  const radians = Math.PI / 180;
  const [pitch, yaw] = angles.map((value) => value * radians);
  const eye = [position[0], position[2], -position[1]];
  const forward = [
    Math.cos(pitch) * Math.cos(yaw),
    -Math.sin(pitch),
    -Math.cos(pitch) * Math.sin(yaw),
  ];
  return {
    position: eye,
    target: eye.map((value, i) => value + forward[i]),
    verticalFov:
      fovConvention === "vertical"
        ? fov
        : (2 * Math.atan(Math.tan((fov * radians) / 2) / aspect)) / radians,
  };
};
