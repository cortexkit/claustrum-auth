import { execFileSync } from 'node:child_process'

// A successful run can still contain skipped jobs. Require every matrix entry
// from ci.yml rather than trusting the workflow's overall conclusion alone.
export const requiredCiJobs = [
  ...[
    'check',
    'setup-menu',
    'pi-e2e',
    'opencode1-e2e',
    'opencode2-e2e',
  ].flatMap((job) =>
    ['ubuntu-latest', 'macos-latest', 'windows-latest'].map(
      (os) => `${job} (${os})`,
    ),
  ),
  ...['windows-latest', 'windows-2022'].map(
    (os) => `pi-windows-private-files (${os})`,
  ),
]

class TransientApiError extends Error {}

// A local release has no token in its environment. Some managed shells refuse
// `gh auth token`, so let the gh CLI make each read itself and report the HTTP
// status from its `--include` output. A missing or refused gh reads as status
// 0, which fails the check at once instead of retrying.
/**
 * @param {string} url
 * @param {(file: string, args: string[], options: { encoding: 'utf8' }) => string} [run]
 * @returns {Promise<Response>} only `ok`, `status` and `json` are provided
 */
export function ghCliFetch(url, run = execFileSync) {
  const { pathname, search } = new URL(url)
  let output
  try {
    output = run('gh', ['api', '--include', `${pathname}${search}`], {
      encoding: 'utf8',
    })
  } catch (error) {
    output = typeof error?.stdout === 'string' ? error.stdout : ''
  }
  const status = Number(/^HTTP\/\S+ (\d{3})/u.exec(output)?.[1] ?? 0)
  const separator = /\r?\n\r?\n/u.exec(output)
  const body = separator ? output.slice(separator.index).trim() : ''
  return Promise.resolve(
    /** @type {Response} */ (
      /** @type {unknown} */ ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(body),
      })
    ),
  )
}

export async function verifyReleaseCi({
  sha,
  token,
  repository = 'cortexkit/claustrum-auth',
  apiUrl = 'https://api.github.com',
  wait = false,
  fetchImpl = (url, init) => fetch(url, init),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30 * 60 * 1000,
}) {
  if (!/^[0-9a-f]{40}$/iu.test(sha) || !token)
    throw new Error('A full TARGET_SHA and GitHub token are required')
  const deadline = now() + timeoutMs
  async function getJson(endpoint) {
    let response
    try {
      response = await fetchImpl(`${apiUrl}/repos/${repository}${endpoint}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new TransientApiError(
        `GitHub API connection failed: ${error.message}`,
      )
    }
    if (response.status >= 500 || response.status === 429)
      throw new TransientApiError(`GitHub API returned HTTP ${response.status}`)
    if (!response.ok)
      throw new Error(`GitHub API returned HTTP ${response.status}`)
    return response.json()
  }

  while (now() < deadline) {
    try {
      const query = new URLSearchParams({ head_sha: sha, per_page: '100' })
      const result = await getJson(`/actions/workflows/ci.yml/runs?${query}`)
      const run = result.workflow_runs
        .filter(
          (run) =>
            run.head_sha === sha &&
            run.head_branch === 'main' &&
            run.event === 'push',
        )
        .sort((left, right) => right.run_number - left.run_number)[0]
      if (run?.status === 'completed') {
        if (run.conclusion !== 'success')
          throw new Error(
            `CI run ${run.id} concluded ${run.conclusion}; release blocked`,
          )
        const { jobs } = await getJson(
          `/actions/runs/${run.id}/jobs?per_page=100&filter=latest`,
        )
        const unsuccessful = requiredCiJobs.filter(
          (name) =>
            !jobs.some(
              (job) => job.name === name && job.conclusion === 'success',
            ),
        )
        if (unsuccessful.length)
          throw new Error(
            `Required CI jobs missing or unsuccessful: ${unsuccessful.join(', ')}`,
          )
        console.log(
          `CI run ${run.id} passed all ${requiredCiJobs.length} required jobs on ${sha}.`,
        )
        return
      }
      if (!wait)
        throw new Error(
          `CI has not passed on exact HEAD ${sha}; release blocked`,
        )
    } catch (error) {
      // Retry dropped connections, 429 and 5xx, but never
      // hide a bad token (401), missing workflow (404), or failed CI behind a wait.
      if (!(error instanceof TransientApiError)) throw error
      console.log(`${error.message}; retrying.`)
    }
    const remaining = deadline - now()
    if (remaining > 0) await sleep(Math.min(15_000, remaining))
  }
  throw new Error(
    `Timed out waiting for successful CI on ${sha}; release blocked`,
  )
}

if (import.meta.main) {
  if (
    process.argv.slice(2).some((arg) => arg !== '--wait') ||
    process.argv.length > 3
  )
    throw new Error('Usage: verify-release-ci.mjs [--wait]')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  await verifyReleaseCi({
    sha: process.env.TARGET_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
    // Without a token the gh CLI authenticates each read; the placeholder only
    // satisfies the token check and is never sent.
    token: token || 'gh-cli',
    ...(token ? {} : { fetchImpl: ghCliFetch }),
    wait: process.argv.includes('--wait'),
  })
}
