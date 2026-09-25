/* Source guard: no aria-label in planStudio.tsx starts with a Latin letter. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "frontend", "planStudio.tsx"), "utf8");

test("planStudio aria-labels do not start with a Latin letter", () => {
  const labels = [...src.matchAll(/aria-label=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
  assert.ok(labels.length > 0);
  // A leading English word is banned; an all-caps acronym like "PM" is allowed.
  for (const label of labels) assert.doesNotMatch(label, /^(?:[a-z]|[A-Z][a-z])/, `aria-label "${label}"`);
});

test("planStudio example placeholder is plain Korean", () => {
  assert.ok(src.includes('placeholder="예: 3번 작업을 먼저 검수해 줘"'));
});
