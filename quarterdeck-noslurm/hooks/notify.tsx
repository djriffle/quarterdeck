import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GitData, GitPR, Notice } from '../types'

const WATCH_EVERY_MS = 5_000

// Read here, written elsewhere: the Git tab's data (gitpanel.tsx)
// and the wave's phase (wave.tsx), each with the key and shape of the file that owns it.
const gitData = atom({ plugin: 'quarterdeck-noslurm', key: 'git-data' } as const, { at: 0, prs: [], issues: [], branches: [], stashes: [], commits: [], commitsAll: [], errors: {} } as GitData, {
  shape: 'git-1',
})
const wavePhase = atom({ plugin: 'quarterdeck-noslurm', key: 'wave-phase' } as const, 0)
// The latest notice: the toast fires at once, the wave's lead ship carries it for one lap.
const latest = atom({ plugin: 'quarterdeck-noslurm', key: 'notify-latest' } as const, null as Notice | null, { shape: 'notify-1' })

export type Event = { text: string; tag: string; kind: Notice['kind'] }

export const prEvents = (prev: GitPR[], cur: GitPR[]): Event[] => {
  const now = new Map(cur.map(p => [p.number, p]))
  const out: Event[] = []
  for (const p of prev) {
    const n = now.get(p.number)
    if (!n) {
      out.push({ text: `PR #${p.number} is no longer open (merged or closed): ${p.title}`, tag: `#${p.number} ⚑`, kind: 'info' })
      continue
    }
    if (n.ci !== p.ci && n.ci === 'pass') out.push({ text: `PR #${n.number} checks passed`, tag: `#${n.number} ✓`, kind: 'pass' })
    if (n.ci !== p.ci && n.ci === 'fail') out.push({ text: `PR #${n.number} checks failed`, tag: `#${n.number} ✗`, kind: 'fail' })
    if (n.review !== p.review && n.review === 'APPROVED') out.push({ text: `PR #${n.number} was approved`, tag: `#${n.number} ✓`, kind: 'pass' })
    if (n.review !== p.review && n.review === 'CHANGES_REQUESTED')
      out.push({ text: `PR #${n.number}: changes requested`, tag: `#${n.number} ✗`, kind: 'fail' })
  }
  return out
}

type Engine = Parameters<typeof update>[0]
let prevPRs: GitPR[] | undefined

async function check($: Engine) {
  const events: Event[] = []
  const g = await read($, gitData)
  if (g.at > 0 && !g.errors.prs) {
    if (prevPRs) events.push(...prEvents(prevPRs, g.prs))
    prevPRs = g.prs
  }
  for (const ev of events) {
    await $.ui.toast(ev.text)
    const born = await read($, wavePhase)
    await update($, latest, () => ({ id: Date.now(), text: ev.text, tag: ev.tag, kind: ev.kind, born }))
  }
}

export const registerNotify = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    $.clock.every(WATCH_EVERY_MS, () => {
      check($).catch(err => $.ui.log(`quarterdeck notify check failed: ${String(err)}`))
    })
    return started
  })
}
