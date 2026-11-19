import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

// /toggle-slurm: switch squeue polling off for this session (e.g. on a machine with no Slurm, or
// when the queue is not this session's concern) and back on. While off, the HUD, the Slurm tab and
// the Work tab's Slurm section stop calling squeue and say polling is off.
export const slurmOn = atom({ plugin: 'reality-plus', key: 'slurm-on' } as const, true)

// Refreshers that run again as soon as polling comes back on (registered by the files that poll).
const resumers: (() => void)[] = []
export const onSlurmResume = (f: () => void) => {
  resumers.push(f)
}

export const registerSlurmPoll = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'toggle-slurm', description: 'Turn Slurm (squeue) polling off or back on' })
    return started
  })

  on('command.run', { command: 'toggle-slurm' }, async $ => {
    const now = await update($, slurmOn, v => !v)
    if (now) for (const f of resumers) f()
    return { text: now ? 'Slurm polling on.' : 'Slurm polling off. /toggle-slurm to turn it back on.' }
  })
}
