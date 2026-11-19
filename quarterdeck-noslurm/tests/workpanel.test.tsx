import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'quarterdeck-noslurm',
  component: 'Pane',
  requestId: 'work-panel',
  props: { title: 'Work', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('worktree rows draw their health line', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  const ok = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('git worktree list')) return ok('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-12\nHEAD def1234\nbranch refs/heads/feat-12-x\n')
    if (a.includes('origin/HEAD')) return ok('origin/main\n')
    if (a.includes('status --porcelain')) return ok(a.includes('/repo-12') ? ' M a.py\n?? b.py\n' : '')
    if (a.includes('rev-list')) return ok('1\t3\n')
    if (a.includes('merge-base')) return ok('', 1)
    if (a.includes('log -1')) return ok('2 days ago\n')
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, requestId: 'work-panel', props: { ...PANE.props, title: 'Work' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2 changed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /↑3/ })).toBeTruthy()
  await ui.unmount()
})
