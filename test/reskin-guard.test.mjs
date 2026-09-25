import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'style.css'), 'utf8');

describe('reskin guard — Hermes tokens', () => {
  it("contains accent '#7FD4C1'", () => {
    assert.ok(css.includes('#7FD4C1'), "missing '#7FD4C1' in style.css");
  });

  it("contains border '#262B33'", () => {
    assert.ok(css.includes('#262B33'), "missing '#262B33' in style.css");
  });

  it("contains font 'IBM Plex Sans KR'", () => {
    assert.ok(css.includes('IBM Plex Sans KR'), "missing 'IBM Plex Sans KR' in style.css");
  });

  it("contains font 'JetBrains Mono'", () => {
    assert.ok(css.includes('JetBrains Mono'), "missing 'JetBrains Mono' in style.css");
  });
});
