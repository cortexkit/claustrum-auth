import { readFile } from 'node:fs/promises'

const [, , file, flag, pattern] = process.argv
if (!file || flag !== '-t' || !pattern)
  throw new Error('Expected a test file and -t pattern')
const catalogue = Bun.TOML.parse(await readFile('mutations.toml', 'utf8')) as {
  control: {
    id: string
    file: string
    test_file: string
    old: string
    new: string
    expect_red: string[]
  }[]
}
// Print the matching mutation source before starting the test. Multiple
// mutation entries may intentionally exercise the same test.
for (const row of catalogue.control) {
  if (
    row.test_file !== file.replace(/^\.\//u, '') ||
    !row.expect_red.some(
      (name) => name === pattern || name.slice(1, -1) === pattern,
    )
  )
    continue
  const source = await readFile(row.file, 'utf8')
  const offset = source.indexOf(source.includes(row.new) ? row.new : row.old)
  if (offset < 0) throw new Error(`Missing mutation anchor: ${row.id}`)
  const first = source.slice(0, offset).split('\n').length
  const count = (source.includes(row.new) ? row.new : row.old).split(
    '\n',
  ).length
  const lines = source.split('\n')
  for (let index = first - 1; index < first - 1 + count; index++) {
    console.log(
      `MUTATION_SOURCE ${row.id} ${row.file}:${index + 1}: ${lines[index]}`,
    )
  }
}
const child = Bun.spawn([process.execPath, 'test', file, '-t', pattern], {
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
