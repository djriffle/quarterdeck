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
