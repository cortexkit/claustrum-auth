import { expect, test } from 'bun:test'
import { relativeImports } from '../../../scripts/copy-entry-declarations.ts'

test('an entry declaration that points at an unshipped relative file is caught', () => {
  expect(
    relativeImports(
      [
        "import type { Plugin } from '@opencode/plugin';",
        "import type { ServerDeps } from './v2/setup.ts';",
        'export type X = import("../v1/fetch.js").Fetch;',
        "import './side-effect.js';",
        "export { y } from './y.js';",
      ].join('\n'),
    ),
  ).toEqual(['./v2/setup.ts', '../v1/fetch.js', './side-effect.js', './y.js'])
  expect(
    relativeImports(
      "import type { Plugin } from '@opencode/plugin';\nexport default {};",
    ),
  ).toEqual([])
})
