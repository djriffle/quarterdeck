import { expect, test } from 'claude-code/testing'
import { prEvents } from '../hooks/notify'
import { waveRows } from '../hooks/wave'
import type { GitPR } from '../types'

const pr = (over: Partial<GitPR>): GitPR => ({
  number: 24, title: 'Fix', branch: 'b', isDraft: false, isConflicting: false, ci: 'pending', closes: [], author: 'a', url: 'u', ...over,
})
const text = (rows: ReturnType<typeof waveRows>) => rows.map(r => r.map(s => s.text).join('')).join('\n')

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
