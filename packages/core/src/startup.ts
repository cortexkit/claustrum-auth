// Startup errors cross the host's UI/log boundary. Only local, fixed labels and
// known filesystem codes are safe there: messages, paths and causes may contain
// credentials or text supplied by a provider.
const steps = {
  'pi-models': [
    'read the Pi model catalog and models.json',
    'Check models.json for invalid or empty provider definitions, then restart Pi.',
  ],
  'pi-state': [
    'open the Pi claustrum-auth state folder',
    'Check that the claustrum-auth folder in the Pi agent folder is owned by your user, owner-only and writable, then restart Pi.',
  ],
  'pi-register': [
    'register Pi providers from models.json and the model catalog',
    'Check models.json for invalid or empty provider definitions, then restart Pi.',
  ],
  'pi-start': [
    'initialize the Pi extension',
    'Check the Pi agent folder and its claustrum-auth state folder for ownership and write access, then restart Pi. If it persists, reinstall the plugin.',
  ],
  'opencode-state-lock': [
    'lock config-dir.json in the OpenCode claustrum-auth state folder',
    'Close other OpenCode sessions and check that the state folder is owned by your user, owner-only and writable, then restart OpenCode.',
  ],
  'opencode-state-read': [
    'read config-dir.json in the OpenCode claustrum-auth state folder',
    'Check that config-dir.json is a readable regular file owned by your user, then restart OpenCode.',
  ],
  'opencode-state-write': [
    'write config-dir.json in the OpenCode claustrum-auth state folder',
    'Check that the state folder is owned by your user, owner-only and writable, then restart OpenCode.',
  ],
  'opencode-binding': [
    'bind config-dir.json to the OpenCode config folder',
    'The state directory belongs to a different OpenCode config directory. Restore the matching config-folder setting or enroll the intended profile with setup, then restart OpenCode. Do not copy enrollment files between profiles.',
  ],
  'opencode-start': [
    'initialize the OpenCode plugin',
    'Check the OpenCode config and claustrum-auth state folders for ownership and write access, then restart OpenCode. If it persists, reinstall the plugin.',
  ],
} as const
type StartupStep = keyof typeof steps

const reasons: Readonly<Record<string, string>> = {
  EACCES: 'Access was denied.',
  EPERM: 'Access was denied.',
  ENOTDIR: 'A folder component is not a directory.',
  EISDIR: 'A file was expected, but a directory was found.',
  ENOENT: 'A required file or folder is missing.',
  EROFS: 'The filesystem is read-only.',
  ENOSPC: 'The filesystem has no space left.',
  ELOCKED: 'Another session holds the lock.',
  ERR_PRIVATE_FILES_INSECURE:
    'The file or folder is not private to the current user.',
}

class StartupRefusal extends Error {}

export function startupRefusal(step: StartupStep, error?: unknown): Error {
  let reason = ''
  try {
    if (error instanceof StartupRefusal) return error
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code === 'string' && Object.hasOwn(reasons, code))
      reason = ` ${reasons[code]}`
  } catch {}
  const [operation, remedy] = steps[step]
  return new StartupRefusal(
    `claustrum-auth did not start: could not ${operation}.${reason} ${remedy}`,
  )
}

export function startupSync<T>(step: StartupStep, action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw startupRefusal(step, error)
  }
}

export async function startupStep<T>(
  step: StartupStep,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw startupRefusal(step, error)
  }
}
