import { expect, test } from 'claude-code/testing'

const SLURM = {
  plugin: 'reality-plus',
  component: 'Pane',
  requestId: 'slurm',
  props: { title: 'Slurm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const QUEUE = [
  '7036738|kusama-56e9b7322acc-g_kusama_scrambled-s42.train_refit_g|R|21:32|6-00:00:00|iscb022|peerd',
  '7332900|kusama-56e9b7322acc-compare|PD|0:00|12:00:00|(Dependency)|peerd',
  '7332823|space_metrics|R|3:53|12:00:00|iscb013|peerd',
].join('\n')

test('the Slurm tab groups jobs by experiment', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'squeue' ? QUEUE : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...SLURM, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /exp 56e9b7322acc/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /g_kusama_scrambled/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Dependency/ })).toBeTruthy()
  await ui.unmount()
})

test('the Work tab previews Slurm ', async ($, on) => {
  const opened: string[] = []
  const focused: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.focus', (_, e) => {
    focused.push(`${e.requestId}:${e.key}`)
    return {}
  })
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'squeue' ? QUEUE : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...SLURM, requestId: 'work-panel', props: { ...SLURM.props, title: 'Work' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /space_metrics/ })).toBeTruthy()
  await ui.unmount()
})

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
  const ui = await $.ui.mount({ ...SLURM, requestId: 'work-panel', props: { ...SLURM.props, title: 'Work' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2 changed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /↑3/ })).toBeTruthy()
  await ui.unmount()
})
