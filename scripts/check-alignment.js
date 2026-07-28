#!/usr/bin/env node
// Sanity check for the run alignment and the section table, which have no other test.
//
// Two invariants, and they check different things.
//
// The sections must telescope: their deltas are differences of times on each run's
// own clock, so adding them up has to give the gap between the two finish times
// exactly. This catches a boundary placed out of order, or a section handed a time
// from the wrong run.
//
// The alignment is checked separately, by whether the delta curve ends up at the real
// finishing gap. That one holds only if every challenger tick is placed at the right
// point on the reference's course, so a projection that snaps forward breaks it
// loudly. That is the bug this script was originally written for.

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

  const { sections, touches, finalDelta } = comparison;
  const sectionSum = sections.reduce(
    (total, section) => total + section.delta,
    0,
  );
  // Both runs' clocks start at their first recorded tick, so the telescoping sum
  // lands on the difference in recorded length. Counted in ticks, not read off
  // durationSeconds: that one is rounded for display, and this check wants to see
  // an error of zero rather than an error of "however toFixed went".
  const tickGap =
    (challenger.timing.ticks - reference.timing.ticks) /
    reference.timing.tickRate;
  const telescopeError = Math.abs(sectionSum - tickGap);
  const reportedError = Math.abs(sectionSum - finalDelta);
  const backwards = sections.filter(
    (section) => section.referenceTime < 0 || section.challengerTime < 0,
  ).length;

  // The last curve sample is the gap at the end of the compared stretch, which is
  // where the alignment is judged rather than the sections.
  const gapAtEnd = comparison.curve.at(-1).delta;
  // How much of each run the compared stretch actually covers. A gap here is not an
  // alignment fault, it means one run's path could not be followed to the end.
  const coverage = comparison.courseLength / comparison.referenceLength;
  const finishError = Math.abs(gapAtEnd - finalDelta);

  const ok =
    telescopeError <= 1e-6 &&
    backwards === 0 &&
    reportedError <= 2 / 64 &&
    touches.matchedFraction > 0.5 &&
    coverage > 0.97 &&
    finishError <= 2 / 64 + Math.abs(finalDelta) * 0.05;
  if (!ok) failures += 1;

  console.log(
    `${ok ? "ok  " : "FAIL"} ${label.padEnd(22)} ` +
      `final ${finalDelta.toFixed(3)}s  sections ${sectionSum.toFixed(3)}s  ` +
      `telescope ${telescopeError.toExponential(0)}  ` +
      `vs reported ${reportedError.toFixed(4)}s  ` +
      `${sections.length} sections, ${(touches.landingFraction * 100).toFixed(0)}% on a landing, ` +
      `${(touches.matchedFraction * 100).toFixed(0)}% of touchdowns shared  ` +
      `gap@end ${gapAtEnd.toFixed(3)}s  coverage ${(coverage * 100).toFixed(1)}%  ` +
      `line gap ${comparison.line.medianDeviation}u`,
  );
}

console.log(
  failures === 0
    ? "\nall pairs consistent"
    : `\n${failures} pair(s) inconsistent — the sections do not add up, or the ` +
        "alignment is placing ticks wrongly",
);
process.exitCode = failures === 0 ? 0 : 1;
