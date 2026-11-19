import { expect, mock, test } from 'claude-code/testing'

import { compactInstructions, filesInPlay, openTasks, parseThreads, transcriptText } from '../hooks/wrapup'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const PANE = {
  plugin: 'quarterdeck-noslurm',
  component: 'Pane',
  requestId: 'wrapup',
  surface: 'terminal',
  props: {
    title: 'Wrap up',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MESSAGES = [
  { role: 'user', text: 'Fix the HUD and then the slurm launcher', toolUses: [] },
  {
    role: 'assistant',
    text: 'On it.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/hooks/register.tsx' } },
      { tool_use_id: 't2', tool: 'Edit', input: { file_path: '/repo/slurm/launch.sh' } },
      { tool_use_id: 't3', tool: 'TaskCreate', input: { subject: 'Fix HUD' }, result: { task: { id: '1', subject: 'Fix HUD' } } },
      { tool_use_id: 't4', tool: 'TaskCreate', input: { subject: 'Fix launcher' }, result: { task: { id: '2', subject: 'Fix launcher' } } },
      { tool_use_id: 't5', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      { tool_use_id: 't6', tool: 'Read', input: { file_path: '/repo/hooks/register.tsx' } },
    ],
  },
]

const THREADS = JSON.stringify({ threads: ['HUD strip: fixed', 'Slurm launcher: half done'], name: 'hud and launcher' })

type World = { fills: string[]; runs: string[]; prompts: Record<string, string>; toasts: string[]; settle: () => Promise<void> }

function world(on: any, opts: { haiku?: unknown; clearThrows?: boolean } = {}): World {
  mock.store(on)
  const clock = mock.clock(on)
  const w: World = { fills: [], runs: [], prompts: {}, toasts: [], settle: () => clock.settle() }
  on('command.register', () => ({ value: { command: 'wrap-up' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_$: unknown, e: { model: string; prompt: string }) => {
    w.prompts[e.model] = e.prompt
    if (e.model === 'haiku') return { value: opts.haiku ?? { isAnswered: true, text: THREADS, usage: USAGE } }
    return { value: { isAnswered: true, text: '  ## Handoff\nFinish the launcher.  ', usage: USAGE } }
  })
  on('command.run', (_$: unknown, e: { command: string; args: string }) => {
    w.runs.push(`${e.command} ${e.args ?? ''}`.trim())
    if (e.command === 'clear' && opts.clearThrows) throw new Error('not allowed from a plugin')
    return { text: '' }
  })
  on('prompt.fill', (_$: unknown, e: { text: string }) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  return w
}

async function openCard($: any, w: World) {
  await $.command.run({ command: 'wrap-up', args: '' })
  const ui = await $.ui.mount(PANE)
  await w.settle() // the unawaited Haiku read lands
  return ui
}

test('files, open tasks and the transcript are read from the tool calls', () => {
  expect(filesInPlay(MESSAGES as never)).toEqual(['/repo/hooks/register.tsx', '/repo/slurm/launch.sh'])
  expect(openTasks(MESSAGES as never)).toEqual(['Fix launcher'])
  const t = transcriptText(MESSAGES as never, 40)
  expect(t.isTruncated).toBe(true)
  expect(t.text.length).toBe(40)
  expect(transcriptText(MESSAGES as never).text).toContain('[Edit /repo/slurm/launch.sh]')
})

test("Haiku's threads must be JSON with a threads list; anything else throws", () => {
  expect(parseThreads('```json\n' + THREADS + '\n```')).toEqual({ threads: ['HUD strip: fixed', 'Slurm launcher: half done'], name: 'hud and launcher' })
  expect(() => parseThreads('Sure! Here are the threads')).toThrow(/did not answer JSON/)
  expect(() => parseThreads('{"name":"x"}')).toThrow(/no "threads"/)
})

test('the card shows threads, carried items and a rename; a dropped thread leaves the /compact keep list', async ($, on) => {
  const w = world(on)
  const ui = await openCard($, w)
  expect((await ui.find({ key: 'wrapup-thread-0' }))?.text).toBe('■ keep HUD strip: fixed')
  expect(await ui.find({ type: 'Text', text: /files in play \(2\): register\.tsx, launch\.sh/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /open tasks \(1\): Fix launcher/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\/rename hud and launcher/ })).toBeTruthy()
  expect(w.prompts.haiku).toContain('Fix the HUD')

  await ui.press({ key: 'wrapup-thread-0' })
  await ui.press({ key: 'wrapup-name' })
  await w.settle()
  expect((await ui.find({ key: 'wrapup-thread-0' }))?.text).toBe('□ drop HUD strip: fixed')

  await ui.press({ key: 'wrapup-compact' })
  await w.settle()
  expect(w.fills).toHaveLength(1)
  expect(w.fills[0]).toMatch(/^\/compact Keep in detail: Slurm launcher: half done\. Summarise in one line at most, or drop: HUD strip: fixed\./)
  expect(w.fills[0]).toContain('Keep the open tasks: Fix launcher.')
  expect(w.runs).toEqual([]) // the rename was toggled off
  await ui.unmount()
})

test('a Haiku failure shows in red on the card', async ($, on) => {
  const w = world(on, { haiku: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: USAGE } })
  await $.command.run({ command: 'wrap-up', args: '' })
  const ui = await $.ui.mount(PANE)
  await w.settle()
  const row = await ui.find({ type: 'Text', text: /Haiku gave no threads/ })
  expect(row?.text).toContain('api-error 529')
  expect(row?.props?.color).toBe('error')
  await ui.unmount()
})

test('Handoff asks Sonnet with the scope, runs /clear, renames the fresh session and fills the handoff', async ($, on) => {
  const w = world(on)
  const ui = await openCard($, w)
  await ui.press({ key: 'wrapup-handoff' })
  await w.settle()
  expect(w.prompts.sonnet).toContain('KEEP: Slurm launcher: half done')
  expect(w.prompts.sonnet).toContain('KEEP open tasks: Fix launcher')
  expect(w.runs).toEqual(['clear', 'rename hud and launcher'])
  expect(w.fills).toEqual(['## Handoff\nFinish the launcher.'])
  await ui.unmount()
})

test('a refused /clear fills /clear for the person and says so', async ($, on) => {
  const w = world(on, { clearThrows: true })
  const ui = await openCard($, w)
  await ui.press({ key: 'wrapup-handoff' })
  await w.settle()
  expect(w.fills).toEqual(['/clear'])
  expect(w.toasts.join('\n')).toMatch(/Press Enter on \/clear/)
  await ui.unmount()
})

test('compact instructions name nothing when nothing is kept', () => {
  expect(
    compactInstructions({ phase: 'ready', token: 1, threads: [], files: ['/a'], tasks: [], isFilesKept: false, isTasksKept: true, isNameKept: true, isTruncated: false }),
  ).toBe('')
})
