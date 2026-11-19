import { expect, test } from 'claude-code/testing'
import { holdingText } from '../hooks/holding'
import { labelLine } from '../hooks/label'

test('the holding bar fills the width with HOLDING centred', () => {
  const t = holdingText(30)
  expect(t.length).toBe(30)
  expect(t.trim()).toBe('HOLDING')
  expect(holdingText(3).trim()).toBe('HOLDING')
})

test('the label bar fills the width with the text centred and collapses whitespace', () => {
  const t = labelLine('  review   PR 431 ', 30)
  expect(t.length).toBe(30)
  expect(t.trim()).toBe('review PR 431')
  expect(labelLine('a long label here', 4).trim()).toBe('a long label here')
})

test('a /label is saved for the session and comes back when the session resumes', async ($, on) => {
  const files = new Map<string, string>()
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'n/a', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('env.get', () => ({ value: '/h' }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  files.set('/h/.claude/mods-data/quarterdeck-noslurm/labels/s1.txt', 'review PR 431')
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  const band = await $.ui.mount({ plugin: 'quarterdeck-noslurm', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 80 } } as never)
  expect(await band.find({ type: 'Text', text: /review PR 431/ })).toBeTruthy()
  await band.unmount()

  await $.command.run({ command: 'label', args: 'deploy watch' } as never)
  expect(files.get('/h/.claude/mods-data/quarterdeck-noslurm/labels/s1.txt')).toBe('deploy watch')
  await $.command.run({ command: 'label', args: '' } as never)
  expect(files.get('/h/.claude/mods-data/quarterdeck-noslurm/labels/s1.txt')).toBe('')
})
