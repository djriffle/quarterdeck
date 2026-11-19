import { expect, test } from 'claude-code/testing'

const BASH_USE = {
  plugin: 'quarterdeck',
  component: 'ToolUse',
  requestId: 'tu-bash',
  surface: 'terminal',
  props: {
    tool_use_id: 'tu-bash',
    tool: 'Bash',
    input: { command: 'git log --oneline -n 5 "$HOME" && echo done' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: { stdout: 'ok\n', stderr: '', interrupted: false },
  },
} as const

const PATCH = [
  { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' keep', '-old line', '+new line', '+another', ' tail'] },
]
const EDIT_OUTPUT = {
  filePath: '/x/Kusama/src/a.py',
  oldString: 'old line',
  newString: 'new line\nanother',
  originalFile: null,
  structuredPatch: PATCH,
  userModified: false,
  replaceAll: false,
}

const EDIT_USE = {
  plugin: 'quarterdeck',
  component: 'ToolUse',
  requestId: 'tu-edit',
  surface: 'terminal',
  props: {
    tool_use_id: 'tu-edit',
    tool: 'Edit',
    input: { file_path: '/x/Kusama/src/a.py', old_string: 'old line', new_string: 'new line\nanother' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: EDIT_OUTPUT,
  },
} as const

const EDIT_RESULT = {
  plugin: 'quarterdeck',
  component: 'ToolResult',
  requestId: 'tu-edit',
  surface: 'terminal',
  props: { tool_use_id: 'tu-edit', tool: 'Edit', output: EDIT_OUTPUT, isErrored: false },
} as const

// The engine beneath the plugin: its own row is one Text reading "engine".
const standInEngine = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

// Seeds the open set (a Shaped value, as the atom stores it) and leaves every other key absent.
// `ids` is read on every get, so a test can open a call between two mounts.
const seedOpen = (on: Parameters<Parameters<typeof test>[1]>[1], ids: string[]) =>
  on('state.get', (_, e) => ({
    value: e.key === 'transcript-open' ? { value: { shape: 'transcript-open-1', value: [...ids] }, version: 1 } : { value: undefined, version: 0 },
  }))

test('a finished Bash call folds to one coloured line, hiding the engine row', async ($, on) => {
  standInEngine(on)
  const ui = await $.ui.mount(BASH_USE)
  const fold = await ui.find({ type: 'Button', key: 'transcript-fold-tu-bash' })
  expect(fold).toBeTruthy()
  expect(fold?.text).toContain('Bash')
  expect(fold?.text).toContain('git log --oneline')
  expect(await ui.find({ type: 'Text', text: 'git' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()
  await ui.unmount()
})

test('an open Bash call keeps its toggle and draws the coloured command row', async ($, on) => {
  standInEngine(on)
  seedOpen(on, ['tu-bash'])
  const ui = await $.ui.mount(BASH_USE)
  expect(await ui.find({ type: 'Button', key: 'transcript-fold-tu-bash' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Bash\($/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '"$HOME"' })).toBeTruthy()
  await ui.unmount()
})

test('a folded Edit shows its line counts; open, it shows the engine row', async ($, on) => {
  standInEngine(on)
  const open: string[] = []
  seedOpen(on, open)
  let ui = await $.ui.mount(EDIT_USE)
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '−1' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()
  await ui.unmount()
  open.push('tu-edit')
  ui = await $.ui.mount(EDIT_USE)
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
  await ui.unmount()
})

test('an errored or running call draws exactly as the engine does', async ($, on) => {
  standInEngine(on)
  for (const change of [{ isErrored: true }, { isRunning: true }, { isInterrupted: true }]) {
    const ui = await $.ui.mount({ ...BASH_USE, props: { ...BASH_USE.props, ...change } })
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a folded call hides its result; an open Edit result is a numbered file card', async ($, on) => {
  standInEngine(on)
  const open: string[] = []
  seedOpen(on, open)
  let ui = await $.ui.mount(EDIT_RESULT)
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /a\.py/ })).toBeUndefined()
  await ui.unmount()
  open.push('tu-edit')
  ui = await $.ui.mount(EDIT_RESULT)
  expect(await ui.find({ type: 'Text', text: /src\/a\.py/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '+ new line' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '− old line' })).toBeTruthy()
  // Numbers: kept 3, removed old 4, added new 4 and 5, kept 6.
  expect((await ui.findAll({ type: 'Text', text: /^\s+[0-9]+ $/ })).map(t => t.text.trim())).toEqual(['3', '4', '4', '5', '6'])
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()
  await ui.unmount()
})

test('a long Write card stops at 12 lines with a "more" toggle', async ($, on) => {
  standInEngine(on)
  seedOpen(on, ['tu-write'])
  const content = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`).join('\n') + '\n'
  const ui = await $.ui.mount({
    plugin: 'quarterdeck',
    component: 'ToolResult',
    requestId: 'tu-write',
    surface: 'terminal',
    props: { tool_use_id: 'tu-write', tool: 'Write', isErrored: false, output: { type: 'create', filePath: '/x/b.txt', content, structuredPatch: [], originalFile: null } },
  })
  expect(await ui.find({ type: 'Text', text: '+ line 12' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '+ line 13' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'transcript-more-tu-write' }))?.text).toContain('8 more lines')
  await ui.unmount()
})

test('a result without a patch, open, stays the engine drawing', async ($, on) => {
  standInEngine(on)
  seedOpen(on, ['tu-bash'])
  const ui = await $.ui.mount({
    plugin: 'quarterdeck',
    component: 'ToolResult',
    requestId: 'tu-bash',
    surface: 'terminal',
    props: { tool_use_id: 'tu-bash', tool: 'Bash', isErrored: false, output: { stdout: 'ok', stderr: '', interrupted: false } },
  })
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
  await ui.unmount()
})

test('ctrl+o and other surfaces get the engine row', async ($, on) => {
  standInEngine(on)
  for (const target of [
    { ...BASH_USE, props: { ...BASH_USE.props, isExpanded: true } },
    { ...BASH_USE, surface: 'desktop' as const },
  ]) {
    const ui = await $.ui.mount(target)
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('/transcript off hands every row back to the engine', async ($, on) => {
  standInEngine(on)
  on('state.get', (_, e) => ({
    value: e.key === 'transcript-on' ? { value: { shape: 'transcript-on-1', value: false }, version: 1 } : { value: undefined, version: 0 },
  }))
  const ui = await $.ui.mount(BASH_USE)
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
  await ui.unmount()
})

test('a call of the running turn is not folded', async ($, on) => {
  standInEngine(on)
  on('state.get', (_, e) => ({
    value: e.key === 'transcript-live' ? { value: { shape: 'transcript-live-1', value: ['tu-edit'] }, version: 1 } : { value: undefined, version: 0 },
  }))
  const ui = await $.ui.mount(EDIT_USE)
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a main-loop tool.call draws its row live (coloured, unfolded)', async ($, on) => {
  standInEngine(on)
  on('tool.call', () => ({ result: { stdout: 'ok\n', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-bash' } as never)
  const ui = await $.ui.mount(BASH_USE)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Bash\($/ })).toBeTruthy()
  await ui.unmount()
})
