import { expect, test } from 'bun:test'
import plugin from '../src/index.ts'
import server from '../src/server.ts'

test('OpenCode 1 loads the claustrum-auth plugin under its own id', () => {
  expect(plugin.id).toBe('cortexkit.claustrum-auth')
  expect(plugin.id).not.toBe('opencode-claustrum')
  expect(typeof plugin.server).toBe('function')
})

test('OpenCode 2 loads a distinct server plugin sharing the legacy hooks', () => {
  expect(server.id).toBe('cortexkit.claustrum-auth')
  expect(server.server).toBe(plugin.server)
  expect(server.setup).toBeFunction()
})
