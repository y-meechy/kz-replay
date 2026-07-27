#!/usr/bin/env node
// Sanity check for the run alignment, which has no other test.
//
// The invariant: adding up the per-sector time differences must reproduce the gap
// between the two finish times. It holds only if every challenger tick is placed at
// the right point on the reference's course, so a projection that snaps forward
// breaks it loudly. That is exactly the bug this script exists to catch.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplay } from "../src/index.js";
import { analyseRun } from "../src/analysis.js";
import { compareRuns } from "../src/compare.js";
import { fetchReplay } from "../src/api.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PAIRS = [
  [
    "kz_victoria Main",
    "019ee775-a4c7-7b23-9507-ead26ff08f19",
    "019ee7e7-c989-7a82-aa78-abaa88813a2f",
  ],
  [
    "kz_topsecret Hangar",
    "019f8f30-edb6-7761-9e35-a176d31d610b",
    "019f9448-fd84-7c43-8111-0ddd44126d89",
  ],
  [
    "kz_moss Main",
    "019f4d1b-9bfd-7f82-9c30-1a2a5f38b624",
    "019f9e42-7149-7b72-bb8b-4856661161cd",
  ],
  [
    "kz_grotto Garden",
    "019f947f-21e7-7a43-bc09-084c0191d55a",
    "019f9ff9-91c6-7d90-87f4-88a9ae35f953",
  ],
];

const load = async (recordId) => {
  const cached = join(ROOT, "samples", `${recordId}.replay`);
  let buffer;
  try {
    const bytes = await readFile(cached);
    buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.length,
    );
  } catch {
    buffer = await fetchReplay(recordId);
  }
  return analyseRun(parseReplay(buffer));
};

let failures = 0;

for (const [label, referenceId, challengerId] of PAIRS) {
  const [reference, challenger] = await Promise.all([
    load(referenceId),
    load(challengerId),
  ]);
  const comparison = compareRuns(reference, challenger);

  const sectorSum = comparison.sectors.reduce(
    (total, sector) => total + sector.delta,
    0,
  );
  const finalDelta = comparison.finalDelta;
  // The last curve sample is the gap at the end of the compared stretch. Sectors
  // cover exactly that stretch, so the two must agree to the interpolation error.
  const gapAtEnd = comparison.curve.at(-1).delta;
  const internalError = Math.abs(sectorSum - gapAtEnd);
  // How much of each run the compared stretch actually covers. A gap here is not an
  // alignment fault, it means one run's path could not be followed to the end.
  const coverage = comparison.courseLength / comparison.referenceLength;
  const finishError = Math.abs(gapAtEnd - finalDelta);

  const biggestSwing = Math.max(
    ...comparison.sectors.map((sector) => Math.abs(sector.delta)),
  );
  const runLength = reference.run.reportedTime;

  const ok =
    internalError <= 2 / 64 &&
    coverage > 0.97 &&
    finishError <= 2 / 64 + Math.abs(finalDelta) * 0.05 &&
    biggestSwing < runLength * 0.25;
  if (!ok) failures += 1;

  console.log(
    `${ok ? "ok  " : "FAIL"} ${label.padEnd(22)} ` +
      `final ${finalDelta.toFixed(3)}s  gap@end ${gapAtEnd.toFixed(3)}s  ` +
      `sectors ${sectorSum.toFixed(3)}s  internal ${internalError.toFixed(4)}s  ` +
      `coverage ${(coverage * 100).toFixed(1)}%  ` +
      `worst sector ${biggestSwing.toFixed(3)}s  line gap ${comparison.line.medianDeviation}u`,
  );
}

console.log(
  failures === 0
    ? "\nall pairs consistent"
    : `\n${failures} pair(s) inconsistent — the alignment is placing ticks wrongly`,
);
process.exitCode = failures === 0 ? 0 : 1;
