import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'quarterdeck-noslurm',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the HUD strip draws on the terminal', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'abc' }))
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /KUSAMA/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /SLURM/ })).toBeFalsy()
  await ui.unmount()
})

test('/waiting draws a green box with a running shell, a monitor and a finished agent', async ($, on) => {
  const seeded: Record<string, unknown> = {
    'waiting-on': true,
    'waiting-phase': 30,
    'waiting-items': {
      shape: 'waiting-2',
      value: {
        'task:b1': { kind: 'shell', label: 'pytest tests', startedAt: Date.now() - 65_000 },
        'task:m1': { kind: 'monitor', label: 'tail slurm log', startedAt: Date.now() - 5_000 },
        'agent:a1': { kind: 'agent', label: 'survey files', startedAt: 0, endedAt: 12_000, endedPhase: 2, ok: true, status: 'completed' },
      },
    },
  }
  on('state.get', (_, e) => (e.key in seeded ? { value: { value: seeded[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'abc' }))
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /WAITING/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /pytest tests/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /tail slurm log/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /✔/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /done · 12s/ })).toBeTruthy()
  await ui.unmount()
})

test('the session name comes from the sidecar custom-title.json when the transcript has none', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const out = e.argv[0] === 'find' ? '/h/.claude/projects/p/abc.jsonl\n' : e.argv[0] === 'printenv' ? '/h\n' : 'main\n'
    return { value: { exitCode: e.argv[0] === 'grep' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'abc' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/h/.claude/projects/p/abc/custom-title.json' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('custom-title.json') ? '{"customTitle":"creating /waiting in mod"}' : '' }))
  await $.session.start({ cwd: '/x/Kusama', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'creating /waiting in mod' })).toBeTruthy()
  await ui.unmount()
})
