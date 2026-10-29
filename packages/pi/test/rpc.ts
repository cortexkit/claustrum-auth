import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killTree } from '../../opencode/test/v2/e2e/host.ts'

export interface RpcRecord {
  type: string
  id?: string
  [key: string]: unknown
}

export const runningPi = new Set<PiRpc>()

/** A Pi RPC client shared by the real-host tests and the operator smoke. */
export class PiRpc {
  readonly records: RpcRecord[] = []
  readonly notices: string[] = []
  readonly confirms: { title: string; message: string }[] = []
  stderr = ''
  #child: ChildProcess
  #buffer = ''
  #next = 0
  confirm: boolean | undefined
  exited: Promise<number | null>

  constructor(child: ChildProcess, confirm: boolean | undefined) {
    this.#child = child
    this.confirm = confirm
    // Decode privately so another listener can retain the exact output bytes.
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    child.stdout?.on('data', (data: Buffer) => this.#read(stdout.write(data)))
    child.stderr?.on('data', (data: Buffer) => {
      this.stderr += stderr.write(data)
    })
    this.exited = new Promise((resolve) => child.on('exit', resolve))
    runningPi.add(this)
    child.on('exit', () => runningPi.delete(this))
    child.on('error', () => {
      if (child.pid === undefined) runningPi.delete(this)
    })
  }

  get pid() {
    return this.#child.pid ?? -1
  }

  #read(data: string) {
    this.#buffer += data
    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index < 0) return
      const line = this.#buffer.slice(0, index).replace(/\r$/u, '')
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line.trim()) continue
      let record: RpcRecord
      try {
        record = JSON.parse(line) as RpcRecord
      } catch {
        this.#child.kill()
        return
      }
      this.records.push(record)
      if (record.type !== 'extension_ui_request') continue
      if (record.method === 'notify') this.notices.push(String(record.message))
      if (record.method === 'confirm') {
        this.confirms.push({
          title: String(record.title),
          message: String(record.message),
        })
        if (this.confirm !== undefined)
          this.#write({
            type: 'extension_ui_response',
            id: record.id,
            confirmed: this.confirm,
          })
      }
    }
  }

  #write(value: unknown) {
    this.#child.stdin?.write(`${JSON.stringify(value)}\n`)
  }

  async waitFor(
    predicate: (record: RpcRecord) => boolean,
    from = 0,
    timeoutMs = 30_000,
  ) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.records.slice(from).find(predicate)
      if (found) return found
      if (this.#child.exitCode !== null || this.#child.signalCode !== null)
        throw new Error(
          `Pi exited (${this.#child.exitCode ?? this.#child.signalCode}): ${this.stderr}\n${JSON.stringify(this.records.slice(-3))}`,
        )
      await Bun.sleep(10)
    }
    throw new Error(
      `Timed out; last records: ${JSON.stringify(this.records.slice(-4))}\n${this.stderr}`,
    )
  }

  async command(command: Record<string, unknown>) {
    const id = `c${this.#next++}`
    this.#write({ ...command, id })
    const response = await this.waitFor(
      (record) => record.type === 'response' && record.id === id,
    )
    if (response.success === false)
      throw new Error(`${command.type} failed: ${response.error}`)
    return response.data as Record<string, unknown> | undefined
  }

  /** Run a slash command and wait for the notice it ends with. */
  async slash(text: string) {
    const before = this.notices.length
    const data = await this.command({ type: 'prompt', message: text })
    if (data?.disposition !== 'handled')
      throw new Error(`${text} was not handled: ${JSON.stringify(data)}`)
    const deadline = Date.now() + 30_000
    while (this.notices.length === before && Date.now() < deadline)
      await Bun.sleep(10)
    return this.notices.slice(before).join('\n')
  }

  /** Select a model, send one prompt and return the assistant's last message. */
  async turn(
    providerId: string,
    modelId: string,
    message = 'hello',
    thinkingLevel?: 'off',
  ) {
    await this.command({ type: 'set_model', provider: providerId, modelId })
    // Model selection can restore a saved thinking level. Apply an explicit
    // turn override after selecting the model, before any prompt is sent.
    if (thinkingLevel)
      await this.command({ type: 'set_thinking_level', level: thinkingLevel })
    const from = this.records.length
    await this.command({ type: 'prompt', message })
    await this.waitFor((record) => record.type === 'agent_settled', from)
    const ends = this.records
      .slice(from)
      .filter(
        (record) =>
          record.type === 'message_end' &&
          (record.message as { role?: string }).role === 'assistant',
      )
    const last = ends.at(-1)?.message as
      | {
          content: { type: string; text?: string }[]
          stopReason?: string
          errorMessage?: string
        }
      | undefined
    if (!last) throw new Error('no assistant message')
    return {
      text: last.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
      stopReason: last.stopReason,
      error: last.errorMessage ?? '',
    }
  }

  async models() {
    const data = await this.command({ type: 'get_available_models' })
    return ((data?.models ?? []) as { provider: string; id: string }[]).map(
      (model) => `${model.provider}/${model.id}`,
    )
  }

  /** Everything Pi printed, to search for leaked secrets. */
  output() {
    return `${JSON.stringify(this.records)}\n${this.stderr}`
  }

  async stop() {
    if (this.#child.exitCode !== null) return
    this.#child.stdin?.end()
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && this.#child.pid)
        killTree(this.#child.pid)
      else this.#child.kill()
    }, 10_000)
    await this.exited
    clearTimeout(timer)
  }

  kill() {
    this.#child.kill('SIGKILL')
    return this.exited
  }
}
