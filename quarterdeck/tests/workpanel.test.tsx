import { expect, test } from 'claude-code/testing'
import { fakeHost, withSharedFs } from './fakehost'

const SLURM = {
  plugin: 'quarterdeck',
  component: 'Pane',
  requestId: 'slurm',
  props: { title: 'Slurm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const QUEUE = [
  '1000001|myexp-0123456789ab-train_s42|R|21:32|6-00:00:00|node01|gpu',
  '1000002|myexp-0123456789ab-compare|PD|0:00|12:00:00|(Dependency)|gpu',
  '1000003|space_metrics|R|3:53|12:00:00|node02|cpu',
].join('\n')

const slurmTab = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  fakeHost(on, () => ({ exitCode: 0, stdout: QUEUE, stderr: '' }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  return $.ui.mount({ ...SLURM, surface: 'terminal' })
}

test('with slurmJobGroups set, the Slurm tab groups matching jobs and shows their short names', { options: { slurmJobGroups: '^(myexp-[0-9a-f]{12})-(.*)$' } }, async ($, on) => {
  const ui = await slurmTab($, on)
  expect(await ui.find({ type: 'Text', text: /myexp-0123456789ab/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^other/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /train_s42/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Dependency/ })).toBeTruthy()
  await ui.unmount()
})

test('with no slurmJobGroups, the Slurm tab lists every job with no group headers', async ($, on) => {
  const ui = await slurmTab($, on)
  expect(await ui.find({ type: 'Text', text: /myexp-0123456789ab-train_s42/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^other/ })).toBeFalsy()
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
  fakeHost(on, () => ({ exitCode: 0, stdout: QUEUE, stderr: '' }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
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
  withSharedFs(on, (_, e) => {
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
