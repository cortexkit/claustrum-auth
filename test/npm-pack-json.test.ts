import { expect, test } from 'bun:test'
import { packedRecords } from '../scripts/npm-pack-json.ts'

// Record shapes as printed by real `npm pack --json --dry-run`: npm 11.19.1
// prints an array, npm 12.2.1 an object keyed by package name.
const record = {
  id: 'probe-pkg@1.0.0',
  name: 'probe-pkg',
  filename: 'probe-pkg-1.0.0.tgz',
  files: [{ path: 'index.js' }, { path: 'package.json' }],
}

test('packedRecords reads npm 11 arrays and npm 12 objects alike', () => {
  expect(packedRecords([record])).toEqual([record])
  expect(packedRecords({ 'probe-pkg': record })).toEqual([record])
  expect(packedRecords(null)).toEqual([])
  expect(packedRecords('probe-pkg')).toEqual([])
})
