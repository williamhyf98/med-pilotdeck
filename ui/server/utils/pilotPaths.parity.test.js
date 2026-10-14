import { describe, expect, it } from 'vitest';
import * as js from './pilotPaths.js';
import * as ts from '../../../src/pilot/paths.ts';

describe('JS/TS path parity for user homes', () => {
  it.each([['1', '/srv/pd'], ['42', '/Users/x/.pilotdeck-home'], ['7', '~/.pilotdeck']])('userId=%s root=%s', (id, home) => {
    const env = { PILOT_HOME: home };
    expect(js.resolveUserHome(id, env)).toBe(ts.resolveUserHome(id, env));
    expect(js.resolveTypedProjectDir('general_med-abc', js.resolveUserHome(id, env)))
      .toBe(ts.resolveTypedProjectDir('general_med-abc', ts.resolveUserHome(id, env)));
  });
});
