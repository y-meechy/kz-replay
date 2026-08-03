import assert from "node:assert/strict";
import test from "node:test";
import { runTool } from "./toolProcess.js";

test("external tools are terminated after their configured timeout", async () => {
  await assert.rejects(
    runTool(
      process.execPath,
      ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
      { timeout: 50 },
    ),
    (error) => error.killed === true || error.signal === "SIGTERM",
  );
});
