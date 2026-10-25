import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

/** Compare numeric release versions recorded in npm's lockfile. */
function atLeast(actual: string, minimum: string): boolean {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }
  return true;
}

describe('security dependency compatibility', () => {
  for (const [name, minimum] of [['body-parser', '2.4.0'], ['zod', '4.6.6'], ['fast-uri', '3.1.9']]) {
    it(`keeps every ${name} instance outside the reviewed vulnerable range`, () => {
      const packages = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
      expect(packages.length).toBeGreaterThan(0);
      for (const [path, entry] of packages) {
        const version = (entry as { version: string }).version;
        expect(atLeast(version, minimum!), `${path}@${version}`).toBe(true);
      }
    });
  }

  it('rejects an oversized bounded array before validating every element', () => {
    let visited = 0;
    const schema = z.array(z.preprocess((value) => { visited += 1; return value; }, z.string())).max(2);
    const result = schema.safeParse([1, 2, 3, 4]);
    expect(result.success).toBe(false);
    expect(visited).toBe(0);
  });

  it('keeps string-keyed records and stripping object behavior', () => {
    const schema = z.object({ values: z.record(z.string(), z.string()) });
    expect(schema.parse({ values: { arbitrary: 'value' }, extra: true })).toEqual({ values: { arbitrary: 'value' } });
    expect(schema.safeParse({ values: { arbitrary: 42 } }).success).toBe(false);
  });
});
