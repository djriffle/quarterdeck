import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// /holding: a yellow bar above the prompt marking this session as an open window that needs no
// attention right now. Purely a marker for the person; it changes nothing else and stays until toggled off.
const YELLOW = 'rgb(240,200,70)'
const INK = 'rgb(30,30,30)'

const holdingOn = atom({ plugin: 'quarterdeck', key: 'holding-on' } as const, false)

type Engine = Parameters<typeof update>[0]

export const holdingText = (width: number) => {
  const label = ' HOLDING '
  const w = Math.max(label.length, width)
  const left = Math.floor((w - label.length) / 2)
  return ' '.repeat(left) + label + ' '.repeat(w - left - label.length)
}

// The bar, spliced into the HUD band by register.tsx; null while /holding is off.
export async function holdingBar($: Engine, e: Parameters<Engine['ui']['resolve']>[0], width: number) {
  if (!(await read($, holdingOn))) return null
  const { Text } = $.ui.resolve(e)
  return (
    <Text backgroundColor={YELLOW} color={INK} bold wrap="truncate-end">
      {holdingText(width)}
    </Text>
  )
}

export const registerHolding = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'holding', description: 'Toggle a yellow HOLDING bar: an open session that needs no attention' })
    return started
  })

  on('command.run', { command: 'holding' }, async $ => {
    const now = await update($, holdingOn, held => !held)
    return { text: now ? 'Holding. /holding again to clear it.' : 'Holding cleared.' }
  })
}
