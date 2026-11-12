// Runs inside the isolated real host, before the plugin is initialized.
const mode = process.env.CLAUSTRUM_AUTH_E2E_ROUTING
if (mode) {
  Reflect.set(globalThis, Symbol.for('cortexkit.routing'), () => ({
    accountFor: async () =>
      mode === 'refuse'
        ? { refused: { code: 'account_selection_refused' } }
        : new Promise<never>(() => {}),
  }))
}
