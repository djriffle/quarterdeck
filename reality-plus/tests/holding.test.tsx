import { expect, test } from 'claude-code/testing'
import { holdingText } from '../hooks/holding'

test('the holding bar fills the width with HOLDING centred', () => {
  const t = holdingText(30)
  expect(t.length).toBe(30)
  expect(t.trim()).toBe('HOLDING')
  expect(holdingText(3).trim()).toBe('HOLDING')
})
