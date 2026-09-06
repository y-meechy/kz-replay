export const FIDELITY_METADATA_SCHEMA = "kz-replay-fidelity-capture";
export const FIDELITY_METADATA_VERSION = 1;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (label, message) => {
  throw new TypeError(`${label}: ${message}`);
};

const finite = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(label, "must be a finite number");
  }
  return value;
};

const positive = (value, label) => {
  finite(value, label);
  if (value <= 0) fail(label, "must be greater than zero");
  return value;
};

const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    fail(label, "must be a non-empty string");
  }
  return value;
};

const exactArray = (value, length, label) => {
  if (!Array.isArray(value) || value.length !== length) {
    fail(label, `must be an array of ${length} numbers`);
  }
  value.forEach((entry, index) => finite(entry, `${label}[${index}]`));
  return value;
};

const sortedJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("metadata contains a non-finite number");
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError("metadata contains a value that cannot be serialized");
  }
  return JSON.stringify(value);
};

const equalJson = (a, b) => sortedJson(a) === sortedJson(b);

// Keep the metadata and timing helpers importable from browser-side capture
// code. Only the Node PNG comparison path needs sharp.
const loadSharp = async () => (await import("sharp")).default;

/**
 * Validate and return a capture manifest. The manifest is deliberately strict:
 * screenshots without a reproducible map, camera, display, and renderer context
 * are not useful evidence of fidelity.
 */
export const validateCaptureMetadata = (
  metadata,
  label = "capture metadata",
) => {
  if (!isPlainObject(metadata)) fail(label, "must be an object");
  if (metadata.schema !== FIDELITY_METADATA_SCHEMA) {
    fail(label, `schema must be ${FIDELITY_METADATA_SCHEMA}`);
  }
  if (metadata.schemaVersion !== FIDELITY_METADATA_VERSION) {
    fail(label, `schemaVersion must be ${FIDELITY_METADATA_VERSION}`);
  }
  if (!["cs2", "viewer"].includes(metadata.source)) {
    fail(`${label}.source`, 'must be "cs2" or "viewer"');
  }

  if (!isPlainObject(metadata.map)) fail(`${label}.map`, "must be an object");
  nonEmptyString(metadata.map.name, `${label}.map.name`);
  nonEmptyString(metadata.map.checksum, `${label}.map.checksum`);
  nonEmptyString(metadata.map.version, `${label}.map.version`);

  if (!isPlainObject(metadata.reference)) {
    fail(`${label}.reference`, "must be an object");
  }
  if (metadata.reference.source !== "cs2") {
    fail(
      `${label}.reference.source`,
      'must be exactly "cs2"; viewer captures are not references',
    );
  }
  nonEmptyString(metadata.reference.build, `${label}.reference.build`);

  if (!isPlainObject(metadata.camera))
    fail(`${label}.camera`, "must be an object");
  exactArray(metadata.camera.position, 3, `${label}.camera.position`);
  exactArray(metadata.camera.angles, 3, `${label}.camera.angles`);
  positive(metadata.camera.fov, `${label}.camera.fov`);
  if (!["horizontal", "vertical"].includes(metadata.camera.fovConvention)) {
    fail(`${label}.camera.fovConvention`, 'must be "horizontal" or "vertical"');
  }
  positive(metadata.camera.aspect, `${label}.camera.aspect`);
  if (!isPlainObject(metadata.camera.resolution)) {
    fail(`${label}.camera.resolution`, "must be an object");
  }
  for (const axis of ["width", "height"]) {
    const value = metadata.camera.resolution[axis];
    if (!Number.isInteger(value) || value <= 0) {
      fail(`${label}.camera.resolution.${axis}`, "must be a positive integer");
    }
  }
  const expectedAspect =
    metadata.camera.resolution.width / metadata.camera.resolution.height;
  if (Math.abs(metadata.camera.aspect - expectedAspect) > 1e-6) {
    fail(
      `${label}.camera.aspect`,
      "must equal resolution.width / resolution.height",
    );
  }
  positive(metadata.camera.dpr, `${label}.camera.dpr`);

  if (
    !isPlainObject(metadata.graphics) ||
    !isPlainObject(metadata.graphics.settings)
  ) {
    fail(`${label}.graphics.settings`, "must be an object");
  }
  // This also rejects NaN/Infinity and values such as undefined that JSON cannot
  // reproduce. It keeps matching deterministic across Node and browser runners.
  sortedJson(metadata.graphics.settings);

  if (metadata.captureId !== undefined) {
    nonEmptyString(metadata.captureId, `${label}.captureId`);
  }
  return metadata;
};

const captureMatchFields = ["map", "reference", "camera", "graphics"];

/** Validate two manifests and ensure they describe the same visual setup. */
export const validateMatchedCaptureMetadata = (reference, candidate) => {
  validateCaptureMetadata(reference, "reference metadata");
  validateCaptureMetadata(candidate, "candidate metadata");
  for (const field of captureMatchFields) {
    if (!equalJson(reference[field], candidate[field])) {
      throw new Error(`capture metadata mismatch in ${field}`);
    }
  }
  if (reference.source !== "cs2" || candidate.source !== "viewer") {
    throw new Error(
      "Comparison requires an actual CS2 reference and a viewer candidate",
    );
  }
  return { reference, candidate };
};

/**
 * The identity which must match when frame-time measurements are compared.
 * `runId` and `repetition` identify a paired trial; hardware/browser/path make
 * cross-environment comparisons invalid even if the screenshots look similar.
 */
export const validateMeasurementIdentity = (
  identity,
  label = "measurement identity",
) => {
  if (!isPlainObject(identity)) fail(label, "must be an object");
  for (const key of ["runId", "hardwareId", "browserId", "pathId"]) {
    nonEmptyString(identity[key], `${label}.${key}`);
  }
  if (identity.repetition !== undefined) {
    if (!Number.isInteger(identity.repetition) || identity.repetition < 0) {
      fail(`${label}.repetition`, "must be a non-negative integer");
    }
  }
  return identity;
};

export const validateMatchedMeasurementIdentity = (reference, candidate) => {
  validateMeasurementIdentity(reference, "reference measurement identity");
  validateMeasurementIdentity(candidate, "candidate measurement identity");
  for (const key of [
    "runId",
    "hardwareId",
    "browserId",
    "pathId",
    "repetition",
  ]) {
    if ((reference[key] ?? null) !== (candidate[key] ?? null)) {
      throw new Error(`measurement identity mismatch in ${key}`);
    }
  }
  return { reference, candidate };
};

const checkPixels = (pixels, label) => {
  if (!(pixels instanceof Uint8Array) && !Buffer.isBuffer(pixels)) {
    fail(label, "must be a Uint8Array or Buffer");
  }
  return pixels;
};

const metricFor = (reference, candidate, width, height, channels, box) => {
  const startX = box?.left ?? 0;
  const startY = box?.top ?? 0;
  const endX = box ? startX + box.width : width;
  const endY = box ? startY + box.height : height;
  let absolute = 0;
  let squared = 0;
  let maxAbsolute = 0;
  let differingPixels = 0;
  let pixels = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      let pixelDifferent = false;
      // Inputs are normalized to RGBA; `channels` only controls whether alpha
      // participates in the statistic.
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < channels; channel++) {
        const delta = Math.abs(
          reference[offset + channel] - candidate[offset + channel],
        );
        absolute += delta;
        squared += delta * delta;
        if (delta > maxAbsolute) maxAbsolute = delta;
        if (delta !== 0) pixelDifferent = true;
      }
      if (pixelDifferent) differingPixels++;
      pixels++;
    }
  }
  const sampleCount = pixels * channels;
  const mae = sampleCount === 0 ? 0 : absolute / sampleCount;
  const rmse = sampleCount === 0 ? 0 : Math.sqrt(squared / sampleCount);
  const psnr = rmse === 0 ? Infinity : 20 * Math.log10(255 / rmse);
  return {
    width: endX - startX,
    height: endY - startY,
    pixelCount: pixels,
    channelCount: channels,
    sampleCount,
    differingPixels,
    maxAbsolute,
    mae,
    rmse,
    psnr,
  };
};

const normalizeRois = (rois) => {
  if (rois === undefined) return {};
  if (!isPlainObject(rois)) fail("rois", "must be an object keyed by ROI name");
  const result = Object.create(null);
  for (const [name, box] of Object.entries(rois)) {
    nonEmptyString(name, "ROI name");
    if (name === "overall")
      fail("ROI name", '"overall" is reserved for the full image');
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      fail(
        "ROI name",
        "must contain only letters, numbers, dot, underscore, or hyphen",
      );
    }
    if (!isPlainObject(box)) fail(`rois.${name}`, "must be an object");
    for (const key of ["left", "top", "width", "height"]) {
      if (
        !Number.isInteger(box[key]) ||
        box[key] < 0 ||
        ((key === "width" || key === "height") && box[key] <= 0)
      ) {
        fail(`rois.${name}.${key}`, "must be a valid non-negative integer");
      }
    }
    result[name] = {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    };
  }
  return result;
};

/**
 * Compare decoded RGBA PNG pixels. `sharp` is intentionally kept behind this
 * API, so browser capture code can use the metadata and measurement contracts
 * without importing a Node-only image library.
 */
export const comparePngBuffers = async (
  referenceInput,
  candidateInput,
  { rois, includeAlpha = false, diffPath, maxPixels = 64_000_000 } = {},
) => {
  const sharp = await loadSharp();
  if (!Number.isInteger(maxPixels) || maxPixels <= 0) {
    throw new TypeError("maxPixels must be a positive integer");
  }
  const [reference, candidate] = await Promise.all([
    sharp(checkPixels(referenceInput, "reference PNG"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(checkPixels(candidateInput, "candidate PNG"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  if (
    reference.info.width !== candidate.info.width ||
    reference.info.height !== candidate.info.height
  ) {
    throw new Error(
      `PNG dimensions differ: reference ${reference.info.width}x${reference.info.height}, candidate ${candidate.info.width}x${candidate.info.height}`,
    );
  }
  const width = reference.info.width;
  const height = reference.info.height;
  if (width * height > maxPixels) {
    throw new Error(
      `PNG has ${width * height} pixels, exceeding maxPixels ${maxPixels}`,
    );
  }
  const channels = includeAlpha ? 4 : 3;
  const referencePixels = reference.data;
  const candidatePixels = candidate.data;
  const boxes = normalizeRois(rois);
  for (const [name, box] of Object.entries(boxes)) {
    if (box.left + box.width > width || box.top + box.height > height) {
      throw new Error(`ROI ${name} is outside image bounds ${width}x${height}`);
    }
  }

  const metrics = {
    overall: metricFor(
      referencePixels,
      candidatePixels,
      width,
      height,
      channels,
    ),
  };
  for (const [name, box] of Object.entries(boxes)) {
    metrics[name] = metricFor(
      referencePixels,
      candidatePixels,
      width,
      height,
      channels,
      box,
    );
  }

  if (diffPath) {
    const diff = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) {
      for (let channel = 0; channel < 3; channel++) {
        diff[i * 4 + channel] = Math.abs(
          referencePixels[i * 4 + channel] - candidatePixels[i * 4 + channel],
        );
      }
      if (includeAlpha) {
        diff[i * 4 + 3] = Math.abs(
          referencePixels[i * 4 + 3] - candidatePixels[i * 4 + 3],
        );
      }
    }
    await sharp(diff, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(diffPath);
  }

  return {
    width,
    height,
    includeAlpha,
    diffPath: diffPath ?? null,
    metrics,
  };
};

export const comparePngFiles = async (
  referencePath,
  candidatePath,
  options = {},
) => {
  const sharp = await loadSharp();
  if (typeof referencePath !== "string" || referencePath.trim() === "") {
    throw new TypeError("referencePath must be a non-empty path");
  }
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    throw new TypeError("candidatePath must be a non-empty path");
  }
  const [reference, candidate] = await Promise.all([
    sharp(referencePath).png().toBuffer(),
    sharp(candidatePath).png().toBuffer(),
  ]);
  return comparePngBuffers(reference, candidate, options);
};

const validateDurations = (samples, label) => {
  if (!Array.isArray(samples) && !ArrayBuffer.isView(samples))
    fail(label, "must be an array of durations");
  const values = Array.from(samples);
  if (values.length === 0) fail(label, "must contain at least one duration");
  values.forEach((value, index) => positive(value, `${label}[${index}]`));
  return values;
};

const percentile = (sorted, fraction) => {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

/** Summarize one cold or warm sample set in milliseconds using linear percentiles. */
export const summarizeFrameDurations = (samples, label = "frame durations") => {
  const sorted = validateDurations(samples, label).sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
};

/** Keep cold-start and warmed-up measurements separate in every report. */
export const summarizeFramePhases = ({ cold, warm }) => ({
  cold: summarizeFrameDurations(cold, "cold frame durations"),
  warm: summarizeFrameDurations(warm, "warm frame durations"),
});
