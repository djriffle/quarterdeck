import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// /toggle-git: switch git and gh polling off for this session (e.g. in a folder that is not a
// repository, where every beat would only paint errors) and back on. While off, the HUD, the Git
// tab and the Work tab's issues and worktrees stop calling git and gh and say polling is off.
export const gitOn = atom({ plugin: 'reality-plus', key: 'git-on' } as const, true)

type Engine = Parameters<typeof update>[0]

// Refreshers that run again as soon as polling comes back on (registered by the files that poll).
const resumers: (() => void)[] = []
export const onGitResume = (f: () => void) => {
  resumers.push(f)
}

export const registerGitPoll = (on: Parameters<Register>[0]) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'toggle-git', description: 'Turn git and gh polling off (e.g. outside a repository) or back on' })
    return started
  })

  on('command.run', { command: 'toggle-git' }, async $ => {
    const now = await update($, gitOn, v => !v)
    if (now) for (const f of resumers) f()
    return { text: now ? 'Git polling on.' : 'Git polling off. /toggle-git to turn it back on.' }
  })
}
