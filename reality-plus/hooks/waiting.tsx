import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register } from 'claude-code'

import type { WaitItem } from '../types'

// /waiting: a green box above the prompt listing the subagents still running and the background shells
// and Monitor watches still waiting. Each live row spins; a finished row draws a check mark, holds it, then leaves.
const FRAME_MS = 120
const POLL_EVERY = 4 // frames between $.agent.list() polls
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

const waitingOn = atom({ plugin: 'reality-plus', key: 'waiting-on' } as const, false)
const waitingPhase = atom({ plugin: 'reality-plus', key: 'waiting-phase' } as const, 0)
// Keyed `agent:<id>` / `task:<task id>` (shells and monitors); tasks are tracked whether or not the box is shown.
const waitItems = atom({ plugin: 'reality-plus', key: 'waiting-items' } as const, {} as Record<string, WaitItem>, { shape: 'waiting-2' })
// Ids (`task:<id>`) of tasks that have ended, oldest first, kept after their rows are pruned.
const waitEnded = atom({ plugin: 'reality-plus', key: 'waiting-ended' } as const, [] as string[], { shape: 'waiting-ended-1' })

type Engine = Parameters<typeof update>[0]
let ticker: { cancel: () => void } | undefined

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
    } else if (old && old.endedPhase === undefined) {
      next[key] = { ...old, endedPhase: phase, endedAt: now, ok: a.status === 'completed' }
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

// Rows whose hold has run out are dropped.
export const prune = (items: Record<string, WaitItem>, phase: number) => {
  const out: Record<string, WaitItem> = {}
  for (const [k, v] of Object.entries(items))
    if (v.endedPhase === undefined || phase - v.endedPhase < CHECK.length + HOLD_FRAMES) out[k] = v
  return out
}

// Each task notification carries its id, and its final status once the task has ended. A Monitor's
// streamed events carry no status: those are not an end. One delivery can hold several notifications.
export const parseNotifications = (text: string) => {
  const out: { id: string; status: string }[] = []
  for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const id = block.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1]
    const status = block.match(/<status>\s*([^<\s]+)\s*<\/status>/)?.[1]
    if (id && status) out.push({ id, status })
  }
  return out
}

export const glyph = (it: WaitItem, phase: number) => {
  if (it.endedPhase === undefined) return SPIN[phase % SPIN.length]
  const frames = it.ok === false ? CROSS : CHECK
  return frames[Math.min(frames.length - 1, Math.max(0, phase - it.endedPhase))]
}

async function frame($: Engine) {
  const phase = await update($, waitingPhase, n => n + 1)
  const now = Date.now()
  if (phase % POLL_EVERY === 0) {
    const agents = await $.agent.list()
    await update($, waitItems, items => prune(foldAgents(items, agents, phase, now), phase))
  }
}

function startTicker($: Engine) {
  ticker?.cancel()
  ticker = $.clock.every(FRAME_MS, () => {
    frame($).catch(err => $.ui.log(`reality-plus waiting tick failed: ${String(err)}`))
  })
}

const record = (
  $: Engine,
  f: (items: Record<string, WaitItem>, phase: number, ended: ReadonlySet<string>) => Record<string, WaitItem>,
) =>
  Promise.all([read($, waitingPhase), read($, waitEnded)])
    .then(([phase, ended]) => update($, waitItems, items => f(items, phase, new Set(ended))))
    .then(items => update($, waitEnded, ended => tombstone(ended, items)))
    .catch(err => $.ui.log(`reality-plus waiting update failed: ${String(err)}`))

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
    if (await read($, waitingOn)) startTicker($)
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
    startTicker($)
    return { text: 'Waiting box on. /waiting again to hide it.' }
  })

  // A Bash call sent to the background (asked for, ctrl+b, or timed out) is a waiting shell.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const result = 'result' in r ? (r.result as { backgroundTaskId?: string } | undefined) : undefined
    const id = result?.backgroundTaskId
    if (id) {
      const label = oneLine((e as { description?: string }).description || e.command)
      void record($, items => ({ ...items, [`task:${id}`]: { kind: 'shell', label, detail: e.command, startedAt: Date.now() } }))
    }
    return r
  })

  // A Monitor call starts a background watch that streams events until it ends.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    const result = 'result' in r ? (r.result as { taskId?: string } | undefined) : undefined
    const id = result?.taskId
    if (id) {
      const label = oneLine(e.description || e.command || e.ws?.url || id)
      void record($, items => ({ ...items, [`task:${id}`]: { kind: 'monitor', label, detail: e.command, startedAt: Date.now() } }))
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
