import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Issue, Job, Worktree } from '../types'
import { GIT_PANE, GIT_TITLE, registerGitPanel } from './gitpanel'
import { onGitResume } from './gitpoll'

// Owned by gitpoll.tsx (/toggle-git); read here.
const gitOn = atom({ plugin: 'reality-plus', key: 'git-on' } as const, true)

const PANE = 'work-panel'
const TITLE = 'Work'
const SLURM_PANE = 'slurm'
const SLURM_TITLE = 'Slurm'
const SLURM_EVERY_MS = 20_000
const PANE_BG = 'rgb(20,20,20)'
// Issues and PRs this session touched: numbers you typed (#385, "issue 385") and
// numbers Claude's gh commands acted on. Details refreshed from GitHub.
const ISSUES_EVERY_MS = 300_000
const WORKTREES_EVERY_MS = 30_000
const AGENTS_EVERY_MS = 5_000
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting', 'idle'])

const issues = atom({ plugin: 'reality-plus', key: 'wp-issues' } as const, { items: [], at: 0 }, { shape: 'issues-2' })
const refs = atom({ plugin: 'reality-plus', key: 'wp-refs' } as const, [], { shape: 'refs-1' })

// The person's own words only: drop injected <tag>…</tag> blocks (reminders, memory).
const promptRefs = (text: string): number[] => {
  const clean = text.replace(/<([a-zA-Z_-]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
  const out = new Set<number>()
  for (const m of clean.matchAll(/(?:#|\b(?:issues?|prs?|pull requests?)\s+#?)(\d{1,5})\b/gi)) out.add(Number(m[1]))
  return [...out]
}

const commandRefs = (command: string, stdout = ''): number[] => {
  const out = new Set<number>()
  for (const m of command.matchAll(/\bgh\s+(?:issue|pr)\s+(?:view|edit|comment|close|reopen|develop|merge|checkout|ready|review|diff|checks)\s+#?(\d{1,5})\b/g)) out.add(Number(m[1]))
  if (/\bgh\s+(?:issue|pr)\s+create\b/.test(command))
    for (const m of stdout.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/(\d+)/g)) out.add(Number(m[1]))
  return [...out]
}

let refreshIssuesNow: (() => void) | undefined
const worktrees = atom({ plugin: 'reality-plus', key: 'wp-worktrees' } as const, { items: [], at: 0 }, { shape: 'worktrees-1' })
const activity = atom({ plugin: 'reality-plus', key: 'wp-activity' } as const, {}, { shape: 'activity-1' })
const jobs = atom({ plugin: 'reality-plus', key: 'wp-jobs' } as const, { items: [], at: 0 }, { shape: 'jobs-1' })
const tick = atom({ plugin: 'reality-plus', key: 'wp-tick' } as const, 0)

const issueIn = (s: string): number | undefined => {
  const m = s.match(/(?:^|[-_/])(\d{2,4})(?=[-_/]|$)/)
  return m ? Number(m[1]) : undefined
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

const oneLine = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// What a tool call is doing, in a few words, from its own arguments.
const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const file = pick('file_path') ?? pick('notebook_path')
  const what =
    pick('description') ??
    (file ? basename(file) : undefined) ??
    pick('pattern') ??
    pick('command') ??
    pick('query') ??
    pick('url') ??
    pick('prompt') ??
    ''
  return oneLine(what ? `${tool}: ${what}` : tool)
}

type Engine = Parameters<typeof update>[0]

async function addRefs($: Engine, nums: number[]) {
  if (nums.length === 0) return
  const before = await read($, refs)
  const fresh = nums.filter(n => !before.includes(n))
  if (fresh.length === 0) return
  await update($, refs, r => [...new Set([...r, ...fresh])])
  refreshIssuesNow?.()
}

// All five tabs (Work, Git, Slurm, Files, Notes) open and close together: any open -> close
// them all; none -> open all. Used by /tabs and by the HUD's TABS button directly.
const ALL_TABS = [
  { id: PANE, title: TITLE },
  { id: GIT_PANE, title: GIT_TITLE },
  { id: SLURM_PANE, title: SLURM_TITLE },
  { id: 'files', title: 'Files' },
  { id: 'notes', title: 'Notes' },
]
export async function toggleTabs($: Engine): Promise<string> {
  const ids = ALL_TABS.map(t => t.id)
  const up = (await $.ui.panes()).filter(p => ids.includes(p.id))
  if (up.length > 0) {
    for (const p of up) await $.ui.close({ id: p.id })
    return 'Tabs closed.'
  }
  const failed: string[] = []
  for (const sp of ALL_TABS) {
    const r = await $.ui.open({ ...sp, backgroundColor: PANE_BG })
    if (!r.isPlaced) failed.push(`${sp.id}: ${r.reason}`)
  }
  return failed.length ? `Tabs not placed: ${failed.join('; ')}` : 'Tabs opened.'
}

export const registerWorkPanel = (on: Parameters<Register>[0]) => {
  // Matched: register.tsx holds the mod's one unmatched session.start.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    const cwd = e.cwd

    // Seed from what you already typed this session (resumes and reloads included).
    const seeded = (await $.session.messages())
      .filter(m => m.role === 'user')
      .flatMap(m => promptRefs(m.text))
    if (seeded.length) await update($, refs, r => [...new Set([...r, ...seeded])])

    const refreshIssues = async () => {
      if (!(await read($, gitOn))) return
      const nums = await read($, refs)
      if (nums.length === 0) {
        await update($, issues, () => ({ items: [], at: Date.now() }))
        return
      }
      const items: Issue[] = []
      const errors: string[] = []
      for (const n of nums) {
        const r = await $.process.run(['gh', 'api', `repos/{owner}/{repo}/issues/${n}`], { cwd, timeoutMs: 30_000 })
        if (r.exitCode !== 0) {
          errors.push(`#${n}: ${oneLine(r.stderr || `gh exited ${r.exitCode}`, 80)}`)
          continue
        }
        const j = JSON.parse(r.stdout) as { number: number; title: string; state: string; html_url: string; pull_request?: unknown }
        items.push({ number: j.number, title: j.title, state: j.state, url: j.html_url, isPR: Boolean(j.pull_request) })
      }
      items.sort((a, b) => b.number - a.number)
      await update($, issues, () => ({ items, at: Date.now(), error: errors.length ? errors.join('; ') : undefined }))
    }

    const refreshWorktrees = async () => {
      if (!(await read($, gitOn))) return
      const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd })
      if (r.exitCode !== 0) {
        await update($, worktrees, s => ({ ...s, error: oneLine(r.stderr || `git exited ${r.exitCode}`, 200), at: Date.now() }))
        return
      }
      const listed: Worktree[] = r.stdout
        .split(/\n\n+/)
        .filter(b => b.startsWith('worktree '))
        .map((block, i) => {
          const lines = block.split('\n')
          const path = lines[0].slice('worktree '.length)
          const br = lines.find(l => l.startsWith('branch '))
          const head = lines.find(l => l.startsWith('HEAD '))
          const branch = br ? br.slice('branch refs/heads/'.length) : `detached @ ${(head ?? '').slice(5, 12)}`
          return {
            path,
            branch,
            issue: issueIn(br ? branch : '') ?? issueIn(basename(path)),
            isMain: i === 0,
            isPrunable: lines.some(l => l.startsWith('prunable')),
            isLocked: lines.some(l => l.startsWith('locked')),
          }
        })

      // The base every worktree is measured against: the remote's default branch, as a local branch.
      const originHead = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd })
      if (originHead.exitCode !== 0) {
        await update($, worktrees, () => ({ items: listed, at: Date.now(), error: `no default branch: ${oneLine(originHead.stderr, 120)}` }))
        return
      }
      const base = originHead.stdout.trim().replace(/^origin\//, '')

      const git = (path: string, args: string[]) => $.process.run(['git', '-C', path, ...args], { timeoutMs: 20_000 })
      const items = await Promise.all(
        listed.map(async (w): Promise<Worktree> => {
          if (w.isPrunable) return w
          const [status, counts, merged, age] = await Promise.all([
            git(w.path, ['status', '--porcelain']),
            git(w.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
            git(w.path, ['merge-base', '--is-ancestor', 'HEAD', base]),
            git(w.path, ['log', '-1', '--format=%cr']),
          ])
          const failed = [status, counts, age].find(x => x.exitCode !== 0) ?? (merged.exitCode > 1 ? merged : undefined)
          if (failed) return { ...w, healthError: oneLine(failed.stderr || `git exited ${failed.exitCode}`, 80) }
          const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
          return {
            ...w,
            health: {
              dirty: status.stdout.split('\n').filter(Boolean).length,
              ahead,
              behind,
              isMerged: merged.exitCode === 0,
              age: age.stdout.trim().replace(/ ago$/, ''),
            },
          }
        }),
      )
      await update($, worktrees, () => ({ items, at: Date.now(), base }))
    }

    // Errors from the refreshes land in the pane; anything else is logged loudly.
    const guard = (name: string, f: () => Promise<void>) => () => {
      f().catch(err => $.ui.log(`reality-plus work-panel ${name} refresh failed: ${String(err)}`))
    }
    refreshIssuesNow = guard('issues', refreshIssues)
    refreshIssuesNow()
    guard('worktrees', refreshWorktrees)()
    onGitResume(() => {
      refreshIssuesNow?.()
      guard('worktrees', refreshWorktrees)()
    })
    $.clock.every(ISSUES_EVERY_MS, guard('issues', refreshIssues))
    $.clock.every(WORKTREES_EVERY_MS, guard('worktrees', refreshWorktrees))
    const refreshJobs = async () => {
      const r = await $.process.run(['squeue', '--me', '-h', '-o', '%i|%j|%t|%M|%l|%R|%P'], { timeoutMs: 20_000 })
      if (r.exitCode !== 0) {
        await update($, jobs, s => ({ ...s, error: oneLine(r.stderr || `squeue exited ${r.exitCode}`, 200), at: Date.now() }))
        return
      }
      const items: Job[] = r.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const f = line.split('|')
          // The name is the one field that may itself hold a '|'.
          const tail = f.slice(-5)
          return { id: f[0], name: f.slice(1, f.length - 5).join('|'), state: tail[0], elapsed: tail[1], limit: tail[2], where: tail[3], partition: tail[4] }
        })
      await update($, jobs, () => ({ items, at: Date.now() }))
    }
    guard('slurm', refreshJobs)()
    $.clock.every(SLURM_EVERY_MS, guard('slurm', refreshJobs))
    $.clock.every(AGENTS_EVERY_MS, () => {
      void update($, tick, n => n + 1)
    })

    await $.command.register({ name: 'work-panel', description: 'Show this session\'s issues, worktrees and subagents' })
    await $.command.register({ name: 'slurm', description: 'Show your Slurm jobs in a pane' })
    await $.command.register({ name: 'tabs', description: 'Open all tabs (Work, Git, Slurm, Files, Notes), or close them if any are open' })
    return started
  })

  on('command.run', { command: 'tabs' }, async $ => ({ text: await toggleTabs($) }))

  on('command.run', { command: 'work-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, backgroundColor: PANE_BG })
    return { text: opened.isPlaced ? 'Work panel opened.' : `Work panel not placed: ${opened.reason}` }
  })

  on('command.run', { command: 'slurm' }, async $ => {
    const opened = await $.ui.open({ id: SLURM_PANE, title: SLURM_TITLE, backgroundColor: PANE_BG })
    return { text: opened.isPlaced ? 'Slurm tab opened.' : `Slurm tab not placed: ${opened.reason}` }
  })

  // Your jobs, grouped by Kusama experiment id (kusama-<12 hex>-<stage>), running first.
  on('ui.render', { component: 'Pane', requestId: SLURM_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, jobs)
    const running = snap.items.filter(j => j.state === 'R').length
    const pending = snap.items.filter(j => j.state === 'PD').length
    const groups = new Map<string, { job: Job; label: string }[]>()
    for (const job of snap.items) {
      const m = job.name.match(/^kusama-([0-9a-f]{12})-(.*)$/)
      const key = m ? m[1] : 'other'
      const list = groups.get(key) ?? []
      list.push({ job, label: m ? m[2] : job.name })
      groups.set(key, list)
    }
    const rank = (s: string) => (s === 'R' ? 0 : s === 'PD' ? 1 : 2)
    const ago = snap.at ? Math.round((Date.now() - snap.at) / 1000) : undefined
    return (
      <Box flexDirection="column">
        <Text>
          <Text backgroundColor="suggestion" color="inverseText" bold>
            {' SLURM '}
          </Text>
          <Text color="suggestion"> ▸▸ </Text>
          <Text color="suggestion">▶{running}</Text>
          <Text color="inactive"> ⏸{pending}</Text>
          {snap.items.length - running - pending > 0 && <Text color="inactive"> · {snap.items.length - running - pending} other</Text>}
          {ago !== undefined && <Text color="subtle"> · {ago}s ago</Text>}
        </Text>
        {snap.at === 0 && !snap.error && <Text dimColor>loading…</Text>}
        {snap.error && <Text color="red" wrap="truncate-end">squeue: {snap.error}</Text>}
        {snap.at > 0 && snap.items.length === 0 && !snap.error && <Text dimColor>No jobs in the queue.</Text>}
        {[...groups.entries()].map(([key, list]) => (
          <Box flexDirection="column" marginTop={1}>
            <Text color="suggestion" bold>
              {key === 'other' ? 'other' : `exp ${key}`}
              <Text color="subtle"> ({list.length})</Text>
            </Text>
            {list
              .sort((a, b) => rank(a.job.state) - rank(b.job.state))
              .map(({ job, label }) => (
                <Box flexDirection="column">
                  <Text wrap="truncate-middle">
                    <Text color={job.state === 'R' ? 'suggestion' : 'inactive'}>{job.state === 'R' ? '▶ ' : job.state === 'PD' ? '⏸ ' : `${job.state} `}</Text>
                    {label}
                  </Text>
                  <Text color="inactive" wrap="truncate-end">
                    {'  '}
                    {job.id} · {job.state === 'R' ? `${job.elapsed} / ${job.limit} · ${job.where}` : job.where}
                  </Text>
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )
  })

  registerGitPanel(on)

  on('prompt.submit', async ($, e, next) => {
    addRefs($, promptRefs(e.text)).catch(err => $.ui.log(`reality-plus work-panel prompt refs failed: ${String(err)}`))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      const out = 'result' in r && r.result ? String((r.result as { stdout?: string }).stdout ?? '') : ''
      addRefs($, commandRefs(e.command, out)).catch(err => $.ui.log(`reality-plus work-panel gh refs failed: ${String(err)}`))
    }
    return r
  })

  // Remember each subagent's latest action. Matched: register.tsx holds the one unmatched tool.call.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const line = describeCall(e.tool, e as unknown as Record<string, unknown>)
      // Not awaited: the panel must never hold up or fail a tool call; failures are logged.
      update($, activity, a => ({ ...a, [id]: line })).catch(err =>
        $.ui.log(`reality-plus work-panel activity update failed: ${String(err)}`),
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const queue = await read($, jobs)
    await read($, tick)
    const iss = await read($, issues)
    const wts = await read($, worktrees)
    const polling = await read($, gitOn)
    const act = await read($, activity)
    const agents = await $.agent.list()
    const withTree = new Set(wts.items.map(w => w.issue).filter((n): n is number => n !== undefined))
    const live = agents.filter(a => ACTIVE_AGENT.has(a.status))
    const done = agents.filter(a => !ACTIVE_AGENT.has(a.status))
    const recent = done.slice(-3)

    // Filled tag + count, matching the reality-plus skin (theme keys).
    const Head = (p: { label: string; count: string }) => (
      <Text>
        <Text backgroundColor="suggestion" color="inverseText" bold>
          {` ${p.label} `}
        </Text>
        <Text color="suggestion"> ▸▸ </Text>
        <Text color="suggestion">{p.count}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Head label="ISSUES" count={`${iss.items.length} this session`} />
        {iss.at === 0 && !iss.error && <Text dimColor>loading…</Text>}
        {iss.at > 0 && iss.items.length === 0 && !iss.error && (
          <Text dimColor wrap="truncate-end">none yet: mention #123 or work on one with gh</Text>
        )}
        {polling && iss.error && <Text color="red" wrap="truncate-end">gh: {iss.error}</Text>}
        {iss.items.map(i => (
          <Box flexDirection="row">
            <Link href={i.url}>{`${i.isPR ? 'PR ' : ''}#${i.number}`}</Link>
            <Text wrap="truncate-end" dimColor={i.state === 'closed'}>
              {i.state === 'closed' ? ' ✓ ' : withTree.has(i.number) ? ' ⑂ ' : '   '}
              {i.title}
            </Text>
          </Box>
        ))}

        <Text> </Text>
        <Text>
          <Text backgroundColor="suggestion" color="inverseText" bold>
            {' SLURM '}
          </Text>
          <Text color="suggestion"> ▸▸ </Text>
          <Text color="suggestion">▶{queue.items.filter(j => j.state === 'R').length}</Text>
          <Text color="inactive"> ⏸{queue.items.filter(j => j.state === 'PD').length}</Text>
        </Text>
        {queue.error && <Text color="red" wrap="truncate-end">squeue: {queue.error}</Text>}
        {queue.items
          .filter(j => j.state === 'R')
          .slice(0, 4)
          .map(j => (
            <Text wrap="truncate-middle">
              <Text color="suggestion">▶ </Text>
              {j.name.replace(/^kusama-[0-9a-f]{12}-/, '')}
              <Text color="inactive"> {j.elapsed}</Text>
            </Text>
          ))}
        {queue.items.filter(j => j.state === 'R').length > 4 && (
          <Text color="inactive">  +{queue.items.filter(j => j.state === 'R').length - 4} more running</Text>
        )}

        <Text> </Text>
        <Head label="WORKTREES" count={`${wts.items.length} vs ${wts.base ?? '…'}`} />
        {!polling && <Text color="inactive">git polling off · /toggle-git to resume</Text>}
        {polling && wts.error && <Text color="red" wrap="truncate-end">git: {wts.error}</Text>}
        {wts.items.map(w => {
          const wh = w.health
          const removable = !w.isMain && !w.isLocked && wh !== undefined && wh.isMerged && wh.dirty === 0
          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={w.isPrunable ? 'error' : removable ? 'inactive' : wh && wh.dirty > 0 ? 'warning' : 'suggestion'}>⑂ </Text>
                <Text dimColor={removable}>{basename(w.path)}</Text> <Text dimColor>{w.branch}</Text>
              </Text>
              <Text wrap="truncate-end">
                {'  '}
                {w.isPrunable && <Text color="error">⚠ folder missing · prunable</Text>}
                {w.healthError && <Text color="error">git: {w.healthError}</Text>}
                {wh && wh.dirty > 0 && <Text color="warning">●{wh.dirty} changed </Text>}
                {wh && wh.ahead > 0 && <Text color="suggestion">↑{wh.ahead} </Text>}
                {wh && wh.behind > 0 && <Text color="inactive">↓{wh.behind} </Text>}
                {removable && <Text color="inactive">✓ merged · can remove </Text>}
                {wh && !removable && wh.dirty === 0 && wh.ahead === 0 && !w.isMain && <Text color="inactive">clean </Text>}
                {w.isLocked && <Text color="inactive">🔒 locked </Text>}
                {wh && <Text color="subtle">· {wh.age}</Text>}
              </Text>
            </Box>
          )
        })}

        <Text> </Text>
        <Head label="AGENTS" count={`${live.length} live · ${done.length} done`} />
        {agents.length === 0 && <Text dimColor>none this session</Text>}
        {live.map(a => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={a.status === 'running' ? 'permission' : 'inactive'}>● </Text>
              {a.description} <Text dimColor>({a.type}, {a.status})</Text>
            </Text>
            <Text dimColor wrap="truncate-end">  └ {act[a.id] ?? 'starting…'}</Text>
          </Box>
        ))}
        {recent.map(a => (
          <Text dimColor wrap="truncate-end">
            {a.status === 'completed' ? '✓' : '✗'} {a.description} ({a.status})
          </Text>
        ))}
      </Box>
    )
  })
}
