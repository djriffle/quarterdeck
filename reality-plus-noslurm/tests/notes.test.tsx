import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

const PANE = {
  plugin: 'reality-plus-noslurm',
  component: 'Pane',
  requestId: 'notes',
  props: {
    title: 'Notes',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SEEDED = [
  { id: 'n1', at: Date.UTC(2026, 10, 5, 9, 30), text: 'check the s42 smoke' },
  { id: 'n2', at: Date.UTC(2026, 10, 5, 10, 15), text: 'ask Dana about pAKT' },
]

// The plugin's store, held in memory so a test can read what the mod stored.
const store = (on: On, entries: Record<string, unknown> = {}) => {
  const held: Record<string, unknown> = { ...entries }
  on('store.get', (_, e) => ({ value: held[e.key] }))
  on('store.set', (_, e) => {
    held[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return held
}

// Stands for the engine under every session.start hook of the mod (siblings included).
const engine = (on: On, writes: { path: string; text: string }[]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-abc' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: Date.UTC(2026, 10, 5, 12, 0) })
}

test('the pane shows the notes stored for this session', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, writes)
  const held = store(on, { 'notes-sess-abc': SEEDED, 'notes-other': [{ id: 'x', at: 0, text: 'not mine' }] })
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /check the s42 smoke/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /ask Dana about pAKT/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not mine/ })).toBeUndefined()
  expect(await ui.find({ key: 'notes-del-n1' })).toBeTruthy()
  expect(await ui.find({ key: 'notes-input' })).toBeTruthy()
  expect(writes).toHaveLength(0)
  await ui.unmount()
})

test('typing in the pane appends a note, stores it and mirrors it as markdown', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, writes)
  const held = store(on, { 'notes-sess-abc': SEEDED })
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'notes-input', text: 'rerun p1_cell_cycle_dapi' })
  expect((await ui.find({ type: 'Text', text: /rerun p1_cell_cycle_dapi/ }))?.text).toBeTruthy()

  const stored = held['notes-sess-abc'] as { text: string }[]
  expect(stored.map(n => n.text)).toEqual(['check the s42 smoke', 'ask Dana about pAKT', 'rerun p1_cell_cycle_dapi'])
  expect(writes.at(-1)?.path).toBe('/home/t/.claude/mods-data/reality-plus-noslurm/notes/sess-abc.md')
  expect(writes.at(-1)?.text).toContain('rerun p1_cell_cycle_dapi')
  expect(writes.at(-1)?.text).toContain('# Notes for session sess-abc')

  await ui.press({ key: 'notes-del-n1' })
  expect(await ui.find({ type: 'Text', text: /check the s42 smoke/ })).toBeUndefined()
  expect((held['notes-sess-abc'] as unknown[]).length).toBe(2)
  await ui.unmount()
})

test('editing a note replaces its text', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, writes)
  const held = store(on, { 'notes-sess-abc': SEEDED })
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'notes-edit-n2' })
  expect(await ui.find({ key: 'notes-cancel' })).toBeTruthy()
  await ui.input({ key: 'notes-input', text: 'ask Dana about pS6 too' })
  expect((await ui.find({ type: 'Text', text: /pS6 too/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /about pAKT/ })).toBeUndefined()
  expect(await ui.find({ key: 'notes-cancel' })).toBeUndefined()
  await ui.unmount()
})

test('/note appends from the prompt and /notes share hands them to Claude', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, writes)
  store(on)
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No notes yet/ })).toBeTruthy()

  const added = await $.command.run({ command: 'note', args: 'the latent walk uses GPCCA' })
  expect(added.text).toBe('Note added (1 in this session).')
  expect((await ui.find({ type: 'Text', text: /latent walk uses GPCCA/ }))?.text).toBeTruthy()
  expect(writes.at(-1)?.path).toBe('/home/t/.claude/mods-data/reality-plus-noslurm/notes/sess-abc.md')

  const shared = await $.command.run({ command: 'notes', args: 'share' })
  expect(shared.text).toBe('Shared 1 note with Claude.')
  expect(shared.context?.[0]).toContain('the latent walk uses GPCCA')

  expect((await $.command.run({ command: 'note', args: '  ' })).text).toBe('Usage: /note <text>')
  await ui.unmount()
})

test('a stored value that is not a list of notes shows in red and is never overwritten', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  engine(on, writes)
  const held = store(on, { 'notes-sess-abc': { broken: true } })
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /loading notes failed/ }))?.text).toContain('not overwriting')
  await ui.input({ key: 'notes-input', text: 'should not land' })
  expect(held['notes-sess-abc']).toEqual({ broken: true })
  expect(writes).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /saving the note failed/ }))?.text).toBeTruthy()
  await ui.unmount()
})
