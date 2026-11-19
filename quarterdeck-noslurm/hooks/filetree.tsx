import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileEntry, FileHunk, FileLog, FileView } from '../types'

// "Files" pane: what Claude read and changed this session, grouped by folder,
// with a replay of each changed file's diff hunks. Idea after mod-file-tree in
// v-amorim/moonlight-claude-mods (MIT); the code here is our own.

type $ = EngineInterface

const PANE = 'files'
const TITLE = 'Files'
const PANE_BG = 'rgb(20,20,20)'
const TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'] as const

const MAX_FILES = 400
const MAX_HUNKS = 8 // newest hunks kept per file
const MAX_HUNK_LINES = 300 // lines kept per hunk
const SHOWN_LINES = 40 // diff lines drawn before the "N more" toggle
const MAX_TOTAL_LINES = 4000 // hunk lines kept across all files, newest files first

const log = atom({ plugin: 'quarterdeck-noslurm', key: 'files-log' } as const, { files: {}, seq: 0 } as FileLog, { shape: 'files-log-1' })
const view = atom({ plugin: 'quarterdeck-noslurm', key: 'files-view' } as const, { showAll: false } as FileView, { shape: 'files-view-1' })
const folded = atom({ plugin: 'quarterdeck-noslurm', key: 'files-folded' } as const, {} as Record<string, true>, { shape: 'files-folded-1' })

type Patch = { oldStart: number; newStart: number; lines: string[] }
type Touch = {
  path: string
  kind: 'read' | 'edit' | 'write' | 'create' | 'notebook'
  hunks: Patch[] // what changed; a start of 0 means the lines are not numbered
  stored: boolean // false: no record of the real diff was kept
  agent: boolean
}

const capHunk = (p: Patch, tool: string, agent: boolean): FileHunk => ({
  oldStart: p.oldStart,
  newStart: p.newStart,
  lines: p.lines.slice(0, MAX_HUNK_LINES),
  cut: Math.max(0, p.lines.length - MAX_HUNK_LINES),
  tool,
  agent,
})

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

// Fold one touch into the log; pure, so live hooks and seeding share it.
const apply = (lg: FileLog, t: Touch): FileLog => {
  const seq = lg.seq + 1
  const old: FileEntry = lg.files[t.path] ?? { reads: 0, edits: 0, added: 0, removed: 0, hunks: [], seq }
  const entry: FileEntry = { ...old, seq, agent: old.agent || t.agent }
  if (t.kind === 'read') entry.reads += 1
  else {
    entry.edits += 1
    if (t.kind === 'create') entry.created = true
    if (!t.stored) entry.unstored = (entry.unstored ?? 0) + 1
    for (const p of t.hunks) {
      entry.added += p.lines.filter(l => l.startsWith('+')).length
      entry.removed += p.lines.filter(l => l.startsWith('-')).length
    }
    const tool = t.kind === 'notebook' ? 'NotebookEdit' : t.kind === 'edit' ? 'Edit' : 'Write'
    entry.hunks = [...entry.hunks, ...t.hunks.map(p => capHunk(p, tool, t.agent))].slice(-MAX_HUNKS)
  }
  let files = { ...lg.files, [t.path]: entry }
  const paths = Object.keys(files)
  if (paths.length > MAX_FILES) {
    const keep = paths.sort((a, b) => files[b].seq - files[a].seq).slice(0, MAX_FILES)
    files = Object.fromEntries(keep.map(p => [p, files[p]]))
  }
  // Total budget: older files lose their hunks (counts stay) and say so in the pane.
  let budget = MAX_TOTAL_LINES
  for (const p of Object.keys(files).sort((a, b) => files[b].seq - files[a].seq)) {
    const f = files[p]
    const lines = f.hunks.reduce((n, hunk) => n + hunk.lines.length, 0)
    if (lines <= budget) budget -= lines
    else if (f.hunks.length > 0) {
      budget = 0
      files[p] = { ...f, hunks: [], dropped: (f.dropped ?? 0) + f.hunks.length }
    }
  }
  return { files, seq }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// One tool use (live or from the transcript) as a Touch; undefined for one that changed nothing.
// `result` absent means the transcript stored no record (a subagent's never does).
const toTouch = (tool: string, input: Record<string, unknown>, result: unknown, agent: boolean): Touch | undefined => {
  const res = result as Record<string, unknown> | undefined
  if (tool === 'Read') {
    const path = str(input.file_path)
    return path ? { path, kind: 'read', hunks: [], stored: true, agent } : undefined
  }
  if (tool === 'NotebookEdit') {
    const path = str(res?.notebook_path) ?? str(input.notebook_path)
    if (!path) return undefined
    const before = str(res?.old_source) ?? ''
    const after = str(res?.new_source) ?? str(input.new_source) ?? ''
    const lines = [...splitLines(before).map(l => `-${l}`), ...splitLines(after).map(l => `+${l}`)]
    return { path, kind: 'notebook', hunks: [{ oldStart: 0, newStart: 0, lines }], stored: res !== undefined, agent }
  }
  if (tool !== 'Edit' && tool !== 'Write') return undefined
  if (res?.staged === true) return undefined // held for review: the file is unchanged
  const path = str(res?.filePath) ?? str(input.file_path)
  if (!path) return undefined
  const patch = res?.structuredPatch as Patch[] | undefined
  if (res && patch) {
    if (tool === 'Write' && res.type === 'create' && patch.length === 0) {
      // A new file's diff is its whole content.
      const lines = splitLines(str(res.content) ?? '').map(l => `+${l}`)
      return { path, kind: 'create', hunks: [{ oldStart: 0, newStart: 1, lines }], stored: true, agent }
    }
    // An update with an empty patch and no originalFile was too large to diff.
    const stored = !(tool === 'Write' && patch.length === 0 && res.originalFile === null)
    const kind = tool === 'Edit' ? 'edit' : res.type === 'create' ? 'create' : 'write'
    return { path, kind, hunks: patch.map(p => ({ oldStart: p.oldStart, newStart: p.newStart, lines: p.lines })), stored, agent }
  }
  // No stored record: the input still says what was asked for, unnumbered and marked so.
  if (tool === 'Edit') {
    const lines = [
      ...splitLines(str(input.old_string) ?? '').map(l => `-${l}`),
      ...splitLines(str(input.new_string) ?? '').map(l => `+${l}`),
    ]
    return { path, kind: 'edit', hunks: [{ oldStart: 0, newStart: 0, lines }], stored: false, agent }
  }
  const lines = splitLines(str(input.content) ?? '').map(l => `+${l}`)
  return { path, kind: 'write', hunks: [{ oldStart: 0, newStart: 0, lines }], stored: false, agent }
}

type Use = { tool: string; input: Record<string, unknown>; result?: unknown; isError?: true; agentId?: string }

// Rebuild the log from the transcript: the main conversation, and each subagent it spawned.
async function seed($: $) {
  const main = await $.session.messages()
  if ('deny' in main) throw new Error(`session.messages denied: ${String(main.deny)}`)
  let lg: FileLog = { files: {}, seq: 0 }
  const take = (u: Use, agent: boolean) => {
    if (u.isError) return
    const t = toTouch(u.tool, u.input, u.result, agent)
    if (t) lg = apply(lg, t)
  }
  for (const m of main) {
    for (const u of m.toolUses as Use[]) {
      take(u, false)
      if (!u.agentId) continue
      const sub = await $.session.messages({ agentId: u.agentId })
      if ('deny' in sub) {
        $.ui.log(`quarterdeck files: agent ${u.agentId} transcript denied: ${String(sub.deny)}`)
        continue
      }
      for (const sm of sub) for (const su of sm.toolUses as Use[]) take(su, true)
    }
  }
  await update($, log, () => lg)
}

async function record($: $, t: Touch) {
  await update($, log, lg => apply(lg, t))
}

function toggleFile($: $, path: string) {
  update($, view, v => (v.open === path ? { showAll: false } : { open: path, showAll: false })).catch(err =>
    $.ui.log(`quarterdeck files: opening ${path} failed: ${String(err)}`),
  )
}

function toggleMore($: $) {
  update($, view, v => ({ ...v, showAll: !v.showAll })).catch(err => $.ui.log(`quarterdeck files: toggling more failed: ${String(err)}`))
}

function toggleFolder($: $, dir: string) {
  update($, folded, f => {
    const next = { ...f }
    if (next[dir]) delete next[dir]
    else next[dir] = true
    return next
  }).catch(err => $.ui.log(`quarterdeck files: folding ${dir} failed: ${String(err)}`))
}

const relTo = (cwd: string, path: string) => {
  const base = cwd.replace(/\/+$/, '') + '/'
  return path.startsWith(base) ? path.slice(base.length) : path
}

const splitPath = (rel: string) => {
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '.', name: rel } : { dir: rel.slice(0, i) || '/', name: rel.slice(i + 1) }
}

export const registerFileTree = (on: Parameters<Register>[0]) => {
  // Matched (interactive sessions only): register.tsx holds the one unmatched session.start,
  // and a headless session has no pane to show.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'files', description: 'Show the files Claude read and changed this session in a pane' })
    // Starts closed (opened by /files or the HUD's [TABS] button).
    seed($).catch(err => $.ui.log(`quarterdeck files: seeding from the transcript failed: ${String(err)}`))
    return started
  })

  on('command.run', { command: 'files' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, backgroundColor: PANE_BG })
    return { text: opened.isPlaced ? 'Files pane opened.' : 'Files pane could not be placed on this surface.' }
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const r = await next(e)
      if (!('result' in r) || r.isError) return r
      const t = toTouch(e.tool, e as unknown as Record<string, unknown>, r.result, e.agentId !== undefined)
      if (t) record($, t).catch(err => $.ui.log(`quarterdeck files: recording ${e.tool} failed: ${String(err)}`))
      return r
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lg = await read($, log)
    const v = await read($, view)
    const fold = await read($, folded)
    const cwd = await $.session.cwd()

    const entries = Object.entries(lg.files).map(([path, f]) => ({ path, f, ...splitPath(relTo(cwd, path)) }))
    const changed = entries.filter(x => x.f.edits > 0).length
    const dirs = [...new Set(entries.map(x => x.dir))].sort()

    const open = v.open ? lg.files[v.open] : undefined
    const diffRows: unknown[] = []
    if (open) {
      let budget = v.showAll ? Infinity : SHOWN_LINES
      let hidden = 0
      open.hunks.forEach((hunk, i) => {
        const numbered = hunk.oldStart > 0 || hunk.newStart > 0
        if (budget <= 0) {
          hidden += hunk.lines.length
          return
        }
        diffRows.push(
          <Text color="inactive" wrap="truncate-end">
            {numbered ? `@@ −${hunk.oldStart} +${hunk.newStart} @@` : '@@ not numbered: no stored diff @@'}
            {` ${hunk.tool}${hunk.agent ? ' · subagent' : ''}`}
          </Text>,
        )
        let oldN = hunk.oldStart
        let newN = hunk.newStart
        for (const line of hunk.lines) {
          const mark = line[0]
          const n = mark === '-' ? oldN : newN
          if (mark === '-') oldN += 1
          else if (mark === '+') newN += 1
          else {
            oldN += 1
            newN += 1
          }
          if (budget <= 0) {
            hidden += 1
            continue
          }
          budget -= 1
          const num = numbered && n > 0 ? String(n).padStart(4) : '    '
          const isAdd = mark === '+'
          const isDel = mark === '-'
          diffRows.push(
            <Text wrap="truncate-end" backgroundColor={isAdd ? 'diffAdded' : isDel ? 'diffRemoved' : undefined}>
              <Text color="inactive">{num} </Text>
              <Text color={isAdd ? 'success' : isDel ? 'error' : 'inactive'}>{isAdd || isDel ? mark : ' '} </Text>
              {line.slice(1)}
            </Text>,
          )
        }
        if (hunk.cut > 0) diffRows.push(<Text color="inactive">{`     … ${hunk.cut} lines not kept`}</Text>)
        if (i < open.hunks.length - 1 && budget > 0) diffRows.push(<Text> </Text>)
      })
      if (hidden > 0 || v.showAll) {
        diffRows.push(
          <Button key="files-more" plain onPress={() => toggleMore($)}>
            <Text color="warning">{v.showAll ? '▴ show less' : `▾ ${hidden} more lines`}</Text>
          </Button>,
        )
      }
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text backgroundColor="suggestion" color="inverseText" bold>
            {' FILES '}
          </Text>
          <Text color="suggestion"> ▸▸ </Text>
          <Text color="suggestion">{changed} changed</Text>
          <Text color="inactive"> · {entries.length - changed} read</Text>
        </Text>
        {entries.length === 0 && <Text dimColor>none yet: files Claude reads or edits show up here</Text>}
        {dirs.map(dir => {
          const inDir = entries.filter(x => x.dir === dir).sort((a, b) => a.name.localeCompare(b.name))
          const isFolded = fold[dir] === true
          return (
            <Box flexDirection="column">
              <Button key={`dir:${dir}`} plain onPress={() => toggleFolder($, dir)}>
                <Text color="claude">{isFolded ? '▸ ' : '▾ '}</Text>
                <Text color="claude" bold>{dir === '.' ? './' : `${dir}/`}</Text>
                <Text color="inactive">{isFolded ? ` ${inDir.length} files` : ''}</Text>
              </Button>
              {!isFolded &&
                inDir.map(x => {
                  const isEdited = x.f.edits > 0
                  return (
                    <Button key={`file:${x.path}`} plain onPress={() => toggleFile($, x.path)}>
                      {'  '}
                      <Text color={isEdited ? 'warning' : 'inactive'}>{x.f.created ? '✚ ' : isEdited ? '● ' : '○ '}</Text>
                      <Text bold={v.open === x.path} color={isEdited ? undefined : 'inactive'}>{x.name}</Text>
                      {isEdited && <Text color="success">{` +${x.f.added}`}</Text>}
                      {isEdited && <Text color="error">{` −${x.f.removed}`}</Text>}
                      {!isEdited && <Text color="subtle"> read</Text>}
                      {x.f.agent && <Text color="inactive"> ⑂ subagent</Text>}
                    </Button>
                  )
                })}
            </Box>
          )
        })}

        {v.open && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text wrap="truncate-end">
              <Text backgroundColor="suggestion" color="inverseText" bold>
                {' DIFF '}
              </Text>
              <Text color="suggestion"> ▸▸ </Text>
              <Text color="claude">{relTo(cwd, v.open)}</Text>
            </Text>
            {!open && <Text color="error">this file is no longer in the log</Text>}
            {open && open.edits === 0 && <Text dimColor>read only: no edits to replay</Text>}
            {open && (open.unstored ?? 0) > 0 && (
              <Text color="warning" wrap="truncate-end">
                {`${open.unstored} change${open.unstored === 1 ? '' : 's'} without a stored diff (shown from the request, unnumbered)`}
              </Text>
            )}
            {open && (open.dropped ?? 0) > 0 && (
              <Text color="inactive">{`${open.dropped} older hunk${open.dropped === 1 ? '' : 's'} not kept (pane line budget)`}</Text>
            )}
            {diffRows}
            <Button key="files-close" plain onPress={() => toggleFile($, v.open as string)}>
              <Text color="inactive">✕ close</Text>
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
