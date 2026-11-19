// Transcript skin: Bash commands in shell colours, finished tool calls folded to one
// line (click to open), and Edit/Write results drawn as compact file cards.
// A subset of the ideas in v-amorim's MIT-licensed mod-transcript
// (github.com/v-amorim/moonlight-claude-mods), written fresh for quarterdeck.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Elements, Register } from 'claude-code'

import type { TranscriptIds } from '../types'

type On = Parameters<Register>[0]
type Els = Elements['terminal']
type Dollar = Pick<CoreEngineInterface, 'state' | 'ui'>

// Theme keys from the Quarterdeck theme; any other theme maps them to its own.
const DIM = 'inactive'
const RULE = 'subtle'
const INK = 'text'
const ROLE_COLOR = {
  command: 'claude',
  option: 'suggestion',
  string: 'warning',
  variable: 'merged',
  operator: 'inactive',
  comment: 'subtle',
  plain: 'text',
} as const

// Open tool_use_ids, and `more:<id>` for a result card shown in full.
const openIds = atom({ plugin: 'quarterdeck-noslurm', key: 'transcript-open' } as const, [] as TranscriptIds, { shape: 'transcript-open-1' })
// Calls of the running main-loop turn: they draw as the engine draws them until the turn ends.
const liveIds = atom({ plugin: 'quarterdeck-noslurm', key: 'transcript-live' } as const, [] as TranscriptIds, { shape: 'transcript-live-1' })
// /transcript on|off.
const enabled = atom({ plugin: 'quarterdeck-noslurm', key: 'transcript-on' } as const, true, { shape: 'transcript-on-1' })

const CARD_LINES = 12
const BASH_LINES = 3

// ---------------------------------------------------------------- shell tokenizer

export type Role = keyof typeof ROLE_COLOR
export type Span = { text: string; role: Role }

// A wrapper keeps the next word in command position: `sudo rm` runs rm.
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'time', 'command', 'nohup', 'exec', 'xargs', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'srun', 'timeout'])
const OPERATOR = /^(?:&&|\|\||;;|;|\|&|\||&(?![>&])|\$\(|\(|\)|`)/
const REDIRECT = /^(?:\d*>>?(?:&\d+|&-)?|&>>?|\d*<<?<?(?:&\d+)?)/
const VARIABLE = /(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9?#@*!$-])/
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// One line of shell as spans whose texts join back to the line exactly.
export function tokenizeShell(line: string): Span[] {
  const spans: Span[] = []
  const push = (text: string, role: Role) => {
    if (!text) return
    const last = spans[spans.length - 1]
    if (last && last.role === role) last.text += text
    else spans.push({ text, role })
  }
  const pushWithVars = (text: string, role: Role) => text.split(VARIABLE).forEach((part, n) => push(part, n % 2 ? 'variable' : role))
  let isCommand = true
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const space = /^\s+/.exec(rest)
    if (space) {
      push(space[0], 'plain')
      i += space[0].length
      continue
    }
    if (rest[0] === '#') {
      push(rest, 'comment')
      break
    }
    const op = OPERATOR.exec(rest)
    if (op) {
      push(op[0], 'operator')
      i += op[0].length
      isCommand = op[0] !== ')'
      continue
    }
    const redirect = REDIRECT.exec(rest)
    if (redirect && redirect[0].length > 0) {
      push(redirect[0], 'operator')
      i += redirect[0].length
      continue
    }
    const quote = rest[0]
    if (quote === "'" || quote === '"') {
      let end = 1
      while (end < rest.length && rest[end] !== quote) end += quote === '"' && rest[end] === '\\' ? 2 : 1
      const body = rest.slice(0, Math.min(rest.length, end + 1))
      if (quote === '"') pushWithVars(body, 'string')
      else push(body, 'string')
      i += body.length
      isCommand = false
      continue
    }
    const word = /^[^\s&|;()<>'"`]+/.exec(rest)?.[0] ?? rest[0]
    if (isCommand && ASSIGN.test(word)) pushWithVars(word, 'variable')
    else if (word.startsWith('-') && word.length > 1) pushWithVars(word, 'option')
    else if (isCommand) {
      if (word.startsWith('$')) pushWithVars(word, 'plain')
      else push(word, 'command')
      if (!WRAPPERS.has(word)) isCommand = false
    } else pushWithVars(word, 'plain')
    i += word.length
  }
  return spans
}

// ---------------------------------------------------------------- pure helpers

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

type Hunk = { oldStart: number; newStart: number; lines: string[] }
type Card = { path: string; hunks: Hunk[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const hunksOf = (v: unknown): Hunk[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const hunks = v.filter(
    (x): x is Hunk => isRecord(x) && typeof x.oldStart === 'number' && typeof x.newStart === 'number' && Array.isArray(x.lines) && x.lines.every(l => typeof l === 'string'),
  )
  return hunks.length === v.length ? hunks : undefined
}

// What a file result card draws: the file and its hunks; undefined when the output is not one.
export function fileCardOf(tool: string, output: unknown): Card | undefined {
  if (!isRecord(output) || typeof output.filePath !== 'string') return undefined
  const patch = hunksOf(output.structuredPatch)
  if (tool === 'Edit') return patch && patch.length ? { path: output.filePath, hunks: patch } : undefined
  if (tool !== 'Write') return undefined
  if (patch && patch.length) return { path: output.filePath, hunks: patch }
  if (output.type === 'create' && typeof output.content === 'string') {
    const lines = output.content.replace(/\n$/, '').split('\n').map(l => `+${l}`)
    return { path: output.filePath, hunks: [{ oldStart: 0, newStart: 1, lines }] }
  }
  return undefined
}

export function diffStat(tool: string, output: unknown): { added: number; removed: number } {
  const card = fileCardOf(tool, output)
  let added = 0
  let removed = 0
  for (const hunk of card?.hunks ?? [])
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  return { added, removed }
}

// The argument shown in `Tool(arg)`.
export function toolArg(tool: string, input: unknown): string {
  if (!isRecord(input)) return ''
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const arg =
    tool === 'Bash'
      ? pick('command')
      : (pick('file_path') ?? pick('notebook_path') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('description') ?? pick('prompt') ?? Object.values(input).find((v): v is string => typeof v === 'string'))
  return (arg ?? '').split('\n')[0]
}

export type CardRow = { sign: '+' | '-' | ' ' | '⋯'; n?: number; text: string }

// A card's numbered rows: the new file's numbers for kept and added lines, the old file's for removed ones.
export function cardRows(hunks: Hunk[]): CardRow[] {
  const rows: CardRow[] = []
  hunks.forEach((hunk, at) => {
    if (at > 0) rows.push({ sign: '⋯', text: '' })
    let oldN = hunk.oldStart
    let newN = hunk.newStart
    for (const line of hunk.lines) {
      const sign = line[0]
      const text = line.slice(1)
      if (sign === '+') rows.push({ sign: '+', n: newN++, text })
      else if (sign === '-') rows.push({ sign: '-', n: oldN++, text })
      else if (sign === '\\') continue // "\ No newline at end of file"
      else {
        rows.push({ sign: ' ', n: newN, text })
        oldN++
        newN++
      }
    }
  })
  return rows
}

const toggled = (ids: TranscriptIds | undefined, id: string) => {
  const list = ids ?? []
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

// Whether the output says the call was cut (Bash records `interrupted`, an abort leaves its text): those draw as the engine does.
const isCut = (output: unknown) => typeof output === 'string' || (isRecord(output) && output.interrupted === true)

// ---------------------------------------------------------------- drawing

function shellText({ Text }: Els, line: string, key: string) {
  return tokenizeShell(line).map((span, n) => (
    <Text key={`${key}-${n}`} color={ROLE_COLOR[span.role]} bold={span.role === 'command'}>
      {span.text}
    </Text>
  ))
}

// The engine's `● Bash(command)` row, its command in shell colours.
function bashRow(els: Els, input: unknown, columns: number) {
  const { Box, Text } = els
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : ''
  const all = command.replace(/\n+$/, '').split('\n')
  const shown = all.slice(0, BASH_LINES)
  const hidden = all.length - shown.length
  return (
    <Box key="transcript-bash" flexDirection="column" marginTop={1}>
      {shown.map((line, n) => {
        const isLast = n === shown.length - 1
        return (
          <Box key={`transcript-bash-${n}`} flexDirection="row">
            <Text color={n === 0 ? 'success' : DIM}>{n === 0 ? '● ' : '  '}</Text>
            <Box key={`transcript-bash-cmd-${n}`} flexShrink={1}>
              <Text>
                {n === 0 ? <Text bold>Bash(</Text> : null}
                {shellText(els, clip(line, Math.max(20, columns - 10)), `transcript-bash-${n}`)}
                {isLast && !hidden ? <Text bold>)</Text> : null}
              </Text>
            </Box>
          </Box>
        )
      })}
      {hidden ? <Text color={DIM}>{`  … +${hidden} lines)`}</Text> : null}
    </Box>
  )
}

// A press's work is handed back to the engine, so a failed write surfaces there.
const toggleOpen = ($: Dollar, id: string) => update($, openIds, ids => toggled(ids, id))

type CallProps = { tool_use_id: string; tool: string; input: unknown; output?: unknown }

// One line for a finished call: `▸ Tool(arg)  +a −r`; the label is the toggle.
function foldLine($: Dollar, els: Els, call: CallProps, isOpen: boolean, columns: number) {
  const { Box, Button, Text } = els
  const id = call.tool_use_id
  const { added, removed } = diffStat(call.tool, call.output)
  const statWidth = (added ? String(added).length + 2 : 0) + (removed ? String(removed).length + 2 : 0)
  const arg = clip(toolArg(call.tool, call.input), Math.max(10, columns - call.tool.length - statWidth - 8))
  return (
    <Box key={`transcript-fold-row-${id}`} flexDirection="row" marginTop={1} columnGap={1}>
      <Button key={`transcript-fold-${id}`} plain onPress={() => toggleOpen($, id)}>
        <Text color={isOpen ? 'claude' : DIM}>{isOpen ? '▾ ' : '▸ '}</Text>
        <Text bold color={INK}>
          {call.tool}
        </Text>
        {arg ? <Text color={DIM}>(</Text> : null}
        {arg ? (call.tool === 'Bash' ? shellText(els, arg, `transcript-fold-arg-${id}`) : <Text color={DIM}>{arg}</Text>) : null}
        {arg ? <Text color={DIM}>)</Text> : null}
      </Button>
      {added ? <Text color="diffAddedWord">{`+${added}`}</Text> : null}
      {removed ? <Text color="diffRemovedWord">{`−${removed}`}</Text> : null}
    </Box>
  )
}

// An Edit/Write result: the file, then numbered lines tinted for + and −, CARD_LINES of them until opened.
function fileCard($: Dollar, els: Els, id: string, card: Card, isFull: boolean, columns: number) {
  const { Box, Button, Text } = els
  const rows = cardRows(card.hunks)
  const shown = isFull ? rows : rows.slice(0, CARD_LINES)
  const hidden = rows.length - shown.length
  const width = String(Math.max(0, ...rows.map(r => r.n ?? 0))).length
  const textWidth = Math.max(10, columns - width - 10)
  return (
    <Box key={`transcript-card-${id}`} flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={DIM}>{'⎿  '}</Text>
        <Text color={INK} bold>
          {card.path}
        </Text>
      </Text>
      {shown.map((row, n) =>
        row.sign === '⋯' ? (
          <Text key={`transcript-card-${id}-${n}`} color={RULE}>{`   ${' '.repeat(width)} ⋯`}</Text>
        ) : (
          <Box key={`transcript-card-${id}-${n}`} flexDirection="row">
            <Text color={row.sign === ' ' ? RULE : DIM}>{`   ${String(row.n ?? '').padStart(width)} `}</Text>
            <Text
              color={row.sign === '+' ? 'diffAddedWord' : row.sign === '-' ? 'diffRemovedWord' : INK}
              backgroundColor={row.sign === '+' ? 'diffAdded' : row.sign === '-' ? 'diffRemoved' : undefined}
              wrap="truncate-end"
            >
              {`${row.sign === ' ' ? ' ' : row.sign === '-' ? '−' : '+'} ${clip(row.text, textWidth)}`}
            </Text>
          </Box>
        ),
      )}
      {hidden > 0 || (isFull && rows.length > CARD_LINES) ? (
        <Box key={`transcript-more-row-${id}`} paddingLeft={4 + width}>
          <Button key={`transcript-more-${id}`} plain onPress={() => toggleOpen($, `more:${id}`)}>
            <Text color={DIM}>{isFull ? '▴ fewer lines' : `▾ ${hidden} more lines`}</Text>
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}

async function transcriptCommand($: Dollar, args: string): Promise<string> {
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    await update($, enabled, () => arg === 'on')
    return `Transcript folding and colours ${arg}.`
  }
  if (arg !== '') throw new Error(`/transcript takes on, off or nothing, not "${args.trim()}"`)
  return `Transcript folding and colours are ${(await read($, enabled)) ? 'on' : 'off'}. /transcript on | off`
}

// The working folder, so card headers read relative paths; set at session start.
let root = ''

// ---------------------------------------------------------------- hooks

export const registerTranscript = (on: On) => {
  // Matched, so it does not collide with register.tsx's unmatched session.start.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    root = e.cwd.replace(/\/+$/, '')
    await $.command.register({ name: 'transcript', description: 'Fold finished tool calls and colour Bash: /transcript on | off' })
    return started
  })

  on('command.run', { command: 'transcript' }, async ($, e) => ({ text: await transcriptCommand($, e.args) }))

  // Matched (register.tsx owns the unmatched tool.call): note each main-loop call as live.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    const id = e.tool_use_id
    if (!e.agentId && id) await update($, liveIds, ids => ((ids ?? []).includes(id) ? (ids ?? []) : [...(ids ?? []), id]))
    return next(e)
  })

  on('turn.start', { turnId: /./ }, async ($, e, next) => {
    if (!e.agentId) await update($, liveIds, () => [])
    return next(e)
  })

  // Clearing the live set redraws every row that read it, so the finished turn folds.
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    if (!e.agentId) await update($, liveIds, () => [])
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded || e.surface !== 'terminal') return next(e)
    if (!(await read($, enabled))) return next(e)
    const call = e.props
    if (call.isRunning || call.isErrored || call.isInterrupted) return next(e)
    const els = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 100
    if ((await read($, liveIds)).includes(call.tool_use_id)) return call.tool === 'Bash' ? bashRow(els, call.input, columns) : next(e)
    const isOpen = (await read($, openIds)).includes(call.tool_use_id)
    const line = foldLine($, els, call, isOpen, columns)
    if (!isOpen) return line
    const body = call.tool === 'Bash' ? bashRow(els, call.input, columns) : await next(e)
    const { Box } = els
    return (
      <Box key={`transcript-open-${call.tool_use_id}`} flexDirection="column">
        {line}
        {body}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded || e.surface !== 'terminal') return next(e)
    if (!(await read($, enabled))) return next(e)
    const result = e.props
    if (result.isErrored || isCut(result.output)) return next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    const id = result.tool_use_id
    const isLive = (await read($, liveIds)).includes(id)
    const open = await read($, openIds)
    if (!isLive && !open.includes(id)) return <Box key="transcript-hidden" />
    const card = fileCardOf(result.tool, result.output)
    if (!card) return next(e)
    const path = root && card.path.startsWith(`${root}/`) ? card.path.slice(root.length + 1) : card.path
    return fileCard($, els, id, { ...card, path }, open.includes(`more:${id}`), e.viewport?.columns ?? 100)
  })
}
