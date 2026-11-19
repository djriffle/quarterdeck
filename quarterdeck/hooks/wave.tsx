import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Notice } from '../types'

// Three rows of sky above three rows of water: the ship's masts fill the sky rows.
export const WAVE_ROWS = 6
const WATER_ROWS = 3
const FRAME_MS = 200
const LEVELS = ' ▁▂▃▄▅▆▇█'
const WATER = 'rgb(80,135,200)' // one blue for the whole wave
const HULL = 'rgb(205,190,165)'
const SAIL = 'rgb(235,235,235)'
const FLAG = 'rgb(225,110,100)'
const GREEN = 'rgb(161,242,137)'
type Art = [string, string][][]
// Every ship is a 9-cell sloop, bow to the right, differing only in its pennant. They all sail right at
// one speed, spaced evenly round one shared lap, so they never overlap. The hull row settles into the
// crest; spaces are transparent.
const SHIP_WIDTH = 9
const SHIP_SPEED = 0.5 // columns per frame
const AMBER = 'rgb(240,200,90)'
const NOTICE_COLOR: Record<Notice['kind'], string> = { pass: GREEN, fail: FLAG, info: AMBER }
// A sloop; carrying a notice, its pennant takes the notice's colour and its hull spells the tag.
const sloop = (flag: string, notice?: Notice): Art => {
  const inner = 7
  const tag = notice ? [...notice.tag].slice(0, inner) : []
  const left = Math.floor((inner - tag.length) / 2)
  const hull: [string, string][] = notice
    ? [
        ['\\' + '_'.repeat(left), HULL],
        [tag.join(''), NOTICE_COLOR[notice.kind]],
        ['_'.repeat(inner - left - tag.length) + '/', HULL],
      ]
    : [['\\_______/', HULL]]
  return [
    [['   |', SAIL], ['>', notice ? NOTICE_COLOR[notice.kind] : flag]],
    [['   |\\', SAIL]],
    [['   |_\\', SAIL]],
    hull,
  ]
}
const SHIPS: ((notice?: Notice) => Art)[] = [n => sloop(FLAG, n), () => sloop(GREEN)]

export type Seg = { text: string; color: string }

const waveOn = atom({ plugin: 'quarterdeck', key: 'wave-on' } as const, false)
const wavePhase = atom({ plugin: 'quarterdeck', key: 'wave-phase' } as const, 0)

// One frame: WAVE_ROWS rows of coloured runs, `width` cells each. Two sines make the surface; its top
// cell is a partial block, the cells under it a light shade. A small ship sails across, riding the crest.
export const waveRows = (phase: number, width: number, notice?: Notice | null): Seg[][] => {
  const steps = WATER_ROWS * 8
  const cells: { ch: string; color: string }[][] = Array.from({ length: WAVE_ROWS }, () =>
    Array.from({ length: width }, () => ({ ch: ' ', color: WATER })),
  )
  const crestRow: number[] = []
  for (let x = 0; x < width; x++) {
    const y = 0.5 + 0.3 * Math.sin(x * 0.11 + phase * 0.35) + 0.2 * Math.sin(x * 0.047 - phase * 0.21)
    const level = Math.max(1, Math.round(y * steps))
    for (let r = WAVE_ROWS - WATER_ROWS; r < WAVE_ROWS; r++) {
      const fromBottom = WAVE_ROWS - 1 - r
      const inRow = level - fromBottom * 8
      if (inRow >= 8) cells[r][x] = { ch: '░', color: WATER }
      else if (inRow > 0) {
        cells[r][x] = { ch: LEVELS[inRow], color: WATER }
        if (crestRow[x] === undefined) crestRow[x] = r
      }
    }
    if (crestRow[x] === undefined) crestRow[x] = WAVE_ROWS - WATER_ROWS
  }
  if (width > 0) {
    const lap = width + 2 * SHIP_WIDTH
    // The lead ship carries a notice for one full lap (2 frames a column), whenever it comes on screen.
    const carrying = notice && phase - notice.born < lap / SHIP_SPEED ? notice : undefined
    SHIPS.forEach((makeArt, i) => {
      const art = makeArt(carrying)
      const p = (Math.floor(phase * SHIP_SPEED) + Math.floor((lap * i) / SHIPS.length)) % lap
      const x0 = p - SHIP_WIDTH
      const mid = Math.min(width - 1, Math.max(0, x0 + Math.floor(SHIP_WIDTH / 2)))
      const rows = art
      const hullRow = crestRow[mid]
      rows.forEach((segs, r) => {
        const row = hullRow - (rows.length - 1 - r)
        let col = x0
        for (const [text, color] of segs) {
          for (const ch of text) {
            if (row >= 0 && col >= 0 && col < width && ch !== ' ') cells[row][col] = { ch, color }
            col++
          }
        }
      })
    })
  }
  return cells.map(row => {
    const runs: Seg[] = []
    for (const c of row) {
      const last = runs[runs.length - 1]
      if (last && last.color === c.color) last.text += c.ch
      else runs.push({ text: c.ch, color: c.color })
    }
    return runs
  })
}

type Engine = Parameters<typeof update>[0]
let ticker: { cancel: () => void } | undefined

function startTicker($: Engine) {
  ticker?.cancel()
  ticker = $.clock.every(FRAME_MS, () => {
    update($, wavePhase, n => n + 1).catch(err => $.ui.log(`quarterdeck wave tick failed: ${String(err)}`))
  })
}

export const registerWave = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'wave', description: 'Toggle a faint animated ASCII wave above the prompt' })
    // A reload keeps the stored switch but not the timer: pick the animation back up.
    if (await read($, waveOn)) startTicker($)
    return started
  })

  on('command.run', { command: 'wave' }, async $ => {
    if (await read($, waveOn)) {
      ticker?.cancel()
      ticker = undefined
      await update($, waveOn, () => false)
      return { text: 'Wave off.' }
    }
    await update($, waveOn, () => true)
    startTicker($)
    return { text: 'Wave on. /wave again to stop.' }
  })
}
