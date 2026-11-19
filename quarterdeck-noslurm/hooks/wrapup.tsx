// /wrap-up: a card to pick what a /compact or a handoff carries forward.
// The idea (threads read by Haiku, keep/drop lines, Compact fills /compact,
// Handoff summarises, clears and fills the fresh prompt) follows mod-wrap-up by
// v-amorim (MIT, github.com/v-amorim/moonlight-claude-mods); this code is our own.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { WrapUpCard } from '../types'

const PANE = 'wrapup'
const TITLE = 'Wrap up'
const PANE_BG = 'rgb(20,20,20)'
const ACCENT = 'claude'
const SIGNAL = 'suggestion'
const HOT = 'warning'
const DIM = 'inactive'
const INK = 'inverseText'

const MAX_THREADS = 4
const TRANSCRIPT_CHARS = 150_000
const PENDING_KEY = 'wrapup-pending'
const PENDING_FRESH_MS = 5 * 60_000
const FILL_TRIES = 10

const CLOSED: WrapUpCard = {
  phase: 'closed',
  token: 0,
  threads: [],
  files: [],
  tasks: [],
  isFilesKept: true,
  isTasksKept: true,
  isNameKept: true,
  isTruncated: false,
}

const card = atom({ plugin: 'quarterdeck-noslurm', key: 'wrapup-card' } as const, CLOSED, { shape: 'wrapup-card-1' })

export const THREADS_SYSTEM = [
  'You read a Claude Code session transcript and list its distinct threads of work.',
  `Answer with JSON only, no prose and no code fence: {"threads": [...], "name": "..."}.`,
  `"threads": 1 to ${MAX_THREADS} short lines (under 90 characters each), one per separate piece of work, most recent first, each saying what it is and where it stands.`,
  '"name": a short session name for /rename (2 to 5 words, lowercase, no quotes) naming the work as a whole.',
].join('\n')

export const HANDOFF_SYSTEM = [
  'You write a handoff for a fresh Claude Code session that continues the work of the transcript you are given.',
  'Write only what the next session needs: the goal, decisions made and why, current state, the exact next steps, and gotchas.',
  'Cover only the threads marked KEEP; leave the DROP threads out entirely. Name files by path. Plain markdown, at most 400 words, no preamble.',
].join('\n')

// ---------- pure helpers (unit tested) ----------

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Every file path a Read/Edit/Write/NotebookEdit call touched, most recent first, deduplicated. */
export function filesInPlay(messages: readonly SessionMessage[]): string[] {
  const seen: string[] = []
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (!FILE_TOOLS.has(use.tool)) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string') continue
      const at = seen.indexOf(path)
      if (at >= 0) seen.splice(at, 1)
      seen.push(path)
    }
  }
  return seen.reverse()
}

/** The subjects of tasks still open, replayed from TaskCreate/TaskUpdate/TodoWrite calls. */
export function openTasks(messages: readonly SessionMessage[]): string[] {
  const tasks = new Map<string, { subject: string; status: string }>()
  let todos: { subject: string; status: string }[] = []
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.isError) continue
      if (use.tool === 'TaskCreate') {
        const task = (use.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
        if (task && typeof task.id === 'string' && typeof task.subject === 'string')
          tasks.set(task.id, { subject: task.subject, status: 'pending' })
      } else if (use.tool === 'TaskUpdate') {
        const id = use.input.taskId
        if (typeof id !== 'string') continue
        const old = tasks.get(id)
        if (!old) continue
        const status = typeof use.input.status === 'string' ? use.input.status : old.status
        if (status === 'deleted') tasks.delete(id)
        else tasks.set(id, { subject: typeof use.input.subject === 'string' ? use.input.subject : old.subject, status })
      } else if (use.tool === 'TodoWrite') {
        const list = use.input.todos
        if (Array.isArray(list))
          todos = list.map(t => ({ subject: String((t as { content?: unknown }).content), status: String((t as { status?: unknown }).status) }))
      }
    }
  }
  return [...tasks.values(), ...todos].filter(t => t.status !== 'completed').map(t => (t.status === 'in_progress' ? `${t.subject} (in progress)` : t.subject))
}

const briefInput = (input: Record<string, unknown>) => {
  const pick = input.file_path ?? input.command ?? input.pattern ?? input.description ?? input.subject ?? input.query
  return typeof pick === 'string' ? pick.slice(0, 160) : ''
}

/** The transcript as plain text (tool calls in brackets, tool output left out), cut to its last `limit` chars. */
export function transcriptText(messages: readonly SessionMessage[], limit = TRANSCRIPT_CHARS): { text: string; isTruncated: boolean } {
  const parts: string[] = []
  for (const message of messages) {
    const lines: string[] = []
    if (message.text.trim()) lines.push(message.text.trim())
    for (const use of message.toolUses) lines.push(`[${use.tool} ${briefInput(use.input)}]`.replace(/ \]$/, ']'))
    if (lines.length) parts.push(`${message.role.toUpperCase()}: ${lines.join('\n')}`)
  }
  const whole = parts.join('\n\n')
  return whole.length > limit ? { text: whole.slice(whole.length - limit), isTruncated: true } : { text: whole, isTruncated: false }
}

/** Haiku's JSON answer; throws with the reason when it is not the shape asked for. */
export function parseThreads(reply: string): { threads: string[]; name?: string } {
  const body = reply.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    throw new Error(`Haiku did not answer JSON (${String(err)}): ${body.slice(0, 80)}`)
  }
  const threads = (parsed as { threads?: unknown }).threads
  if (!Array.isArray(threads) || !threads.every(t => typeof t === 'string'))
    throw new Error(`Haiku's JSON has no "threads" list of strings: ${body.slice(0, 80)}`)
  const name = (parsed as { name?: unknown }).name
  return {
    threads: (threads as string[]).map(t => t.trim()).filter(Boolean).slice(0, MAX_THREADS),
    name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
  }
}

/** The /compact instructions for what the card keeps. */
export function compactInstructions(c: WrapUpCard): string {
  const kept = c.threads.filter(t => t.isKept).map(t => t.text)
  const dropped = c.threads.filter(t => !t.isKept).map(t => t.text)
  const parts: string[] = []
  if (kept.length) parts.push(`Keep in detail: ${kept.join('; ')}.`)
  if (dropped.length) parts.push(`Summarise in one line at most, or drop: ${dropped.join('; ')}.`)
  if (c.isFilesKept && c.files.length) parts.push(`Keep the files in play: ${c.files.join(', ')}.`)
  if (c.isTasksKept && c.tasks.length) parts.push(`Keep the open tasks: ${c.tasks.join('; ')}.`)
  return parts.join(' ')
}

/** The model prompt for a handoff of what the card keeps. */
export function handoffPrompt(c: WrapUpCard, transcript: string): string {
  const lines = c.threads.map(t => `${t.isKept ? 'KEEP' : 'DROP'}: ${t.text}`)
  if (c.isFilesKept && c.files.length) lines.push(`KEEP files in play: ${c.files.join(', ')}`)
  if (c.isTasksKept && c.tasks.length) lines.push(`KEEP open tasks: ${c.tasks.join('; ')}`)
  return `<transcript>\n${transcript}\n</transcript>\n\n<scope>\n${lines.join('\n')}\n</scope>\n\nWrite the handoff.`
}

// ---------- actions (top-level, each takes $) ----------

async function fail($: EngineInterface, token: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  $.ui.log(`quarterdeck wrap-up: ${message}`)
  await update($, card, c => (c.token === token ? { ...c, phase: c.phase === 'closed' ? 'closed' : 'ready', error: message, status: undefined } : c))
  if ((await read($, card)).phase === 'closed') $.ui.toast(`Wrap up failed: ${message}`)
}

/** Runs an action off a press; a failure lands in the card in red (a toast once the card is closed) and in the log. */
function act($: EngineInterface, run: (token: number) => Promise<void>) {
  void read($, card)
    .then(({ token }) => run(token).catch(err => fail($, token, err)))
    .catch(err => $.ui.log(`quarterdeck wrap-up: ${String(err)}`))
}

async function readSession($: EngineInterface, token: number) {
  const messages = await $.session.messages()
  const files = filesInPlay(messages)
  const tasks = openTasks(messages)
  await update($, card, c => (c.token === token ? { ...c, files, tasks } : c))
  if (!messages.some(m => m.role === 'user' && m.text.trim())) {
    await update($, card, c => (c.token === token ? { ...c, phase: 'ready', status: 'Nothing said in this session yet.' } : c))
    return
  }
  const { text, isTruncated } = transcriptText(messages)
  const reply = await $.model.complete({ model: 'haiku', system: THREADS_SYSTEM, prompt: `<transcript>\n${text}\n</transcript>`, maxTokens: 600, timeoutMs: 45_000 })
  if (!reply.isAnswered) throw new Error(`Haiku gave no threads: ${modelFailure(reply)}`)
  const parsed = parseThreads(reply.text)
  await update($, card, c =>
    c.token === token
      ? { ...c, phase: 'ready', isTruncated, threads: parsed.threads.map(t => ({ text: t, isKept: true })), name: parsed.name, status: undefined }
      : c,
  )
}

function modelFailure(reply: { reason: string; status?: number | null; error?: unknown }) {
  return reply.reason === 'api-error' ? `api-error ${reply.status ?? '?'} ${String(reply.error)}` : reply.reason
}

export async function openCard($: EngineInterface): Promise<string> {
  const token = (await read($, card)).token + 1
  await update($, card, () => ({ ...CLOSED, phase: 'reading', token }))
  const opened = await $.ui.open({ id: PANE, title: TITLE, backgroundColor: PANE_BG, focus: true, closeOnEscape: true })
  if (!opened.isPlaced) {
    await update($, card, c => ({ ...c, phase: 'closed' }))
    return `Wrap-up card not placed: ${opened.reason}`
  }
  void readSession($, token).catch(err => fail($, token, err))
  return 'Wrap-up card opened: Haiku is reading the session.'
}

async function closeCard($: EngineInterface) {
  await update($, card, c => ({ ...CLOSED, token: c.token }))
  await $.ui.close({ id: PANE })
}

async function renameSession($: EngineInterface, name: string) {
  await $.command.run({ command: 'rename', args: name })
}

async function compact($: EngineInterface, token: number) {
  const c = await read($, card)
  if (c.token !== token) return
  const instructions = compactInstructions(c)
  if (c.isNameKept && c.name) await renameSession($, c.name)
  // A focused card would hold the keys: close it so the prompt takes the fill.
  await closeCard($)
  const filled = await $.prompt.fill({ text: instructions ? `/compact ${instructions}` : '/compact', mode: 'replace' })
  if (!filled.isFilled) throw new Error(`could not fill the prompt with /compact (${filled.refusal ?? 'refused'})`)
  $.ui.toast('Wrap up: /compact instructions are in the prompt; review and press Enter.')
}

/** Fills the stored handoff into the prompt, retrying while the fresh composer mounts. True once it landed. */
export async function fillPending($: EngineInterface): Promise<boolean> {
  for (let tries = 0; tries < FILL_TRIES; tries++) {
    const pending = (await $.store.get(PENDING_KEY)) as { text: string; at: number } | undefined
    if (pending === undefined) return true // the other path already filled it
    if ((await $.clock.now()) - pending.at > PENDING_FRESH_MS) {
      await $.store.delete(PENDING_KEY)
      throw new Error('the stored handoff is older than 5 minutes; not filled')
    }
    const filled = await $.prompt.fill({ text: pending.text, mode: 'replace' })
    if (filled.isFilled) {
      await $.store.delete(PENDING_KEY)
      return true
    }
    await $.clock.sleep(200)
  }
  return false
}

async function handoff($: EngineInterface, token: number) {
  const c = await read($, card)
  if (c.token !== token) return
  await update($, card, x => (x.token === token ? { ...x, phase: 'working', error: undefined, status: 'Sonnet is writing the handoff…' } : x))
  const messages = await $.session.messages()
  const { text } = transcriptText(messages)
  const reply = await $.model.complete({ model: 'sonnet', system: HANDOFF_SYSTEM, prompt: handoffPrompt(c, text), maxTokens: 4000, timeoutMs: 180_000 })
  if (!reply.isAnswered) throw new Error(`Sonnet wrote no handoff: ${modelFailure(reply)}`)
  const summary = reply.text.trim()
  if (!summary) throw new Error('Sonnet wrote an empty handoff')
  // The store outlives the /clear; the session's state does not.
  await $.store.set(PENDING_KEY, { text: summary, at: await $.clock.now() })
  await closeCard($)
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    // The one fallback the user asked for: the person runs /clear, then session.end fills the handoff.
    $.ui.log(`quarterdeck wrap-up: /clear from the plugin failed: ${String(err)}`)
    const filled = await $.prompt.fill({ text: '/clear', mode: 'replace' })
    if (!filled.isFilled) throw new Error(`/clear failed (${String(err)}) and the prompt could not be filled (${filled.refusal ?? 'refused'})`)
    $.ui.toast('Wrap up: could not clear from the plugin. Press Enter on /clear; the handoff fills in after.')
    return
  }
  if (c.isNameKept && c.name) await renameSession($, c.name)
  if (!(await fillPending($))) throw new Error('cleared, but the handoff could not be filled into the prompt; it stays stored for 5 minutes')
  $.ui.toast('Wrap up: cleared; the handoff is in the prompt.')
}

async function renameNow($: EngineInterface, token: number) {
  const c = await read($, card)
  if (c.token !== token || !c.name) return
  await renameSession($, c.name)
  await update($, card, x => (x.token === token ? { ...x, status: `Renamed to "${c.name}".`, error: undefined } : x))
}

async function toggle($: EngineInterface, token: number, which: string) {
  await update($, card, c => {
    if (c.token !== token) return c
    const m = /^thread-(\d+)$/.exec(which)
    if (m) return { ...c, threads: c.threads.map((t, i) => (i === Number(m[1]) ? { ...t, isKept: !t.isKept } : t)) }
    if (which === 'files') return { ...c, isFilesKept: !c.isFilesKept }
    if (which === 'tasks') return { ...c, isTasksKept: !c.isTasksKept }
    if (which === 'name') return { ...c, isNameKept: !c.isNameKept }
    throw new Error(`unknown wrap-up toggle ${which}`)
  })
}

// ---------- hooks ----------

export const registerWrapUp = (on: Parameters<Register>[0]) => {
  // Matched (register.tsx holds the one unmatched session.start); the card is for a person at the prompt.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'wrap-up', description: 'Pick what a /compact or a handoff to a fresh session carries forward' })
    return started
  })

  on('command.run', { command: 'wrap-up' }, async $ => ({ text: await openCard($) }))

  // A /clear the person ran after a refused plugin /clear: fill the waiting handoff once the fresh prompt is there.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    const ended = await next(e)
    if ((await $.store.get(PENDING_KEY)) !== undefined) {
      $.clock.after(300, () => {
        fillPending($)
          .then(isFilled => {
            if (!isFilled) $.ui.log('quarterdeck wrap-up: the handoff could not be filled into the fresh prompt; it stays stored for 5 minutes')
          })
          .catch(err => $.ui.log(`quarterdeck wrap-up: ${String(err)}`))
      })
    }
    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, card)
    const width = Math.max(20, e.props.bodyColumns - 8)
    const busy = c.phase === 'reading' || c.phase === 'working'
    const clipTo = (s: string) => (s.length > width ? s.slice(0, width - 1) + '…' : s)
    const toggleRow = (key: string, isKept: boolean, label: string) => (
      <Button key={`wrapup-${key}`} plain onPress={() => act($, token => toggle($, token, key))}>
        <Text color={isKept ? ACCENT : DIM}>{isKept ? '■ keep ' : '□ drop '}</Text>
        <Text color={isKept ? undefined : DIM}>{clipTo(label)}</Text>
      </Button>
    )
    const header = (tag: string, note?: string) => (
      <Text>
        <Text backgroundColor={SIGNAL} color={INK} bold>
          {` ${tag} `}
        </Text>
        <Text color={SIGNAL}> ▸▸ </Text>
        {note && <Text color={DIM}>{note}</Text>}
      </Text>
    )
    const threadNote = c.phase === 'reading' ? 'Haiku is reading the session…' : c.isTruncated ? 'read from the transcript tail' : undefined
    return (
      <Box flexDirection="column">
        {header('THREADS', threadNote)}
        {c.phase !== 'reading' && c.threads.length === 0 && <Text color={DIM}>no threads</Text>}
        {c.threads.map((t, i) => toggleRow(`thread-${i}`, t.isKept, t.text))}
        <Text> </Text>
        {header('CARRIED')}
        {toggleRow('files', c.isFilesKept, c.files.length ? `files in play (${c.files.length}): ${c.files.map(f => f.split('/').pop()).join(', ')}` : 'files in play: none')}
        {toggleRow('tasks', c.isTasksKept, c.tasks.length ? `open tasks (${c.tasks.length}): ${c.tasks.join('; ')}` : 'open tasks: none')}
        {c.name && <Text> </Text>}
        {c.name && header('RENAME')}
        {c.name && toggleRow('name', c.isNameKept, `/rename ${c.name}`)}
        <Text> </Text>
        {c.status && <Text color={HOT}>{c.status}</Text>}
        {c.error && <Text color="error">✗ {c.error}</Text>}
        {!busy && (
          <Box flexDirection="row" gap={1}>
            <Button key="wrapup-compact" hotkey="c" variant="primary" onPress={() => act($, token => compact($, token))}>
              Compact
            </Button>
            <Button key="wrapup-handoff" hotkey="h" onPress={() => act($, token => handoff($, token))}>
              Handoff
            </Button>
            {c.name && (
              <Button key="wrapup-rename" hotkey="r" onPress={() => act($, token => renameNow($, token))}>
                Rename now
              </Button>
            )}
            <Button key="wrapup-close" role="dismiss" onPress={() => act($, () => closeCard($))}>
              Close
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
