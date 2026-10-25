export const runtimeExternals = [
  '@cortexkit/claustrum-client',
  '@cortexkit/subc-client',
  '@cortexkit/private-files',
]

export const bundleOptions = {
  target: 'node' as const,
  format: 'esm' as const,
  splitting: false,
  external: runtimeExternals,
}
