#!/usr/bin/env bun
// An installed tree can drift from manifest ranges even with a frozen lockfile.
// Before building, check installed dependency versions against manifest ranges.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SECTIONS = ['dependencies', 'devDependencies']
// These ranges name no registry version that can be compared directly.
const UNVERSIONED = /^(workspace:|file:|link:|git|github:|https?:|npm:)/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageDirs(root) {
  const dirs = [root]
  const packages = join(root, 'packages')
  function walk(parent) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist'
      )
        continue
      const dir = join(parent, entry.name)
      if (existsSync(join(dir, 'package.json'))) {
        const workspace = parent === packages
        if (workspace || existsSync(join(dir, 'node_modules'))) dirs.push(dir)
      }
      walk(dir)
    }
  }
  walk(packages)
  return dirs
}

// Follow Node's nearest node_modules lookup without relying on package exports.
function installedVersion(fromDir, name) {
  let dir = fromDir
  while (true) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return readJson(manifest).version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function checkInstalledRanges(root = resolve(import.meta.dir, '..')) {
  const problems = []
  let checked = 0
  for (const dir of packageDirs(root)) {
    const manifest = readJson(join(dir, 'package.json'))
    const label = manifest.name ?? dir
    for (const section of SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (UNVERSIONED.test(range)) continue
        const version = installedVersion(dir, name)
        checked += 1
        if (version === undefined) {
          problems.push(`${label}: ${name} (${range}) is not installed`)
        } else if (!Bun.semver.satisfies(version, range)) {
          problems.push(
            `${label}: ${name} is installed at ${version}, outside the declared ${range}`,
          )
        }
      }
    }
  }

  if (problems.length > 0)
    throw new Error(
      `Installed dependencies do not match their declared ranges:\n${problems.join('\n')}`,
    )
  console.log(`installed ranges ok (${checked} dependencies checked)`)
  return checked
}

if (import.meta.main) checkInstalledRanges()
