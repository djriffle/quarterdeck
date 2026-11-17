import type { EngineInterface, Register } from 'claude-code'

// /wind-down [note]: sends whoever is in control of this session (the main conversation, the
// orchestrator) a standard wind-down brief as a prompt of its own: stop starting work, settle
// subagents, leave background jobs running, and write everything a later resume needs. Queued by the
// engine until the current turn ends, so it never cuts work off mid-step.

function brief(sessionId: string, note: string, notesFile: string) {
  return [
    'WIND DOWN: I am about to close this session and will resume it later. Wrap up so a resume is smooth:',
    '',
    '1. Stop starting new work. Finish the step you are on only if it takes a minute or two; otherwise stop at a clean point.',
    '2. Subagents: let any that are about to finish deliver, then TaskStop every agent still listed as running. List what each was doing and whether its work landed.',
    '3. Long-running jobs: do NOT cancel anything meant to outlive the session. Record every job or process you started or are watching, what it is for, its state, and what to check or run next when it finishes.',
    '4. Code: list every worktree and branch you touched, with uncommitted changes and unpushed commits. Do not commit or push unless I already asked for it in this session; just record what is pending.',
    '5. GitHub: if this session already posts progress to issues/PRs, post a short status comment on the ones in play; otherwise just list them.',
    '6. Memory: write or update a project memory file marked "READ ON RESUME" with: goal, decisions made, current state, job ids, worktrees/branches, open questions, and the exact next steps in order. Add or update its line in MEMORY.md. Drop or correct anything that turned out to be wrong.',
    `7. My session notes, if any, are in ${notesFile}: fold anything relevant into the memory file.`,
    `8. End with a short summary: what is done, what is still running, the first thing to do on resume, a suggested /rename if the current name does not fit, and the resume command: claude --resume ${sessionId}`,
    ...(note ? ['', `Also, from me: ${note}`] : []),
  ].join('\n')
}

async function windDown($: EngineInterface, note: string): Promise<string> {
  const sessionId = await $.session.id()
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set: cannot name the notes file for the wind-down brief')
  const notesFile = `${home.replace(/\/+$/, '')}/.claude/mods-data/reality-plus-noslurm/notes/${sessionId}.md`
  const text = brief(sessionId, note, notesFile)
  // Submitted after this command has answered: a command.run hook may not wait on a new turn.
  $.clock.after(0, () => {
    $.prompt.submit({ text }).catch(err => {
      $.ui.log(`reality-plus /wind-down: submitting the brief failed: ${String(err)}`)
      $.ui.toast(`/wind-down failed: ${String(err)}`)
    })
  })
  return 'Wind-down sent: Claude will start it as soon as the current turn ends.'
}

export const registerWindDown = (on: Parameters<Register>[0]) => {
  // Matched: register.tsx holds the mod's one unmatched session.start.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'wind-down',
      description: 'Tell the agent in control to wrap up and set everything up for a clean resume',
      argumentHint: '[anything extra to note]',
    })
    return started
  })

  on('command.run', { command: 'wind-down' }, async ($, e) => ({ text: await windDown($, e.args.trim()) }))
}
