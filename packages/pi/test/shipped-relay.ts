import { onTestFinished } from 'bun:test'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import path from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { writeJsonAtomic } from '@cortexkit/common-auth/fs'

/** A Subc wire adapter over the existing HTTP fake, for the shipped client. */
export async function shippedRelay(dir: string, vaultUrl: string) {
  const key = randomBytes(32)
  const daemonId = randomBytes(16)
  const sockets = new Set<Socket>()
  const methods: string[] = []
  const errors: string[] = []
  const proof = (domain: string, cn: Buffer, sn: Buffer) =>
    createHmac('sha256', key)
      .update(domain)
      .update(cn)
      .update(sn)
      .update(daemonId)
      .digest()
  const rpc = async (method: string, params: Record<string, unknown>) => {
    methods.push(method)
    if (Object.hasOwn(params, 'enrollment_token'))
      throw new Error('host read an enrollment token')
    const op =
      method === 'credential.list_scoped'
        ? 'list'
        : method === 'credential.get_scoped'
          ? 'get'
          : 'report'
    const response = await fetch(`${vaultUrl}/${op}`, {
      method: 'POST',
      body: JSON.stringify({ credentialId: params.credential_id }),
    })
    const value = await response.json()
    if (op === 'list')
      return {
        result: {
          view: value.view,
          credentials: (value.rows as ScopedInventoryRow[]).map((row) => ({
            id: row.id,
            type: row.credentialType,
            categories: row.categories,
            serves: row.serves,
            provider_ids: row.providerIds,
            auth_method: row.authMethod,
            state: row.state,
            record_version: row.recordVersion,
            operations: row.operations,
            account_id: row.accountId,
          })),
        },
      }
    if (op === 'get')
      return {
        result: {
          credential_id: value.credentialId,
          payload: [...Buffer.from(value.material)],
          account_id: value.accountId,
          record_version: value.recordVersion,
          expires_at_ms: value.expiresAtMs,
        },
      }
    return { result: null }
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let bytes = Buffer.alloc(0)
    let phase = 0
    let expected = Buffer.alloc(0)
    const auth = (body: unknown) => {
      const json = Buffer.from(JSON.stringify(body))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(json.length)
      socket.write(Buffer.concat([prefix, json]))
    }
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      while (bytes.length >= (phase < 2 ? 4 : 21)) {
        const headerLength = phase < 2 ? 4 : 21
        const length = bytes.readUInt32LE(0)
        if (bytes.length < headerLength + length) return
        const header = Buffer.from(bytes.subarray(0, headerLength))
        const body = bytes.subarray(headerLength, headerLength + length)
        bytes = bytes.subarray(headerLength + length)
        if (phase < 2) {
          const message = JSON.parse(body.toString())
          if (phase === 0) {
            const cn = Buffer.from(message.client_nonce)
            const sn = randomBytes(32)
            expected = proof('subc-client-v1', cn, sn)
            auth({
              daemon_id: [...daemonId],
              server_nonce: [...sn],
              daemon_ver: 'test',
              server_proof: [...proof('subc-server-v1', cn, sn)],
            })
          } else if (
            !timingSafeEqual(expected, Buffer.from(message.client_auth))
          ) {
            socket.destroy()
            return
          }
          phase++
          continue
        }
        if (header[5] !== 0) continue
        const request = JSON.parse(body.toString())
        const pending =
          header.readUInt16LE(7) === 0
            ? Promise.resolve(
                request.op === 'route.open'
                  ? { route_channel: 1, route_epoch: 1 }
                  : {},
              )
            : rpc(request.method, request.params ?? {})
        void pending
          .then((reply) => {
            const payload = Buffer.from(JSON.stringify(reply))
            header.writeUInt32LE(payload.length, 0)
            header[5] = 1
            header[6] = 0
            socket.write(Buffer.concat([header, payload]))
          })
          .catch((error) => {
            errors.push(String(error))
            socket.destroy()
          })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('no fake relay address')
  const connectionFile = path.join(dir, 'connection.json')
  await writeJsonAtomic(connectionFile, {
    schema: 1,
    wire_version: 2,
    endpoints: [{ host: '127.0.0.1', port: address.port }],
    key: [...key],
    daemon_id: [...daemonId],
    pid: process.pid,
  })
  return { connectionFile, methods, errors }
}
