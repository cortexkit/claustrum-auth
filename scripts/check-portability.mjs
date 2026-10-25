import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'

export function portabilityViolations(source, filename = 'plugin.ts') {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const violations = []
  const report = (node, reason) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    violations.push(`${filename}:${line + 1}: ${reason}`)
  }
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const value = node.text
      const parent = node.parent
      const moduleSpecifier =
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node
      const moduleCall =
        ts.isCallExpression(parent) &&
        (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
          parent.expression.getText(file) === 'require')
      if (!moduleSpecifier && !moduleCall) {
        if (value.includes('~'))
          report(node, 'resolve home with os.homedir(), not ~')
        if (
          (value.includes('/') || value.includes('\\')) &&
          !/^(?:https?|wss):\/\//u.test(value) &&
          !(
            value === '/' &&
            ts.isCallExpression(parent) &&
            ts.isPropertyAccessExpression(parent.expression) &&
            ((parent.expression.name.text === 'split' &&
              parent.expression.expression
                .getText(file)
                .endsWith('.pathname')) ||
              (parent.expression.name.text === 'join' &&
                ts.isBinaryExpression(parent.parent) &&
                parent.parent.right === parent &&
                parent.parent.left.getText(file).endsWith('.pathname')))
          ) &&
          value !== '/claustrum'
        ) {
          report(node, 'build paths with path.join(), not literal separators')
        }
        if (/^0[0-7]{3,4}$/u.test(value))
          report(node, 'use common-auth writers, not POSIX modes')
      }
    }
    if (
      ts.isNumericLiteral(node) &&
      /^0[oO][0-7]+$/u.test(node.getText(file))
    ) {
      report(node, 'use common-auth writers, not POSIX modes')
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file).replace(/["']/gu, '') === 'mode'
    ) {
      report(node, 'use common-auth writers, not mode options')
    }
    if (
      ts.isCallExpression(node) &&
      /(?:^|\.)(?:chmod|chmodSync|fchmod|fchmodSync)$/u.test(
        node.expression.getText(file),
      )
    ) {
      report(node, 'use common-auth writers, not chmod')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations
}

export function checkPortability(root = process.cwd()) {
  const violations = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(filename)
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
        violations.push(
          ...portabilityViolations(
            readFileSync(filename, 'utf8'),
            path.relative(root, filename),
          ),
        )
      }
    }
  }
  for (const name of ['core', 'opencode', 'pi'])
    walk(path.join(root, 'packages', name, 'src'))
  if (violations.length) throw new Error(violations.join('\n'))
  console.log('Portability fence passed for all 3 plugin source trees.')
}

if (import.meta.main) checkPortability()
