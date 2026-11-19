import { expect, mock, test } from 'claude-code/testing'

test('/wind-down submits the wind-down brief as a prompt', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-xyz' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'wind-down', args: 'leave the e38c90 jobs alone' })
  expect(r.text).toContain('Wind-down sent')
  await clock.settle()
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('WIND DOWN')
  expect(sent[0]).toContain('claude --resume sess-xyz')
  expect(sent[0]).toContain('/home/me/.claude/mods-data/quarterdeck/notes/sess-xyz.md')
  expect(sent[0]).toContain('Also, from me: leave the e38c90 jobs alone')
})
