import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fakehost'

const PANE = (requestId: string, title: string) =>
  ({
    plugin: 'quarterdeck',
    component: 'Pane',
    requestId,
    props: { title, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const


test('/toggle-slurm stops squeue polling, hides old jobs and errors, and resumes', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  const { calls } = fakeHost(on, () => ({ exitCode: 0, stdout: '123|train|R|1:00|2:00|node1|gpu\n', stderr: '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const before = await $.ui.mount({ ...PANE('slurm', 'Slurm'), surface: 'terminal' })
  expect(await before.find({ type: 'Text', text: /train/ })).toBeTruthy()
  await before.unmount()

  const off = await $.command.run({ command: 'toggle-slurm', args: '' })
  expect(off.text).toMatch(/off/)
  calls.length = 0
  for (const [id, title] of [['slurm', 'Slurm'], ['work-panel', 'Work']]) {
    const ui = await $.ui.mount({ ...PANE(id, title), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /slurm polling off/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /train/ })).toBeFalsy()
    await ui.unmount()
  }
  expect(calls.filter(c => c === 'squeue')).toEqual([])

  const back = await $.command.run({ command: 'toggle-slurm', args: '' })
  expect(back.text).toMatch(/on/)
  await new Promise(r => setTimeout(r, 50))
  expect(calls.filter(c => c === 'squeue').length).toBeGreaterThan(0)
})

import { squeueError, squeueSnapshot } from '../hooks/workpanel'
import { failed, isDue, sharedKey } from '../hooks/sharedpoll'

test('a shared poll is due every 20 s, every 5 minutes after two failures in a row, and at 20 s again after a success', () => {
  const due = (s: Parameters<typeof isDue>[0], now: number) => isDue(s, now, 20_000, 300_000, 2)
  expect(due(undefined, 0)).toBe(true)
  const ok = { lastAt: 0, failures: 0, value: [] }
  expect(due(ok, 19_000)).toBe(false)
  expect(due(ok, 20_000)).toBe(true)
  const once = failed(ok, 0, 'timed out')
  expect(due(once, 20_000)).toBe(true)
  const twice = failed(once, 0, 'timed out')
  expect(due(twice, 20_000)).toBe(false)
  expect(due(twice, 300_000)).toBe(true)
  expect(squeueSnapshot(twice).error).toMatch(/2 failures in a row, retrying every 5 min/)
  expect(squeueSnapshot(once).error).toBe('timed out')
})

test('a failed poll keeps the last value known', () => {
  const job = { id: '1', name: 'x', state: 'R', elapsed: '', limit: '', where: '', partition: '' }
  expect(failed({ lastAt: 0, failures: 0, value: [job] }, 5, 'e').value).toEqual([job])
})

test('shared keys are file-safe, readable and distinct per path', () => {
  const a = sharedKey('git', '/data1/x/CARIBOU')
  expect(a).toMatch(/^git-x_CARIBOU-[0-9a-z]+$/)
  expect(sharedKey('git', '/data2/x/CARIBOU')).not.toBe(a)
})

test('a squeue timeout reads as one', () => {
  expect(squeueError(new Error('quarterdeck: $.process.run(squeue) aborted: still running after 20000ms'))).toBe('squeue timed out after 20s')
  expect(squeueError(new Error('boom'))).toBe('boom')
})

const setup = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
}

test('a failing squeue shows in the Slurm tab and is written for every session, not logged', async ($, on) => {
  const logs: string[] = []
  setup(on)
  on('ui.log', (_, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  const host = fakeHost(on, () => ({ exitCode: 1, stdout: '', stderr: 'slurm_load_jobs error: Socket timed out' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const pane = await $.ui.mount({ ...PANE('slurm', 'Slurm'), surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Socket timed out/ })).toBeTruthy()
  await pane.unmount()
  expect(host.calls.filter(c => c === 'squeue')).toHaveLength(1)
  const shared = JSON.parse(host.files.get('/h/.claude/mods-data/quarterdeck/shared/squeue.json') ?? '{}')
  expect(shared.failures).toBe(1)
  expect(host.dirs.has('/h/.claude/mods-data/quarterdeck/shared/squeue.lock')).toBe(false)
  expect(logs.filter(l => /squeue|slurm/i.test(l))).toEqual([])
})

test('a session reads a fresh shared result and calls no squeue of its own', async ($, on) => {
  setup(on)
  on('ui.log', () => ({ value: undefined }))
  const host = fakeHost(on, () => ({ exitCode: 0, stdout: '', stderr: '' }))
  const job = { id: '9', name: 'from-another-tab', state: 'R', elapsed: '1:00', limit: '2:00', where: 'n1', partition: 'gpu' }
  host.files.set('/h/.claude/mods-data/quarterdeck/shared/squeue.json', JSON.stringify({ lastAt: Date.now(), failures: 0, value: [job] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const pane = await $.ui.mount({ ...PANE('slurm', 'Slurm'), surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /from-another-tab/ })).toBeTruthy()
  await pane.unmount()
  expect(host.calls.filter(c => c === 'squeue')).toEqual([])
})

test('while another session holds the lock, this one waits for its result', async ($, on) => {
  setup(on)
  on('ui.log', () => ({ value: undefined }))
  const host = fakeHost(on, () => ({ exitCode: 0, stdout: '', stderr: '' }))
  host.dirs.add('/h/.claude/mods-data/quarterdeck/shared/squeue.lock')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  expect(host.calls.filter(c => c === 'squeue')).toEqual([])
  expect(host.dirs.has('/h/.claude/mods-data/quarterdeck/shared/squeue.lock')).toBe(true)
})
