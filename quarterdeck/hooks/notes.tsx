import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note, NotesBook } from '../types'

// Notes tab: what the person writes down during a session, kept with that session.
// The atom drives the pane (a read while drawing subscribes it); `$.store` under
// `notes-<session id>` is the durable copy (a per-plugin JSON file under the Claude
// Code config dir, so it survives a restart and `claude --resume <id>`, which keeps
// the id); a markdown mirror goes to ~/.claude/mods-data/quarterdeck/notes/<id>.md.

const PANE = 'notes'
const TITLE = 'Notes'
const PANE_BG = 'rgb(20,20,20)'
const INPUT = 'notes-input'

const book = atom({ plugin: 'quarterdeck', key: 'notes-book' } as const, { notes: [], isLoaded: false } as NotesBook, {
  shape: 'notes-book-1',
})

const storeKey = (sessionId: string) => `notes-${sessionId}`

const isNote = (v: unknown): v is Note =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Note).id === 'string' &&
  typeof (v as Note).at === 'number' &&
  typeof (v as Note).text === 'string'

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const toMarkdown = (sessionId: string, notes: Note[]) =>
  [
    `# Notes for session ${sessionId}`,
    '',
    ...(notes.length === 0 ? ['_No notes._', ''] : notes.flatMap(n => [`## ${stamp(n.at)}`, '', n.text, ''])),
  ].join('\n')

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function mirrorPath($: EngineInterface, sessionId: string) {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set: cannot place the notes markdown under ~/.claude/mods-data')
  return `${home.replace(/\/+$/, '')}/.claude/mods-data/quarterdeck/notes/${sessionId}.md`
}

// Reads this session's notes from the store into the atom. A stored value that is
// not a list of notes is an error, never replaced: saving stays refused until fixed.
async function loadNotes($: EngineInterface) {
  const sessionId = await $.session.id()
  const raw = await $.store.get(storeKey(sessionId))
  if (raw !== undefined && !(Array.isArray(raw) && raw.every(isNote)))
    throw new Error(`store key ${storeKey(sessionId)} does not hold a list of notes; not overwriting it`)
  const notes = (raw ?? []) as Note[]
  await update($, book, () => ({ sessionId, notes, isLoaded: true }))
  return notes
}

async function reportError($: EngineInterface, what: string, err: unknown) {
  const message = `${what}: ${errorText(err)}`
  $.ui.log(`quarterdeck notes ${message}`)
  await update($, book, b => ({ ...b, error: message }))
}

// Applies `change` to the session's notes, then stores them and rewrites the mirror.
async function changeNotes($: EngineInterface, change: (notes: Note[]) => Note[]) {
  const sessionId = await $.session.id()
  const held = await read($, book)
  if (!held.isLoaded || held.sessionId !== sessionId) await loadNotes($)
  await update($, book, b => ({ ...b, notes: change(b.notes), error: undefined }))
  const now = await read($, book)
  await $.store.set(storeKey(sessionId), now.notes)
  await $.fs.write(await mirrorPath($, sessionId), toMarkdown(sessionId, now.notes))
  return now.notes
}

async function addNote($: EngineInterface, text: string) {
  const at = await $.clock.now()
  const id = `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return changeNotes($, notes => [...notes, { id, at, text }])
}

async function saveEdit($: EngineInterface, id: string, text: string) {
  const notes = await changeNotes($, list => list.map(n => (n.id === id ? { ...n, text } : n)))
  await update($, book, b => ({ ...b, editing: undefined }))
  return notes
}

async function deleteNote($: EngineInterface, id: string) {
  const notes = await changeNotes($, list => list.filter(n => n.id !== id))
  await update($, book, b => (b.editing === id ? { ...b, editing: undefined } : b))
  return notes
}

async function submitInput($: EngineInterface, value: string) {
  const text = value.trim()
  const editing = (await read($, book)).editing
  if (editing) {
    if (!text) throw new Error('an edited note cannot be empty; delete it instead')
    await saveEdit($, editing, text)
  } else if (text) await addNote($, text)
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, backgroundColor: PANE_BG })
}

function guarded($: EngineInterface, what: string, run: () => Promise<unknown>) {
  run().catch(err => reportError($, what, err))
}

export const registerNotes = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await loadNotes($).catch(err => reportError($, 'loading notes failed', err))
    await $.command.register({
      name: 'notes',
      description: 'Show this session\'s notes; "/notes share" hands them to Claude',
      argumentHint: '[share]',
    })
    await $.command.register({ name: 'note', description: "Add a note to this session's Notes tab", argumentHint: '<text>' })
    // Starts closed (opened by /notes or the HUD's [TABS] button).
    return started
  })

  on('command.run', { command: 'notes' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'share') {
      const sessionId = await $.session.id()
      const held = await read($, book)
      const notes = held.isLoaded && held.sessionId === sessionId ? held.notes : await loadNotes($)
      if (notes.length === 0) return { text: 'No notes to share yet.' }
      return {
        text: `Shared ${notes.length} note${notes.length === 1 ? '' : 's'} with Claude.`,
        context: [`The user's notes for this session (from the Notes tab):\n\n${toMarkdown(sessionId, notes)}`],
      }
    }
    if (arg !== '') return { text: `Unknown /notes argument "${arg}". Use /notes, or /notes share.` }
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Notes tab opened.' : `Notes tab not placed: ${opened.reason}` }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /note <text>' }
    const notes = await addNote($, text).catch(async err => {
      await reportError($, 'saving the note failed', err)
      throw err
    })
    return { text: `Note added (${notes.length} in this session).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const b = await read($, book)
    const editing = b.editing ? b.notes.find(n => n.id === b.editing) : undefined
    const rule = Math.max(8, Math.min(60, (e.props.bodyColumns ?? 40) - 2))
    return (
      <Box flexDirection="column">
        <Text>
          <Text backgroundColor="suggestion" color="inverseText" bold>
            {' NOTES '}
          </Text>
          <Text color="suggestion"> ▸▸ </Text>
          <Text color="suggestion">{b.notes.length}</Text>
          <Text color="inactive"> this session</Text>
        </Text>
        {b.error && <Text color="error">{b.error}</Text>}
        {!b.isLoaded && !b.error && <Text dimColor>loading…</Text>}
        {b.isLoaded && b.notes.length === 0 && <Text dimColor>No notes yet. Type below, or /note &lt;text&gt;.</Text>}
        {b.notes.map(n => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color="inactive">{stamp(n.at)} </Text>
              <Button key={`notes-edit-${n.id}`} plain dimColor onPress={() => update($, book, x => ({ ...x, editing: n.id }))}>
                edit
              </Button>
              <Text> </Text>
              <Button key={`notes-del-${n.id}`} plain dimColor onPress={() => guarded($, 'deleting the note failed', () => deleteNote($, n.id))}>
                ✕
              </Button>
            </Box>
            <Text>
              <Text color={n.id === b.editing ? 'warning' : 'claude'}>▌</Text>
              <Text>{n.text}</Text>
            </Text>
          </Box>
        ))}
        <Text color="subtle">{'─'.repeat(rule)}</Text>
        {editing && (
          <Box flexDirection="row">
            <Text color="warning">editing {stamp(editing.at)} </Text>
            <Button key="notes-cancel" plain dimColor onPress={() => update($, book, x => ({ ...x, editing: undefined }))}>
              cancel
            </Button>
          </Box>
        )}
        <Input
          key={INPUT}
          rows={3}
          autoFocus
          placeholder="Write a note… (Enter saves)"
          submitLabel={editing ? 'save' : 'add'}
          value={editing ? editing.text : ''}
          onSubmit={value => guarded($, 'saving the note failed', () => submitInput($, value))}
        />
      </Box>
    )
  })
}
