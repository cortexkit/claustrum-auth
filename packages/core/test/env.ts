import { onTestFinished } from 'bun:test'

const previous = new Map<string, string | undefined>()
let restoring = false

export function setTestEnv(name: string, value: string | undefined) {
  if (!previous.has(name)) previous.set(name, process.env[name])
  if (!restoring) {
    restoring = true
    onTestFinished(() => {
      for (const [key, original] of previous) {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
      }
      previous.clear()
      restoring = false
    })
  }
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
