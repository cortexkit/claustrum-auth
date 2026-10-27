import { rm } from 'node:fs/promises'
import type { HostProcess } from './host.ts'

export async function removeProfile(
  root: string,
  hosts: readonly (Pick<HostProcess, 'name' | 'tree'> & {
    child: Pick<HostProcess['child'], 'pid' | 'exitCode'>
  })[],
  remove = rm,
) {
  try {
    await remove(root, {
      recursive: true,
      force: true,
      // After process shutdown Windows can briefly retain file handles;
      // allow only a short handle-release grace, not retries for live holders.
      maxRetries: process.platform === 'win32' ? 2 : 0,
      retryDelay: 100,
    })
  } catch (error) {
    const failedPath = (error as NodeJS.ErrnoException)?.path ?? root
    const trees = await Promise.all(
      hosts.map(
        async (host) =>
          `${host.name} (pid ${host.child.pid}, exit ${host.child.exitCode}): ${
            host.tree ? await host.tree.describe() : 'no Windows process tree'
          }`,
      ),
    )
    throw new Error(
      [
        `profile removal failed; first undeleted path: ${failedPath}`,
        String(error),
        `test harness: ${process.title} (pid ${process.pid})`,
        ...trees,
      ].join('\n'),
      { cause: error },
    )
  }
}
