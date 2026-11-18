import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// /label <text>: an orange bar above the prompt showing the text, like /holding's yellow bar. Purely a
// marker for the person; it stays until /label is run again with no text.
const ORANGE = 'rgb(215,119,87)' // Reality+ accent #D77757
const INK = 'rgb(30,30,30)'

const labelText = atom({ plugin: 'reality-plus', key: 'label-text' } as const, '')

type Engine = Parameters<typeof update>[0]

export const labelLine = (text: string, width: number) => {
  const label = ` ${text.replace(/\s+/g, ' ').trim()} `
  const w = Math.max(label.length, width)
  const left = Math.floor((w - label.length) / 2)
  return ' '.repeat(left) + label + ' '.repeat(w - left - label.length)
}

// The bar, spliced into the HUD band by register.tsx; null while no label is set.
export async function labelBar($: Engine, e: Parameters<Engine['ui']['resolve']>[0], width: number) {
  const text = await read($, labelText)
  if (!text) return null
  const { Text } = $.ui.resolve(e)
  return (
    <Text backgroundColor={ORANGE} color={INK} bold wrap="truncate-end">
      {labelLine(text, width)}
    </Text>
  )
}

export const registerLabel = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'label', description: 'Show an orange bar with your text above the prompt; /label alone clears it', argumentHint: '<text>' })
    return started
  })

  on('command.run', { command: 'label' }, async ($, e) => {
    const text = e.args.replace(/\s+/g, ' ').trim()
    await update($, labelText, () => text)
    return { text: text ? `Label set: ${text}. /label alone clears it.` : 'Label cleared.' }
  })
}
