import { expect, test } from 'claude-code/testing'
import { jobEvents, prEvents } from '../hooks/notify'
import { waveRows } from '../hooks/wave'
import type { GitPR, Job } from '../types'

const job = (id: string): Job => ({ id, name: `job-${id}`, state: 'R', elapsed: '1:00', limit: '2:00', where: 'n1', partition: 'p' })
const pr = (over: Partial<GitPR>): GitPR => ({
  number: 24, title: 'Fix', branch: 'b', isDraft: false, isConflicting: false, ci: 'pending', closes: [], author: 'a', url: 'u', ...over,
})
const text = (rows: ReturnType<typeof waveRows>) => rows.map(r => r.map(s => s.text).join('')).join('\n')

test('a job that leaves the queue is an event; one that stays is not', () => {
  const ev = jobEvents([job('7332900'), job('7332823')], [job('7332823')])
  expect(ev.length).toBe(1)
  expect(ev[0].tag).toBe('32900 ●')
  expect(jobEvents([job('1')], [job('1')]).length).toBe(0)
})

test('PR checks, reviews and closing are events, and only on a change', () => {
  expect(prEvents([pr({})], [pr({ ci: 'pass' })]).map(e => e.tag)).toEqual(['#24 ✓'])
  expect(prEvents([pr({})], [pr({ ci: 'fail' })]).map(e => e.kind)).toEqual(['fail'])
  expect(prEvents([pr({})], [pr({ review: 'APPROVED' })]).map(e => e.kind)).toEqual(['pass'])
  expect(prEvents([pr({})], []).length).toBe(1)
  expect(prEvents([pr({ ci: 'pass' })], [pr({ ci: 'pass' })]).length).toBe(0)
})

test('the lead ship spells the tag for one lap, then the hull is plain again', () => {
  const notice = { id: 1, text: 't', tag: '#24 ✓', kind: 'pass' as const, born: 100 }
  const W = 60
  const lap = W + 18
  const seen = (ph: number) => text(waveRows(ph, W, notice)).includes('#24 ✓')
  expect([...Array(lap * 2).keys()].some(i => seen(100 + i))).toBe(true)
  expect(seen(100 + lap * 2 + 10)).toBe(false)
})
