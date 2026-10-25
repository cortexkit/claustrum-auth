import { expect, test } from 'bun:test'
import {
  command,
  opencodeEnrollment,
  piEnrollment,
  pluginId,
} from '../test-entry.ts'

test('scaffold identity stays separate from the retired Claustrum plugin', () => {
  expect(pluginId).toBe('cortexkit.claustrum-auth')
  expect(command).toBe('/claustrum')
  expect(opencodeEnrollment).toBe('claustrum-auth-opencode')
  expect(piEnrollment).toBe('claustrum-auth-pi')
})
