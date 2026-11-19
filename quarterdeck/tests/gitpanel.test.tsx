import { expect, test } from 'claude-code/testing'
import { withSharedFs } from './fakehost'

const GIT = {
  plugin: 'quarterdeck',
  component: 'Pane',
  requestId: 'git',
  props: { title: 'Git', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const PRS = JSON.stringify([
  { number: 24, title: 'Fix memory manager', headRefName: 'memory-manager-fixes', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
    statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], closingIssuesReferences: [{ number: 9 }], author: { login: 'octocat' }, url: 'https://x/pull/24' },
])
const ISSUES = JSON.stringify([{ number: 9, title: 'Memory manager window', labels: [{ name: 'bug' }], assignees: [], url: 'https://x/issues/9' }])

test('the Git tab draws PRs, issues, branches and stashes', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  withSharedFs(on, (_, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('gh pr list')) return ok(PRS)
    if (a.startsWith('gh issue list')) return ok(ISSUES)
    if (a.includes('origin/HEAD')) return ok('origin/main\n')
    if (a.includes('rev-parse --abbrev-ref HEAD')) return ok('memory-manager-fixes\n')
    if (a.includes('status --porcelain')) return ok(' M a.py\n')
    if (a.startsWith('git for-each-ref'))
      return ok('memory-manager-fixes|origin/memory-manager-fixes||2 hours ago|*|2\t0\nold-thing|origin/old-thing|[gone]|3 weeks ago| |0\t4\nmain|origin/main||1 day ago| |0\t0\n')
    if (a.startsWith('git branch --merged')) return ok('old-thing\nmain\n')
    if (a.startsWith('git stash list')) return ok('stash@{0}|3 days ago|WIP on main: abc wip\n')
    if (a.startsWith('git log')) return ok('abc1234|2 hours ago|Dylan|Fix window of 0\n')
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...GIT, surface: 'terminal' })
  await ui.press({ key: 'prs-view' })
  await ui.press({ key: 'issues-view' })
  await ui.press({ key: 'branches-view' })
  await ui.press({ key: 'stashes-view' })
  expect(await ui.find({ type: 'Text', text: /Fix memory manager/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /closes #9/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PR#24/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /merged · can delete/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /upstream gone/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /WIP on main/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Fix window of 0/ })).toBeTruthy()
  await ui.unmount()
})

test('a failing gh call shows its error in the PR section', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  withSharedFs(on, (_, e) => ({
    value: { exitCode: e.argv[0] === 'gh' ? 1 : 0, stdout: '', stderr: e.argv[0] === 'gh' ? 'gh: not logged in' : '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...GIT, surface: 'terminal' })
  await ui.press({ key: 'prs-view' })
  await ui.press({ key: 'issues-view' })
  expect(await ui.find({ type: 'Text', text: /not logged in/ })).toBeTruthy()
  await ui.unmount()
})

test('issues and PRs default to the mentioned ones', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'look at issue 5 and PR 7' }] }))
  on('agent.list', () => ({ value: [] }))
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  withSharedFs(on, (_, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('gh api') && a.endsWith('/5')) return ok(JSON.stringify({ number: 5, title: 'Mentioned issue five', state: 'open', html_url: 'https://x/5' }))
    if (a.startsWith('gh api') && a.endsWith('/7')) return ok(JSON.stringify({ number: 7, title: 'Mentioned pr seven', state: 'closed', html_url: 'https://x/7', pull_request: {} }))
    if (a.startsWith('gh pr list')) return ok(PRS)
    if (a.startsWith('gh issue list')) return ok(ISSUES)
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...GIT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Mentioned issue five/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Mentioned pr seven/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Fix memory manager/ })).toBeFalsy()
  await ui.press({ key: 'prs-view' })
  expect(await ui.find({ type: 'Text', text: /Fix memory manager/ })).toBeTruthy()
  await ui.unmount()
})
