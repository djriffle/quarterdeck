import { expect, test } from 'claude-code/testing'

const PANE = (requestId: string, title: string) =>
  ({
    plugin: 'quarterdeck',
    component: 'Pane',
    requestId,
    props: { title, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

test('/toggle-git stops git and gh polling, hides their errors, and resumes', async ($, on) => {
  const calls: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'look at #12', toolUses: [] }] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    calls.push(e.argv[0])
    const isRepoTool = e.argv[0] === 'git' || e.argv[0] === 'gh'
    return {
      value: { exitCode: isRepoTool ? 128 : 0, stdout: '', stderr: isRepoTool ? 'fatal: not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: '/not-a-repo', surface: 'terminal', isInteractive: true })

  const before = await $.ui.mount({ ...PANE('git', 'Git'), surface: 'terminal' })
  expect(await before.find({ type: 'Text', text: /not a git repository/ })).toBeTruthy()
  await before.unmount()

  const off = await $.command.run({ command: 'toggle-git', args: '' })
  expect(off.text).toMatch(/off/)
  calls.length = 0
  for (const [id, title] of [['git', 'Git'], ['work-panel', 'Work']]) {
    const ui = await $.ui.mount({ ...PANE(id, title), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /git polling off/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeFalsy()
    await ui.unmount()
  }
  expect(calls.filter(c => c === 'git' || c === 'gh')).toEqual([])

  const back = await $.command.run({ command: 'toggle-git', args: '' })
  expect(back.text).toMatch(/on/)
  await new Promise(r => setTimeout(r, 50))
  expect(calls.filter(c => c === 'git' || c === 'gh').length).toBeGreaterThan(0)
})
