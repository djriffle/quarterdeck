import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GitData, GitPR, Job, Notice, Snapshot } from '../types'

const WATCH_EVERY_MS = 5_000

// Read here, written elsewhere: the Slurm snapshot (workpanel.tsx), the Git tab's data (gitpanel.tsx)
// and the wave's phase (wave.tsx), each with the key and shape of the file that owns it.
const jobs = atom({ plugin: 'reality-plus', key: 'wp-jobs' } as const, { items: [], at: 0 } as Snapshot<Job>, { shape: 'jobs-1' })
const gitData = atom({ plugin: 'reality-plus', key: 'git-data' } as const, { at: 0, prs: [], issues: [], branches: [], stashes: [], commits: [], commitsAll: [], errors: {} } as GitData, {
  shape: 'git-1',
})
const wavePhase = atom({ plugin: 'reality-plus', key: 'wave-phase' } as const, 0)
// The latest notice: the toast fires at once, the wave's lead ship carries it for one lap.
const latest = atom({ plugin: 'reality-plus', key: 'notify-latest' } as const, null as Notice | null, { shape: 'notify-1' })

export type Event = { text: string; tag: string; kind: Notice['kind'] }

// A job that left the queue is finished; the queue does not say how it ended.
export const jobEvents = (prev: Job[], cur: Job[]): Event[] => {
  const still = new Set(cur.map(j => j.id))
  return prev
    .filter(j => !still.has(j.id))
    .map(j => ({ text: `Slurm job ${j.name} (${j.id}) left the queue`, tag: `${j.id.slice(-5)} ●`, kind: 'info' as const }))
}

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
let prevJobs: Job[] | undefined
let prevPRs: GitPR[] | undefined

async function check($: Engine) {
  const events: Event[] = []
  const q = await read($, jobs)
  // A failed or not-yet-loaded read says nothing about what finished: keep the last good snapshot.
  if (q.at > 0 && !q.error) {
    if (prevJobs) events.push(...jobEvents(prevJobs, q.items))
    prevJobs = q.items
  }
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
      check($).catch(err => $.ui.log(`reality-plus notify check failed: ${String(err)}`))
    })
    return started
  })
}
