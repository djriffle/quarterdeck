import { expect, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'
import { CHECK, CROSS, SPIN, elapsed, endTask, foldAgents, glyph, parseNotifications, prune, scanStart, startedTasks, wholeRows, reconcile, tombstone, expire } from '../hooks/waiting'
import type { WaitItem } from '../types'

const agent = (id: string, status: AgentInfo['status']): AgentInfo => ({ id, description: `task ${id}`, type: 'Explore', status })

test('live agents are added; one that finishes gets its end phase; ones already done are ignored', () => {
  let items = foldAgents({}, [agent('a', 'running'), agent('old', 'completed')], 0, 1000)
  expect(Object.keys(items)).toEqual(['agent:a'])
  items = foldAgents(items, [agent('a', 'completed')], 7, 5000)
  expect(items['agent:a'].endedPhase).toBe(7)
  expect(items['agent:a'].ok).toBe(true)
  expect(foldAgents({}, [agent('b', 'running')], 0, 0)['agent:b'].ok).toBe(undefined)
  expect(foldAgents(foldAgents({}, [agent('c', 'running')], 0, 0), [agent('c', 'failed')], 3, 0)['agent:c'].ok).toBe(false)
})

test('a live row spins; an ended row draws the check stroke by stroke and settles on ✔; failures cross', () => {
  const live: WaitItem = { kind: 'shell', label: 'x', startedAt: 0 }
  expect(SPIN).toContain(glyph(live, 3))
  const done = { ...live, endedPhase: 10, ok: true }
  expect(glyph(done, 10)).toBe(CHECK[0])
  expect(glyph(done, 13)).toBe(CHECK[3])
  expect(glyph(done, 100)).toBe('✔')
  expect(glyph({ ...live, endedPhase: 10, ok: false }, 100)).toBe(CROSS[CROSS.length - 1])
})

test('ended rows are pruned after their hold; live rows stay', () => {
  const items: Record<string, WaitItem> = {
    'task:a': { kind: 'shell', label: 'a', startedAt: 0 },
    'task:b': { kind: 'shell', label: 'b', startedAt: 0, endedPhase: 0, ok: true },
  }
  expect(Object.keys(prune(items, 5))).toEqual(['task:a', 'task:b'])
  expect(Object.keys(prune(items, 1000))).toEqual(['task:a'])
})

test('a final task notification gives id and status; a Monitor event (no status) is not an end', () => {
  const n = parseNotifications('<task-notification>\n<task-id>b7x2k</task-id>\n<status>failed</status>\n</task-notification>')
  expect(n).toEqual([{ id: 'b7x2k', status: 'failed' }])
  expect(parseNotifications('<task-notification><task-id>m1</task-id><event>line</event></task-notification>')).toEqual([])
  expect(parseNotifications('plain text')).toEqual([])
  const items = { 'task:b7x2k': { kind: 'shell' as const, label: 'sleep', startedAt: 0 } }
  const ended = endTask(items, 'b7x2k', 'failed', 4, 9)['task:b7x2k']
  expect(ended.endedPhase).toBe(4)
  expect(ended.ok).toBe(false)
  expect(endTask(items, 'b7x2k', 'stopped', 4, 9)['task:b7x2k'].ok).toBe(true)
  expect(endTask(items, 'nope', 'completed', 4, 9)).toBe(items)
})

test('Stop reconciles: missing tracked tasks end, unseen shells and monitors are added, agents untouched', () => {
  const items: Record<string, WaitItem> = {
    'task:gone': { kind: 'monitor', label: 'watch log', startedAt: 0 },
    'task:live': { kind: 'shell', label: 'pytest', startedAt: 0 },
    'agent:a': { kind: 'agent', label: 'x', startedAt: 0 },
  }
  const out = reconcile(
    items,
    [
      { id: 'live', type: 'shell', status: 'running', description: 'pytest' },
      { id: 'mon2', type: 'monitor', status: 'running', description: 'tail slurm log' },
      { id: 'wf', type: 'workflow', status: 'running', description: 'ignored' },
    ],
    new Set(),
    9,
    100,
  )
  expect(out['task:gone'].endedPhase).toBe(9)
  expect(out['task:live'].endedPhase).toBe(undefined)
  expect(out['task:mon2'].kind).toBe('monitor')
  expect(out['task:wf']).toBe(undefined)
  expect(out['agent:a'].endedPhase).toBe(undefined)
})

test('elapsed reads as s, m s, h m', () => {
  expect(elapsed(4_000)).toBe('4s')
  expect(elapsed(133_000)).toBe('2m 13s')
  expect(elapsed(3_720_000)).toBe('1h 2m')
})

// A real Monitor end, as delivered (trimmed): status completed, "stream ended".
const MONITOR_END = `<task-notification>
<task-id>bz7c6ez3w</task-id>
<tool-use-id>toolu_012pwuV9MdVRPGx112nuWQeq</tool-use-id>
<output-file>/tmp/tasks/bz7c6ez3w.output</output-file>
<status>completed</status>
<summary>Monitor "cfm_rename pytest job 7050362 finish" stream ended</summary>
<event>JOB ENDED
1 failed, 578 passed, 2 skipped, 1394 warnings in 428.16s (0:07:08)
PYTEST_EXIT=1</event>
</task-notification>`
const MONITOR_EVENT = `<task-notification>
<task-id>bn5fz5aki</task-id>
<summary>Monitor event: "smoke job state changes"</summary>
<event>11251856|kusama-generate|RUNNING</event>
</task-notification>`

test('a Monitor end ends its row; a Monitor event does not; batched notifications all end', () => {
  expect(parseNotifications(MONITOR_END)).toEqual([{ id: 'bz7c6ez3w', status: 'completed' }])
  expect(parseNotifications(MONITOR_EVENT)).toEqual([])
  const batch = `${MONITOR_EVENT}\n${MONITOR_END}\n<task-notification><task-id>sh1</task-id><status>killed</status></task-notification>`
  expect(parseNotifications(batch)).toEqual([
    { id: 'bz7c6ez3w', status: 'completed' },
    { id: 'sh1', status: 'killed' },
  ])
})

test('a task listed at Stop with a final status ends with that status and is never added as live', () => {
  const items: Record<string, WaitItem> = { 'task:s': { kind: 'shell', label: 'sleep', startedAt: 0 } }
  const inFlight = [
    { id: 's', type: 'shell', status: 'failed', description: 'sleep' },
    { id: 'done', type: 'shell', status: 'completed', description: 'already finished' },
  ]
  const out = reconcile(items, inFlight, new Set(), 3, 50)
  expect(out['task:s'].endedPhase).toBe(3)
  expect(out['task:s'].ok).toBe(false)
  expect(out['task:done']).toBe(undefined)
})

test('a pruned ended row is not brought back by a later Stop listing it as running', () => {
  let items: Record<string, WaitItem> = { 'task:m': { kind: 'monitor', label: 'watch', startedAt: 0 } }
  items = endTask(items, 'm', 'completed', 1, 10)
  const ended = tombstone([], items)
  expect(ended).toEqual(['task:m'])
  items = prune(items, 10_000)
  expect(items['task:m']).toBe(undefined)
  const out = reconcile(items, [{ id: 'm', type: 'monitor', status: 'running', description: 'watch' }], new Set(ended), 10_001, 20)
  expect(out['task:m']).toBe(undefined)
  expect(tombstone(ended, out)).toBe(ended)
})

test('a monitor past its timeout ends as expired; a persistent one or one still in time keeps spinning', () => {
  const items = {
    'task:old': { kind: 'monitor' as const, label: 'watch job', startedAt: 0, deadline: 300_000 },
    'task:new': { kind: 'monitor' as const, label: 'watch job', startedAt: 290_000, deadline: 590_000 },
    'task:forever': { kind: 'monitor' as const, label: 'tail log', startedAt: 0 },
  }
  const out = expire(items, 7, 300_001)
  expect(out['task:old']?.endedPhase).toBe(7)
  expect(out['task:old']?.status).toBe('expired')
  expect(out['task:old']?.ok).toBe(true)
  expect(out['task:new']?.endedPhase).toBeUndefined()
  expect(out['task:forever']?.endedPhase).toBeUndefined()
  expect(expire(out, 9, 300_002)['task:old']?.endedPhase).toBe(7)
})

test('a notification naming several tasks ends every one of them (orphan summary)', () => {
  const orphan = '<task-notification>\n<task-id>bfh57ppwq</task-id>\n<task-id>be9e00vjs</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn\'t finish</summary>\n</task-notification>'
  expect(parseNotifications(orphan)).toEqual([
    { id: 'bfh57ppwq', status: 'stopped' },
    { id: 'be9e00vjs', status: 'stopped' },
  ])
})

test('a shell that ends with its subagent ends when that agent does', () => {
  let items: Record<string, WaitItem> = foldAgents({}, [agent('sub', 'running')], 0, 0)
  items = { ...items, 'task:sh9': { kind: 'shell', label: 'sleep', startedAt: 0, owner: 'sub' }, 'task:sh8': { kind: 'shell', label: 'other', startedAt: 0 } }
  items = foldAgents(items, [agent('sub', 'running')], 2, 0)
  expect(items['task:sh9'].endedPhase).toBe(undefined)
  items = foldAgents(items, [agent('sub', 'completed')], 5, 0)
  expect(items['task:sh9'].endedPhase).toBe(5)
  expect(items['task:sh9'].status).toBe('stopped')
  expect(items['task:sh8'].endedPhase).toBe(undefined)
})

// A queued notification as the transcript JSONL stores it: newlines escaped inside the JSON string.
const JSONL_LINE = String.raw`{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>bpah1xwes</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>completed</status>\n<summary>Background command \"pytest\" completed (exit code 0)</summary>\n</task-notification>"}`

test('a notification read raw from the transcript JSONL ends its task', () => {
  expect(parseNotifications(JSONL_LINE)).toEqual([{ id: 'bpah1xwes', status: 'completed' }])
})

test('transcript scans start near the end the first time, then just before where the last one stopped', () => {
  expect(scanStart(undefined, 1000)).toBe(0)
  expect(scanStart(undefined, 10 * 1024 * 1024)).toBe(6 * 1024 * 1024)
  expect(scanStart(200 * 1024, 300 * 1024)).toBe(136 * 1024)
  expect(scanStart(10, 300 * 1024)).toBe(0)
  expect(scanStart(500 * 1024, 100 * 1024)).toBe(36 * 1024) // file shrank (rewritten): re-read its tail
})

// Transcript rows (trimmed) as a session writes them.
const row = (o: object) => JSON.stringify(o)
const useRow = (id: string, name: string, input: object, ts: string) =>
  row({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } })
const resultRow = (id: string, result: object, ts: string) =>
  row({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: result })

test('a reloaded /waiting rebuilds the running shells and Monitors from the transcript', () => {
  const t0 = '2026-11-19T17:00:00.000Z'
  const now = Date.parse(t0) + 60_000
  const lines = [
    useRow('u1', 'Monitor', { command: 'tail -f log', description: 'watch job 7050362' }, t0),
    resultRow('u1', { taskId: 'mon1', timeoutMs: 1_800_000, persistent: false }, t0),
    useRow('u2', 'Bash', { command: 'pytest', description: 'run tests', run_in_background: true }, t0),
    resultRow('u2', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh1' }, t0),
    useRow('u3', 'Bash', { command: 'sleep 5', run_in_background: true }, t0),
    resultRow('u3', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh2' }, t0),
    row({ type: 'queue-operation', content: '<task-notification>\n<task-id>sh2</task-id>\n<status>completed</status>\n</task-notification>' }),
    useRow('u4', 'Monitor', { command: 'watch', description: 'old watch' }, '2026-11-19T15:00:00.000Z'),
    resultRow('u4', { taskId: 'mon2', timeoutMs: 1_800_000 }, '2026-11-19T15:00:00.000Z'),
    useRow('u5', 'Bash', { command: 'make', run_in_background: true }, t0),
    resultRow('u5', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh3' }, t0),
    useRow('u6', 'TaskStop', { task_id: 'sh3' }, t0),
  ]
  const found = startedTasks(lines, now)
  expect(found.map(f => f.id)).toEqual(['mon1', 'sh1'])
  expect(found[0].item).toEqual({ kind: 'monitor', label: 'watch job 7050362', detail: 'tail -f log', startedAt: Date.parse(t0), deadline: Date.parse(t0) + 1_800_000 })
  expect(found[1].item.kind).toBe('shell')
  expect(found[1].item.label).toBe('run tests')
})

test('only whole JSONL rows are read', () => {
  expect(wholeRows('{"a":1}\n{"b":2}\n{"c"', 0)).toEqual(['{"a":1}', '{"b":2}'])
  expect(wholeRows('t":9}\n{"b":2}\n', 100)).toEqual(['{"b":2}'])
})
