import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register } from 'claude-code'

import type { WaitItem } from '../types'

// /waiting: a green box above the prompt listing the subagents still running and the background shells
// and Monitor watches still waiting. Each live row spins; a finished row draws a check mark, holds it, then leaves.
const FRAME_MS = 120
const POLL_EVERY = 4 // frames between $.agent.list() polls
const SCAN_EVERY = 16 // frames (~2 s) between transcript scans while a shell or monitor is live
const SCAN_OVERLAP = 64 * 1024 // bytes re-read before the last offset, so a notification split by a read is seen whole
const SCAN_MAX = 4 * 1024 * 1024 // most bytes one read takes (the engine's cap); a first scan starts this far from the end
const HOLD_FRAMES = 50 // ~6 s a finished row stays after its check is drawn
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The check is drawn stroke by stroke: the short down-stroke, then the long up-stroke, then it settles bold.
export const CHECK = ['⠄', '⠆', '⢆', '⢎', '⢎⠁', '⢎⠃', '⢎⠇', '✓', '✔']
export const CROSS = ['⠂', '⠢', '⠪', '✕', '✗']

const GREEN = 'rgb(130,200,125)' // desaturated green: border, ticks
const BRIGHT = 'rgb(175,235,160)'
const RED = 'rgb(225,110,100)'
const DIM = 'inactive'

const ACTIVE = new Set(['pending', 'running', 'waiting'])
// A background task listed at Stop is live only while running or pending; the list also carries
// backgrounded tasks that have already finished, with their final status.
const TASK_LIVE = new Set(['pending', 'running'])
const TOMBSTONES = 200 // ended task ids remembered so a later listing cannot re-add them as live

const waitingOn = atom({ plugin: 'quarterdeck', key: 'waiting-on' } as const, false)
const waitingPhase = atom({ plugin: 'quarterdeck', key: 'waiting-phase' } as const, 0)
// Keyed `agent:<id>` / `task:<task id>` (shells and monitors); tasks are tracked whether or not the box is shown.
const waitItems = atom({ plugin: 'quarterdeck', key: 'waiting-items' } as const, {} as Record<string, WaitItem>, { shape: 'waiting-2' })
// Ids (`task:<id>`) of tasks that have ended, oldest first, kept after their rows are pruned.
const waitEnded = atom({ plugin: 'quarterdeck', key: 'waiting-ended' } as const, [] as string[], { shape: 'waiting-ended-1' })

type Engine = Parameters<typeof update>[0]
let ticker: { cancel: () => void } | undefined
// Bytes of each transcript already scanned (main and subagents'); module-local, so a reload rescans
// the last SCAN_MAX of each, which is harmless: ending a task twice changes nothing.
const scanned = new Map<string, number>()
let scanning = false

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Fold an agent roster into the tracked items: new live agents are added, tracked ones that left the
// active states are marked ended at `phase`. Agents already finished before we saw them are ignored.
export const foldAgents = (items: Record<string, WaitItem>, agents: AgentInfo[], phase: number, now: number) => {
  const next = { ...items }
  for (const a of agents) {
    const key = `agent:${a.id}`
    const old = next[key]
    if (ACTIVE.has(a.status)) {
      if (!old || old.endedPhase !== undefined)
        next[key] = { kind: 'agent', label: oneLine(a.description || a.name || a.type), detail: a.type, startedAt: old?.startedAt ?? now }
    } else {
      if (old && old.endedPhase === undefined) next[key] = { ...old, endedPhase: phase, endedAt: now, ok: a.status === 'completed' }
      // A shell the engine ends at its subagent's final response sends no notification: it ends with the agent.
      for (const [k, v] of Object.entries(next))
        if (v.owner === a.id && v.endedPhase === undefined) next[k] = { ...v, endedPhase: phase, endedAt: now, ok: true, status: 'stopped' }
    }
  }
  return next
}

// `status` is the task's final word: completed, failed, killed or stopped. Only `failed` draws a cross.
export const endTask = (items: Record<string, WaitItem>, id: string, status: string, phase: number, now: number) => {
  const old = items[`task:${id}`]
  if (!old || old.endedPhase !== undefined) return items
  return { ...items, [`task:${id}`]: { ...old, endedPhase: phase, endedAt: now, ok: status !== 'failed', status } }
}

const TASK_KINDS: Record<string, WaitItem['kind']> = { shell: 'shell', monitor: 'monitor' }

type InFlight = { id: string; type: string; status: string; description: string; command?: string }
// Tracked tasks missing from the list, or listed with a final status, end; live ones we never saw
// are added unless their id already ended (`ended`), so a pruned row is not brought back.
export const reconcile = (items: Record<string, WaitItem>, inFlight: InFlight[], ended: ReadonlySet<string>, phase: number, now: number) => {
  const tasks = inFlight.filter(t => TASK_KINDS[t.type])
  const live = new Set(tasks.filter(t => TASK_LIVE.has(t.status)).map(t => t.id))
  const finished = new Map(tasks.filter(t => !TASK_LIVE.has(t.status)).map(t => [t.id, t.status]))
  let out = items
  for (const [k, v] of Object.entries(items)) {
    const id = k.slice('task:'.length)
    if (v.kind !== 'agent' && v.endedPhase === undefined && !live.has(id))
      out = endTask(out, id, finished.get(id) ?? 'completed', phase, now)
  }
  for (const t of tasks)
    if (live.has(t.id) && !out[`task:${t.id}`] && !ended.has(`task:${t.id}`))
      out = { ...out, [`task:${t.id}`]: { kind: TASK_KINDS[t.type], label: oneLine(t.description || t.command || t.id), detail: t.command, startedAt: now } }
  return out
}

// Remember the ids of every ended task row, newest last, capped.
export const tombstone = (ended: string[], items: Record<string, WaitItem>) => {
  const add = Object.entries(items)
    .filter(([k, v]) => v.kind !== 'agent' && v.endedPhase !== undefined && !ended.includes(k))
    .map(([k]) => k)
  return add.length ? [...ended, ...add].slice(-TOMBSTONES) : ended
}

// A Monitor whose timeout has run out has ended, whether or not a notification said so: an expiry
// notice carries no <status> tag, and the end-of-turn reconcile may never run (another plugin's
// classic.Stop hook can answer first), so without this the row would spin forever.
export const expire = (items: Record<string, WaitItem>, phase: number, now: number) => {
  let out = items
  for (const [k, v] of Object.entries(items))
    if (v.deadline !== undefined && v.endedPhase === undefined && now >= v.deadline) out = endTask(out, k.slice('task:'.length), 'expired', phase, now)
  return out
}

// Rows whose hold has run out are dropped.
export const prune = (items: Record<string, WaitItem>, phase: number) => {
  const out: Record<string, WaitItem> = {}
  for (const [k, v] of Object.entries(items))
    if (v.endedPhase === undefined || phase - v.endedPhase < CHECK.length + HOLD_FRAMES) out[k] = v
  return out
}

// Each task notification carries its id(s), and its final status once the task has ended. A Monitor's
// streamed events carry no status: those are not an end. One delivery can hold several notifications,
// and one notification can name several tasks (the engine's "N background shell command tasks didn't
// finish before the previous session ended" notice lists every id, plus an `__orphan_summary__:` marker).
export const parseNotifications = (text: string) => {
  const out: { id: string; status: string }[] = []
  for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const status = block.match(/<status>\s*([^<\s]+)\s*<\/status>/)?.[1]
    if (!status) continue
    for (const m of block.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g))
      if (!m[1].startsWith('__orphan_summary__')) out.push({ id: m[1], status })
  }
  return out
}

export const glyph = (it: WaitItem, phase: number) => {
  if (it.endedPhase === undefined) return SPIN[phase % SPIN.length]
  const frames = it.ok === false ? CROSS : CHECK
  return frames[Math.min(frames.length - 1, Math.max(0, phase - it.endedPhase))]
}

// Where a read starts, given the bytes already scanned (undefined: none yet) and the file's size now.
export const scanStart = (done: number | undefined, size: number) =>
  done === undefined ? Math.max(0, size - SCAN_MAX) : Math.max(0, Math.min(done, size) - SCAN_OVERLAP)

// The transcripts record every task notification as it is queued, whether or not a hook saw it
// arrive. Read what was added since the last scan and end the tasks whose final notification is in
// it. Subagents' transcripts (`<session>/subagents/*.jsonl`) hold their own shells' notifications.
// The main transcript and the subagents' (`<session>/subagents/*.jsonl`).
async function transcriptPaths($: Engine) {
  const { transcriptPath } = await $.session.info()
  if (!transcriptPath) return []
  const paths = [transcriptPath]
  const subDir = transcriptPath.replace(/\.jsonl$/, '') + '/subagents'
  if (await $.fs.exists(subDir))
    for (const f of await $.fs.list(subDir)) if (f.name.endsWith('.jsonl')) paths.push(`${subDir}/${f.name}`)
  return paths
}

type Started = { id: string; item: WaitItem }
type JsonlRow = {
  type?: string
  timestamp?: string
  message?: { content?: unknown }
  toolUseResult?: { taskId?: string; timeoutMs?: number; persistent?: boolean; backgroundTaskId?: string }
}
type ToolUse = { type: string; id: string; name: string; input: { description?: string; command?: string; task_id?: string; shell_id?: string } }

// The shells and Monitors a transcript shows started and not yet ended (no final notification, no
// TaskStop) in `lines`, whole JSONL rows. Monitors past their deadline at `now` are left out.
export const startedTasks = (lines: string[], now: number): Started[] => {
  const uses = new Map<string, ToolUse>()
  const started = new Map<string, WaitItem>()
  const ended = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    for (const n of parseNotifications(line)) ended.add(n.id)
    const row = JSON.parse(line) as JsonlRow
    const content = Array.isArray(row.message?.content) ? (row.message.content as { type?: string; tool_use_id?: string }[]) : []
    if (row.type === 'assistant')
      for (const b of content as ToolUse[]) {
        if (b.type !== 'tool_use') continue
        uses.set(b.id, b)
        if (b.name === 'TaskStop' || b.name === 'KillShell') {
          const id = b.input.task_id ?? b.input.shell_id
          if (id) ended.add(id)
        }
      }
    const r = row.toolUseResult
    if (!r || typeof r !== 'object') continue
    const use = uses.get(content.find(b => b.type === 'tool_result')?.tool_use_id ?? '')
    const startedAt = row.timestamp ? Date.parse(row.timestamp) : now
    const label = oneLine(use?.input.description || use?.input.command || '')
    if (r.taskId && r.timeoutMs !== undefined) {
      const deadline = !r.persistent && r.timeoutMs ? startedAt + r.timeoutMs : undefined
      started.set(r.taskId, { kind: 'monitor', label: label || r.taskId, detail: use?.input.command, startedAt, deadline })
    } else if (r.backgroundTaskId) {
      started.set(r.backgroundTaskId, { kind: 'shell', label: label || r.backgroundTaskId, detail: use?.input.command, startedAt })
    }
  }
  return [...started]
    .filter(([id, it]) => !ended.has(id) && (it.deadline === undefined || it.deadline > now))
    .map(([id, item]) => ({ id, item }))
}

// Whole JSONL rows of a read that began at `offset`: a first row cut by the read and a last row
// still being written are dropped.
export const wholeRows = (text: string, offset: number) => {
  const rows = text.split('\n')
  rows.pop() // after the last newline: empty, or a row not yet complete
  return offset > 0 ? rows.slice(1) : rows
}

// When /waiting turns on or the plugin (re)loads, rows for the tasks still running are rebuilt from
// the transcripts: a reload or a resume starts with no tracked tasks, and no engine call lists them.
async function seedFromTranscripts($: Engine) {
  const now = Date.now()
  const found: Started[] = []
  for (const path of await transcriptPaths($)) {
    const { size } = await $.fs.stat(path)
    const offset = Math.max(0, size - SCAN_MAX)
    found.push(...startedTasks(wholeRows(await $.fs.read(path, { offset, length: size - offset }), offset), now))
  }
  if (found.length)
    await record($, (items, _phase, ended) => {
      let out = items
      for (const { id, item } of found) if (!out[`task:${id}`] && !ended.has(`task:${id}`)) out = { ...out, [`task:${id}`]: item }
      return out
    })
}

async function scanTranscripts($: Engine) {
  const paths = await transcriptPaths($)
  const ends: { id: string; status: string }[] = []
  for (const path of paths) {
    const { size } = await $.fs.stat(path)
    const done = scanned.get(path)
    if (done === size) continue
    let offset = scanStart(done, size)
    while (offset < size) {
      const length = Math.min(SCAN_MAX, size - offset)
      // JSONL escapes newlines inside strings; the parser reads either form.
      ends.push(...parseNotifications(await $.fs.read(path, { offset, length })))
      offset += length
    }
    scanned.set(path, size)
  }
  if (ends.length) await record($, (items, phase) => ends.reduce((acc, n) => endTask(acc, n.id, n.status, phase, Date.now()), items))
}

async function frame($: Engine) {
  const phase = await update($, waitingPhase, n => n + 1)
  const now = Date.now()
  if (phase % POLL_EVERY === 0) {
    const agents = await $.agent.list()
    const items = await update($, waitItems, items => prune(expire(foldAgents(items, agents, phase, now), phase, now), phase))
    await update($, waitEnded, ended => tombstone(ended, items))
  }
  if (phase % SCAN_EVERY === 0 && !scanning) {
    const items = await read($, waitItems)
    if (Object.values(items).some(it => it.kind !== 'agent' && it.endedPhase === undefined)) {
      scanning = true
      try {
        await scanTranscripts($)
      } finally {
        scanning = false
      }
    }
  }
}

function startTicker($: Engine) {
  ticker?.cancel()
  ticker = $.clock.every(FRAME_MS, () => {
    frame($).catch(err => $.ui.log(`quarterdeck waiting tick failed: ${String(err)}`))
  })
}

const record = (
  $: Engine,
  f: (items: Record<string, WaitItem>, phase: number, ended: ReadonlySet<string>) => Record<string, WaitItem>,
) =>
  Promise.all([read($, waitingPhase), read($, waitEnded)])
    .then(([phase, ended]) => update($, waitItems, items => f(items, phase, new Set(ended))))
    .then(items => update($, waitEnded, ended => tombstone(ended, items)))
    .catch(err => $.ui.log(`quarterdeck waiting update failed: ${String(err)}`))

// The box, spliced into the HUD band by register.tsx; null while /waiting is off.
export async function waitingBox($: Engine, e: Parameters<Engine['ui']['resolve']>[0], width: number) {
  if (!(await read($, waitingOn))) return null
  const { Box, Text } = $.ui.resolve(e)
  const phase = await read($, waitingPhase)
  const items = Object.entries(await read($, waitItems)).sort(([, a], [, b]) => a.startedAt - b.startedAt)
  const now = Date.now()
  const live = items.filter(([, it]) => it.endedPhase === undefined)
  const labelRoom = Math.max(12, width - 30)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={GREEN} paddingX={1}>
      <Text>
        <Text color={GREEN} bold>
          WAITING
        </Text>
        <Text color={DIM}>
          {'  '}
          {live.filter(([, i]) => i.kind === 'agent').length} agents · {live.filter(([, i]) => i.kind === 'shell').length} shells ·{' '}
          {live.filter(([, i]) => i.kind === 'monitor').length} monitors
        </Text>
      </Text>
      {items.length === 0 && <Text color={DIM}>nothing running</Text>}
      {items.map(([key, it]) => {
        const ended = it.endedPhase !== undefined
        const tone = !ended ? GREEN : it.ok === false ? RED : phase - (it.endedPhase ?? 0) < CHECK.length + 4 ? BRIGHT : GREEN
        const took = elapsed((it.endedAt ?? now) - it.startedAt)
        return (
          <Text key={key} wrap="truncate-end">
            <Text color={tone} bold>
              {glyph(it, phase).padEnd(2, ' ')}
            </Text>{' '}
            <Text color={DIM}>{it.kind.padEnd(7, ' ')} </Text>
            <Text color={ended ? DIM : undefined}>{clip(it.label, labelRoom)}</Text>
            <Text color={ended ? tone : DIM}>
              {'  '}
              {ended ? `${it.status === 'completed' || !it.status ? 'done' : it.status} · ${took}` : took}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

export const registerWaiting = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'waiting', description: 'Toggle a green box of running agents and waiting shells' })
    if (await read($, waitingOn)) {
      seedFromTranscripts($).catch(err => $.ui.log(`quarterdeck waiting seed failed: ${String(err)}`))
      startTicker($)
    }
    return started
  })

  on('command.run', { command: 'waiting' }, async $ => {
    if (await read($, waitingOn)) {
      ticker?.cancel()
      ticker = undefined
      await update($, waitingOn, () => false)
      return { text: 'Waiting box off.' }
    }
    await update($, waitingOn, () => true)
    await seedFromTranscripts($)
    startTicker($)
    return { text: 'Waiting box on. /waiting again to hide it.' }
  })

  // A Bash call sent to the background (asked for, ctrl+b, or timed out) is a waiting shell.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const result = 'result' in r ? (r.result as { backgroundTaskId?: string; backgroundEndsWithFinalResponse?: true } | undefined) : undefined
    const id = result?.backgroundTaskId
    if (id) {
      const label = oneLine((e as { description?: string }).description || e.command)
      // Killed at its subagent's final response with no notification: tie the row to that agent.
      const owner = result?.backgroundEndsWithFinalResponse ? e.agentId : undefined
      void record($, items => ({ ...items, [`task:${id}`]: { kind: 'shell', label, detail: e.command, startedAt: Date.now(), owner } }))
    }
    return r
  })

  // A Monitor call starts a background watch that streams events until it ends.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    const result = 'result' in r ? (r.result as { taskId?: string; timeoutMs?: number; persistent?: boolean } | undefined) : undefined
    const id = result?.taskId
    if (id) {
      const label = oneLine(e.description || e.command || e.ws?.url || id)
      const startedAt = Date.now()
      const deadline = result && !result.persistent && result.timeoutMs ? startedAt + result.timeoutMs : undefined
      void record($, items => ({ ...items, [`task:${id}`]: { kind: 'monitor', label, detail: e.command, startedAt, deadline } }))
    }
    return r
  })

  // Stopping a task by hand ends its row.
  on('tool.call', { tool: /^(TaskStop|KillShell)$/ }, async ($, e, next) => {
    const r = await next(e)
    const input = e as unknown as { task_id?: string; shell_id?: string }
    const id = input.task_id ?? input.shell_id
    if (id && !('isError' in r && r.isError)) void record($, (items, phase) => endTask(items, id, 'stopped', phase, Date.now()))
    return r
  })

  // A background task's notification says it finished.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    const ends = parseNotifications(e.text)
    if (ends.length)
      void record($, (items, phase) => ends.reduce((acc, n) => endTask(acc, n.id, n.status, phase, Date.now()), items))
    return next(e)
  })

  // At each turn's end the engine lists what is still in flight: tracked tasks missing from it have
  // ended (their notification, if any, has the real status); listed ones we missed are added.
  // A Stop without the list says nothing about what is in flight, so it changes nothing.
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks
    if (inFlight) void record($, (items, phase, ended) => reconcile(items, inFlight, ended, phase, Date.now()))
    return next(e)
  })
}
