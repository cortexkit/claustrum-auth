import { expect, test } from 'bun:test'
import extension from '../src/index.ts'

test('Pi loads a no-op extension without accessing the host', () => {
  expect(extension(undefined as never)).toBeUndefined()
})
