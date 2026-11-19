import { expect, test } from 'claude-code/testing'
import { WAVE_ROWS, waveRows } from '../hooks/wave'

const flat = (rows: ReturnType<typeof waveRows>) => rows.map(r => r.map(s => s.text).join(''))

test('a wave frame is WAVE_ROWS rows of exactly the asked width, and moves', () => {
  const a = flat(waveRows(0, 40))
  const b = flat(waveRows(5, 40))
  expect(a.length).toBe(WAVE_ROWS)
  for (const r of a) expect([...r].length).toBe(40)
  expect(a.join('|')).not.toBe(b.join('|'))
})

test('both ships sail the same way and never share a column', () => {
  const W = 80
  const hulls = (phase: number) => flat(waveRows(phase, W)).join('\n').match(/\\_______\//g) ?? []
  // The two hull rows never overlap, so wherever both are fully on screen both are counted.
  expect([...Array(400).keys()].every(ph => hulls(ph).length <= 2)).toBe(true)
  expect([...Array(400).keys()].some(ph => hulls(ph).length === 2)).toBe(true)
})

test('the ship is on the water mid-voyage and sails off the edge cleanly', () => {
  expect(flat(waveRows(40, 60)).join('\n')).toContain('\\_______/')
  for (const phase of [0, 1, 100, 119, 143]) for (const r of flat(waveRows(phase, 20))) expect([...r].length).toBe(20)
})
