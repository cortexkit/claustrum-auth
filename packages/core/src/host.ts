// Mirrors common-auth's hasVaultHost until its public export arrives in 0.41.0.
export function hasVaultHost(): boolean {
  return process.env.CORTEXKIT_VAULT_HOST === 'thalamus'
}
