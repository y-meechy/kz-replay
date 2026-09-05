#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  comparePngFiles,
  validateMatchedCaptureMetadata,
} from "../src/fidelityMetrics.js";

const usage = `Usage:
  node scripts/compare-captures.js \\
    --reference reference.png --candidate candidate.png \\
    --reference-meta reference.json --candidate-meta candidate.json \\
    --diff difference.png [--roi name=left,top,width,height]... [--include-alpha]

Both metadata files are required. Every named ROI is reported in addition to
the overall image metrics; no ROI values are folded into an aggregate score.`;

const needValue = (args, index, flag) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
};

const parseArgs = (args) => {
  const options = { rois: {} };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (
      [
        "--reference",
        "--candidate",
        "--reference-meta",
        "--candidate-meta",
        "--diff",
      ].includes(flag)
    ) {
      options[flag.slice(2).replaceAll("-", "_")] = needValue(
        args,
        index,
        flag,
      );
      index++;
      continue;
    }
    if (flag === "--roi") {
      const value = needValue(args, index, flag);
      const separator = value.indexOf("=");
      if (separator <= 0)
        throw new Error("--roi must look like name=left,top,width,height");
      const name = value.slice(0, separator);
      const values = value
        .slice(separator + 1)
        .split(",")
        .map(Number);
      if (
        values.length !== 4 ||
        values.some((entry) => !Number.isInteger(entry))
      ) {
        throw new Error(
          `invalid ROI ${value}; expected name=left,top,width,height`,
        );
      }
      const [left, top, width, height] = values;
      options.rois[name] = { left, top, width, height };
      index++;
      continue;
    }
    if (flag === "--include-alpha") {
      options.includeAlpha = true;
      continue;
    }
    throw new Error(`unknown option ${flag}`);
  }
  for (const key of [
    "reference",
    "candidate",
    "reference_meta",
    "candidate_meta",
    "diff",
  ]) {
    if (!options[key]) throw new Error(`missing --${key.replaceAll("_", "-")}`);
  }
  return options;
};

const readJson = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error.message}`);
  }
};

const jsonForTerminal = (value) =>
  JSON.stringify(
    value,
    (_key, entry) => (entry === Infinity ? null : entry),
    2,
  );

export const main = async (args = process.argv.slice(2)) => {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const [referenceMetadata, candidateMetadata] = await Promise.all([
    readJson(options.reference_meta, "reference metadata"),
    readJson(options.candidate_meta, "candidate metadata"),
  ]);
  validateMatchedCaptureMetadata(referenceMetadata, candidateMetadata);
  for (const [path, metadata] of [
    [options.reference, referenceMetadata],
    [options.candidate, candidateMetadata],
  ]) {
    const image = await sharp(path).metadata();
    const expected = metadata.camera.resolution;
    if (image.width !== expected.width || image.height !== expected.height) {
      throw new Error(`PNG dimensions disagree with capture metadata: ${path}`);
    }
  }
  const result = await comparePngFiles(options.reference, options.candidate, {
    diffPath: options.diff,
    rois: options.rois,
    includeAlpha: options.includeAlpha === true,
  });
  console.log(jsonForTerminal(result));
  return 0;
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`compare-captures: ${error.message}`);
    console.error(usage);
    process.exitCode = 1;
  });
}
