import { expect, test } from 'bun:test'
import plugin from '../src/index.ts'
import server from '../src/server.ts'

test('OpenCode 1 loads a no-op plugin returning empty hooks', async () => {
  expect(plugin.id).toBe('cortexkit.claustrum-auth')
  expect(await plugin.server()).toEqual({})
})

test('OpenCode 2 loads a distinct server plugin sharing the legacy hooks', () => {
  expect(server.id).toBe('cortexkit.claustrum-auth')
  expect(server.server).toBe(plugin.server)
  expect(server.setup).toBeFunction()
})
