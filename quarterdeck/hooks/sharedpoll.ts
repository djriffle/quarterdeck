import type { update } from 'claude-code'

// Polls shared by every session of this mod on the machine (and on any node that shares $HOME).
//
// Each poll keeps one result file under ~/.claude/mods-data/quarterdeck/shared/. Every session reads
// it on its own beat; only the session that wins the poll's lock runs the command, once the result is
// `everyMs` old (`backoffMs` after `failsBeforeBackoff` failures in a row; the backoff is shared too).
// The lock is a directory, since `mkdir` succeeds for one caller only. The result is written inside
// the lock and moved into place with `mv`, so a reader never sees half a file.

type Engine = Parameters<typeof update>[0]

export type Shared<T> = { lastAt: number; failures: number; value?: T; error?: string }

export type SharedPollSpec<T> = {
  // The result file's name: a stable key, made safe with `sharedKey`.
  key: string
  everyMs: number
  backoffMs?: number
  failsBeforeBackoff?: number
  // How long one call may hold the lock before another session clears it as left by a dead one.
  lockStaleMs: number
  // The poll itself. A throw counts as a failure: its message becomes `error` and the last value is kept.
  compute: (prev: T | undefined) => Promise<T>
  errorText?: (err: unknown) => string
}

// Whether the shared result is old enough that a session should poll again.
export const isDue = (s: Shared<unknown> | undefined, now: number, everyMs: number, backoffMs = everyMs, failsBeforeBackoff = 2) =>
  !s || now - s.lastAt >= (s.failures >= failsBeforeBackoff ? backoffMs : everyMs)

// A failed poll keeps the last value known and counts one more failure in a row.
export const failed = <T>(prev: Shared<T> | undefined, now: number, error: string): Shared<T> => ({
  lastAt: now,
  failures: (prev?.failures ?? 0) + 1,
  value: prev?.value,
  error,
})

// A file-name-safe key for a path: its readable tail plus a hash of the whole.
export const sharedKey = (kind: string, path: string) => {
  let h = 5381
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0
  const tail = path.replace(/\/+$/, '').split('/').slice(-2).join('_').replace(/[^A-Za-z0-9_.-]/g, '_')
  return `${kind}-${tail}-${h.toString(36)}`
}

let sharedDir: string | undefined
async function dirOf($: Engine) {
  if (sharedDir) return sharedDir
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set: cannot place shared poll results under ~/.claude/mods-data')
  const dir = `${home.replace(/\/+$/, '')}/.claude/mods-data/quarterdeck/shared`
  await sh($, ['mkdir', '-p', dir])
  sharedDir = dir
  return dir
}

async function sh($: Engine, argv: string[]) {
  const r = await $.process.run(argv)
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
}

// Keys this process is polling right now: a beat that lands meanwhile only reads.
const running = new Set<string>()

// One beat of a shared poll: read the shared result, poll if it is due (or `force`) and the lock is
// free, and resolve to the newest result (undefined before any session has polled).
export async function sharedPoll<T>($: Engine, spec: SharedPollSpec<T>, force = false): Promise<Shared<T> | undefined> {
  const dir = await dirOf($)
  const path = `${dir}/${spec.key}.json`
  const shared = (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Shared<T>) : undefined
  if (running.has(spec.key)) return shared
  if (!force && !isDue(shared, Date.now(), spec.everyMs, spec.backoffMs, spec.failsBeforeBackoff)) return shared
  const lock = `${dir}/${spec.key}.lock`
  if ((await $.process.run(['mkdir', lock])).exitCode !== 0) {
    // Another session is polling; its result is read on a later beat.
    if ((await $.fs.exists(lock)) && Date.now() - (await $.fs.stat(lock)).mtimeMs > spec.lockStaleMs) await sh($, ['rm', '-rf', lock])
    return shared
  }
  running.add(spec.key)
  try {
    const now = Date.now()
    let result: Shared<T>
    try {
      result = { lastAt: now, failures: 0, value: await spec.compute(shared?.value) }
    } catch (err) {
      result = failed(shared, now, spec.errorText ? spec.errorText(err) : err instanceof Error ? err.message : String(err))
    }
    const staged = `${lock}/result.json`
    await $.fs.write(staged, JSON.stringify(result))
    await sh($, ['mv', '-f', staged, path])
    return result
  } finally {
    running.delete(spec.key)
    await sh($, ['rm', '-rf', lock])
  }
}
