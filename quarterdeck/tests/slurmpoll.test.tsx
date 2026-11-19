import { expect, test } from 'claude-code/testing'

const PANE = (requestId: string, title: string) =>
  ({
    plugin: 'quarterdeck',
    component: 'Pane',
    requestId,
    props: { title, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

test('/toggle-slurm stops squeue polling, hides old jobs and errors, and resumes', async ($, on) => {
  const calls: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    calls.push(e.argv[0])
    const isSqueue = e.argv[0] === 'squeue'
    return {
      value: {
        exitCode: 0,
        stdout: isSqueue ? (e.argv.includes('%t') ? 'R\n' : '123|train|R|1:00|2:00|node1|gpu\n') : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
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

import { shouldPollSlurm, squeueError } from '../hooks/workpanel'

test('squeue polls every beat until two failures in a row, then every 5 minutes', () => {
  expect(shouldPollSlurm(0, 0, 20_000)).toBe(true)
  expect(shouldPollSlurm(1, 0, 20_000)).toBe(true)
  expect(shouldPollSlurm(2, 0, 20_000)).toBe(false)
  expect(shouldPollSlurm(2, 0, 299_000)).toBe(false)
  expect(shouldPollSlurm(2, 0, 300_000)).toBe(true)
  expect(shouldPollSlurm(5, 1_000_000, 1_100_000)).toBe(false)
})

test('a squeue timeout reads as one', () => {
  expect(squeueError(new Error('quarterdeck: $.process.run(squeue) aborted: still running after 20000ms'))).toBe('squeue timed out after 20s')
  expect(squeueError(new Error('boom'))).toBe('Error: boom')
})

test('a failing squeue shows in the Slurm tab, is not logged, and the HUD runs no squeue of its own', async ($, on) => {
  let squeueCalls = 0
  const logs: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', (_, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'squeue') {
      squeueCalls++
      return { value: { exitCode: 1, stdout: '', stderr: 'slurm_load_jobs error: Socket timed out', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const pane = await $.ui.mount({ ...PANE('slurm', 'Slurm'), surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Socket timed out/ })).toBeTruthy()
  await pane.unmount()
  expect(squeueCalls).toBe(1)
  expect(logs.filter(l => /squeue|slurm/i.test(l))).toEqual([])
})
