export const runtimeExternals = [
  '@cortexkit/claustrum-client',
  '@cortexkit/subc-client',
  '@cortexkit/private-files',
]

export const bundleOptions = {
  target: 'node' as const,
  format: 'esm' as const,
  splitting: false,
  // Setup is Node-compatible as published; bundling its JSONC parser would
  // leave CommonJS relative requires pointing into the plugin's dist folder.
  external: [...runtimeExternals, '@cortexkit/common-auth/setup'],
}
