import { expect, test } from 'bun:test'
import { startupError } from './startup-error.ts'

test('startup diagnostics retain wrapped native load and private-path refusal details', () => {
  const native = Object.assign(new Error('private path refused'), {
    code: 'ERR_PRIVATE_FILES_INSECURE',
    win32Code: 5,
    path: 'C:\\Users\\RUNNER~1\\Temp\\state',
    reason: 'unsafe ancestor',
  })
  const error = new Error('enrollment token could not be written', {
    cause: native,
  })
  expect(JSON.parse(JSON.stringify(startupError(error)))).toMatchObject({
    name: 'Error',
    message: 'enrollment token could not be written',
    stack: expect.any(String),
    cause: {
      message: 'private path refused',
      code: 'ERR_PRIVATE_FILES_INSECURE',
      win32Code: 5,
      path: 'C:\\Users\\RUNNER~1\\Temp\\state',
      reason: 'unsafe ancestor',
    },
  })
  expect(startupError('non-Error refusal')).toBe('non-Error refusal')
})
