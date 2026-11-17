# claude-mods

Personal Claude Code mods, as a plugin marketplace.

## reality-plus

A skin for the Claude Code terminal UI:

- HUD strip above the prompt (project, session name, branch, Slurm counts, model, goal progress) with a TABS button
- Tabs: Work, Git (issues, PRs, branches, worktrees, stashes, commits), Slurm, Files, Notes
- `/wave`: a faint animated blue wave with two sloops; the lead ship carries notifications (PR checks, reviews, finished Slurm jobs)
- `/waiting`: a green box of running subagents, background shells and Monitor watches; each spins while live and draws a check (or a red cross on failure) when it ends
- `/holding`: a yellow HOLDING bar marking the session as an open window that needs no attention right now; `/holding` again clears it
- Folded tool rows, coloured Bash and diff cards
- `/wrap-up` handoff and `/wind-down` resume prep

### Install

```
/plugin marketplace add djriffle/claude-mods
/plugin install reality-plus@riffled-mods
```

Check and test with `claude plugin validate reality-plus` and `claude plugin test reality-plus`.
