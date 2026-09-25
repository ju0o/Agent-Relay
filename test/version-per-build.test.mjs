/* Version per build — pure helper tests.
   versionForBuildCount maps a build number N to '0.3.<N>'; the window title
   helper must carry that version ('Agent Relay 0.3.N') so installers can be
   told apart. Runs against the compiled shared module
   (dist/server/shared/types.js), mirroring test/start-view.test.mjs
   conventions; the script export must agree with the shared helper. */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  versionForBuildCount,
  windowTitleForVersion,
} from "../dist/server/shared/types.js";
import { versionForBuildCount as scriptVersionForBuildCount } from "../scripts/next-version.mjs";

test("versionForBuildCount — N maps to 0.3.<N>", () => {
  assert.equal(versionForBuildCount(0), "0.3.0");
  assert.equal(versionForBuildCount(1), "0.3.1");
  assert.equal(versionForBuildCount(11), "0.3.11");
  assert.equal(versionForBuildCount(102), "0.3.102");
});

test("versionForBuildCount — floors and clamps bad input", () => {
  assert.equal(versionForBuildCount(3.9), "0.3.3");
  assert.equal(versionForBuildCount(-5), "0.3.0");
  assert.equal(versionForBuildCount(Number.NaN), "0.3.0");
  assert.equal(versionForBuildCount("12"), "0.3.0");
});

test("windowTitleForVersion — title includes the version", () => {
  assert.equal(windowTitleForVersion("0.3.11"), "Agent Relay 0.3.11");
  assert.equal(
    windowTitleForVersion(versionForBuildCount(102)),
    "Agent Relay 0.3.102",
  );
  assert.match(windowTitleForVersion("0.3.7"), /0\.3\.7/);
});

test("scripts/next-version.mjs — pure computation agrees with shared helper", () => {
  for (const n of [0, 1, 11, 102]) {
    assert.equal(scriptVersionForBuildCount(n), versionForBuildCount(n));
  }
});

test("main process — visible window title carries the version", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mainTs = fs.readFileSync(path.join(root, "src/backend/main.ts"), "utf8");
  assert.match(
    mainTs,
    /setTitle\(windowTitleForVersion\(app\.getVersion\(\)\)\)/,
    "main.ts should set the window title from the app version",
  );
});
