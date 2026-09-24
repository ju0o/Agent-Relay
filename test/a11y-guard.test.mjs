import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'style.css'), 'utf8');
const controlRoom = fs.readFileSync(
  path.join(here, '..', 'src', 'frontend', 'controlRoom.tsx'),
  'utf8',
);

describe('a11y guard — keyboard focus visibility', () => {
  it('defines a global :focus-visible outline', () => {
    assert.ok(css.includes(':focus-visible'), 'missing ":focus-visible" in style.css');
  });

  it('has no bare "outline: none;" outside a :not(:focus-visible) selector', () => {
    const blocks = css.split('}');
    const bare = [];
    for (const block of blocks) {
      const parts = block.split('{');
      if (parts.length < 2) continue;
      const selector = parts[0];
      const body = parts.slice(1).join('{');
      if (/outline\s*:\s*none\s*;?/.test(body)) {
        if (!/:not\(\s*:focus-visible\s*\)/.test(selector) && !/:focus-visible/.test(selector)) {
          bare.push(selector.trim());
        }
      }
    }
    assert.deepEqual(bare, [], `bare "outline: none" without :not(:focus-visible): ${bare.join(' | ')}`);
  });

  it('controlRoom tabs expose aria-selected', () => {
    assert.ok(controlRoom.includes('aria-selected'), 'missing "aria-selected" in controlRoom.tsx');
  });
});
