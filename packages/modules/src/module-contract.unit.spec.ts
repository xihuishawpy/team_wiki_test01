import { describe, expect, it } from 'vitest';

import { moduleCatalog, type ModuleName } from './module-contract.js';

describe('module catalog', () => {
  it('declares each module once and references only public module names', () => {
    const names = moduleCatalog.map((module) => module.name);
    const knownNames = new Set<ModuleName>(names);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(9);
    for (const module of moduleCatalog) {
      for (const dependency of module.moduleDependencies) {
        expect(knownNames.has(dependency)).toBe(true);
      }
    }
  });
});
