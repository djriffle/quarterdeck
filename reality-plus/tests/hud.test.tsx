import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'reality-plus',
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
  const row = await ui.find({ type: "Text", text: /SLURM/ })
  expect(row).toBeTruthy()
  await ui.unmount()
})
