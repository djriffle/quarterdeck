import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { onGitResume } from './gitpoll'
import type { GitBranch, GitCommit, GitData, GitIssue, GitPR, GitStash, Issue, Snapshot, Worktree } from '../types'

// Owned by gitpoll.tsx (/toggle-git); read here.
const gitOn = atom({ plugin: 'reality-plus-noslurm', key: 'git-on' } as const, true)

export const GIT_PANE = 'git'
export const GIT_TITLE = 'Git'
const LOCAL_EVERY_MS = 20_000 // branches, stashes, commits, status: local git, cheap
const REMOTE_EVERY_MS = 120_000 // issues and PRs: GitHub API
const LIST_LIMIT = 30
const SHOW = { prs: 12, issues: 12, branches: 16, stashes: 5, commits: 8 }
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])

const git = atom({ plugin: 'reality-plus-noslurm', key: 'git-data' } as const, { at: 0, prs: [], issues: [], branches: [], stashes: [], commits: [], commitsAll: [], errors: {} } as GitData, {
  shape: 'git-1',
})

const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
const issueIn = (s: string): number | undefined => {
  const m = s.match(/(?:^|[-_/])(\d{1,4})(?=[-_/]|$)/)
  return m ? Number(m[1]) : undefined
}

type RollupEntry = { conclusion?: string; status?: string; state?: string }
const ciOf = (rollup: RollupEntry[]): GitPR['ci'] => {
  if (rollup.length === 0) return 'none'
  if (rollup.some(c => FAILING.has(c.conclusion ?? '') || FAILING.has(c.state ?? ''))) return 'fail'
  if (rollup.some(c => (c.status !== undefined && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')) return 'pending'
  return 'pass'
}

// The Work tab's worktree snapshot (same key and shape as in workpanel.tsx), read here, never written.
const worktrees = atom({ plugin: 'reality-plus-noslurm', key: 'wp-worktrees' } as const, { items: [], at: 0 } as Snapshot<Worktree>, { shape: 'worktrees-1' })

// The Work tab's mentioned issues and PRs (same key and shape as in workpanel.tsx), read here, never written.
const mentioned = atom({ plugin: 'reality-plus-noslurm', key: 'wp-issues' } as const, { items: [], at: 0 } as Snapshot<Issue>, { shape: 'issues-2' })
// Issues section view: false = issues mentioned this session (default), true = every open issue.
const showAllPRs = atom({ plugin: 'reality-plus-noslurm', key: 'git-prs-all' } as const, false)
// Branches, worktrees, stashes and commits: false = the ones tied to this session's work (default), true = all.
const views = atom({ plugin: 'reality-plus-noslurm', key: 'git-views' } as const, {} as Record<string, boolean>, { shape: 'views-1' })
const showAll = atom({ plugin: 'reality-plus-noslurm', key: 'git-issues-all' } as const, false)

export const registerGitPanel = (on: Parameters<Register>[0]) => {
  let refreshAll: (() => void) | undefined

  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const started = await next(e)
    const cwd = e.cwd

    const run = async (argv: string[], timeoutMs = 30_000) => {
      const r = await $.process.run(argv, { cwd, timeoutMs })
      if (r.exitCode !== 0) throw new Error(oneLine(r.stderr || `${argv[0]} ${argv[1] ?? ''} exited ${r.exitCode}`))
      return r.stdout
    }

    // A section that fails shows its error in the pane (and in the log); the others still draw.
    const section = async (name: string, f: () => Promise<Partial<GitData>>) => {
      try {
        const part = await f()
        await update($, git, g => {
          const { [name]: _gone, ...errors } = g.errors
          return { ...g, ...part, errors, at: Date.now() }
        })
      } catch (err) {
        $.ui.log(`reality-plus git ${name} refresh failed: ${String(err)}`)
        await update($, git, g => ({ ...g, errors: { ...g.errors, [name]: oneLine(String(err instanceof Error ? err.message : err)) }, at: Date.now() }))
      }
    }

    const baseOf = async () => (await run(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim().replace(/^origin\//, '')

    const refreshLocal = async () => {
      if (!(await read($, gitOn))) return
      let base: string | undefined
      await section('status', async () => {
        base = await baseOf()
        const head = (await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        const dirty = (await run(['git', 'status', '--porcelain'])).split('\n').filter(Boolean).length
        return { base, head, dirty }
      })
      await section('branches', async () => {
        if (!base) throw new Error('no default branch (see status)')
        const b = base
        const [refs, merged] = await Promise.all([
          run([
            'git',
            'for-each-ref',
            'refs/heads',
            `--format=%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:relative)|%(HEAD)|%(ahead-behind:${b})`,
            '--sort=-committerdate',
          ]),
          run(['git', 'branch', '--merged', b, '--format=%(refname:short)']),
        ])
        const mergedSet = new Set(merged.split('\n').map(s => s.trim()).filter(Boolean))
        const branches: GitBranch[] = refs
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [name, upstream, track, age, mark, ab] = line.split('|')
            const [ahead, behind] = ab.trim().split(/\s+/).map(Number)
            return {
              name,
              upstream: upstream || undefined,
              track: track.replace(/^\[|\]$/g, ''),
              isCurrent: mark === '*',
              isBase: name === b,
              isMerged: mergedSet.has(name) && name !== b,
              ahead,
              behind,
              age: age.replace(/ ago$/, ''),
              issue: issueIn(name),
            }
          })
        return { branches }
      })
      await section('stashes', async () => {
        const out = await run(['git', 'stash', 'list', '--format=%gd|%cr|%gs'])
        const stashes: GitStash[] = out
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [ref, age, ...msg] = line.split('|')
            return { ref, age: age.replace(/ ago$/, ''), message: msg.join('|') }
          })
        return { stashes }
      })
      await section('commits', async () => {
        if (!base) throw new Error('no default branch (see status)')
        const parse = (out: string): GitCommit[] =>
          out
            .split('\n')
            .filter(Boolean)
            .map(line => {
              const [sha, age, author, ...subject] = line.split('|')
              return { sha, age: age.replace(/ ago$/, ''), author, subject: subject.join('|') }
            })
        const fmt = '--format=%h|%cr|%an|%s'
        const [onBranch, everywhere] = await Promise.all([
          run(['git', 'log', `${base}..HEAD`, `-${SHOW.commits}`, fmt]),
          run(['git', 'log', '--all', `-${SHOW.commits}`, fmt]),
        ])
        return { commits: parse(onBranch), commitsAll: parse(everywhere) }
      })
    }

    const refreshRemote = async () => {
      if (!(await read($, gitOn))) return
      await section('prs', async () => {
        const out = await run(
          ['gh', 'pr', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,headRefName,isDraft,reviewDecision,mergeable,statusCheckRollup,closingIssuesReferences,author,url'],
        )
        const prs: GitPR[] = (JSON.parse(out) as any[]).map(p => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          isDraft: p.isDraft,
          review: p.reviewDecision || undefined,
          isConflicting: p.mergeable === 'CONFLICTING',
          ci: ciOf(p.statusCheckRollup ?? []),
          closes: (p.closingIssuesReferences ?? []).map((i: { number: number }) => i.number),
          author: p.author?.login ?? '?',
          url: p.url,
        }))
        return { prs }
      })
      await section('issues', async () => {
        const out = await run(['gh', 'issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,labels,assignees,url'])
        const issues: GitIssue[] = (JSON.parse(out) as any[]).map(i => ({
          number: i.number,
          title: i.title,
          labels: (i.labels ?? []).map((l: { name: string }) => l.name),
          assignees: (i.assignees ?? []).map((a: { login: string }) => a.login),
          url: i.url,
        }))
        return { issues }
      })
    }

    const guard = (name: string, f: () => Promise<void>) => () => {
      f().catch(err => $.ui.log(`reality-plus git ${name} refresh failed: ${String(err)}`))
    }
    const local = guard('local', refreshLocal)
    const remote = guard('remote', refreshRemote)
    refreshAll = () => {
      local()
      remote()
    }
    refreshAll()
    onGitResume(refreshAll)
    $.clock.every(LOCAL_EVERY_MS, local)
    $.clock.every(REMOTE_EVERY_MS, remote)

    await $.command.register({ name: 'git', description: 'Show issues, PRs, branches, worktrees and stashes in a Git pane' })
    return started
  })

  on('command.run', { command: 'git' }, async $ => {
    const opened = await $.ui.open({ id: GIT_PANE, title: GIT_TITLE, backgroundColor: 'rgb(20,20,20)' })
    return { text: opened.isPlaced ? 'Git tab opened.' : `Git tab not placed: ${opened.reason}` }
  })

  // After Claude runs git or gh, the pane catches up straight away rather than on the next beat.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (/\b(git|gh)\s/.test(e.command)) refreshAll?.()
    return r
  })

  on('ui.render', { component: 'Pane', requestId: GIT_PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const view = await read($, views)
    const g = await read($, git)
    const polling = await read($, gitOn)
    const all = await read($, showAll)
    const allPRs = await read($, showAllPRs)
    const ment = await read($, mentioned)
    const wts = await read($, worktrees)

    const Head = (p: { label: string; count: string; err?: string }) => (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text backgroundColor="suggestion" color="inverseText" bold>
            {` ${p.label} `}
          </Text>
          <Text color="suggestion"> ▸▸ </Text>
          <Text color="suggestion">{p.count}</Text>
        </Text>
        {p.err && (
          <Text color="red" wrap="truncate-end">
            {p.err}
          </Text>
        )}
      </Box>
    )
    const More = (p: { n: number }) => (p.n > 0 ? <Text color="inactive">  +{p.n} more</Text> : <Box />)
    const loading = g.at === 0
    const prByBranch = new Map(g.prs.map(p => [p.branch, p]))
    const prForIssue = new Map<number, number>()
    for (const p of g.prs) for (const n of p.closes) prForIssue.set(n, p.number)
    const treeByBranch = new Map(wts.items.map(w => [w.branch, w]))
    const ago = g.at ? Math.round((Date.now() - g.at) / 1000) : undefined

    const prs = g.prs.slice(0, SHOW.prs)
    const mentionedPRs = ment.items.filter(i => i.isPR)
    const prRow = (p: GitPR) => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Link href={p.url}>{`#${p.number}`}</Link>
              <Text wrap="truncate-end" dimColor={p.isDraft}>
                {' '}
                {p.isDraft ? '[draft] ' : ''}
                {p.title}
              </Text>
            </Box>
            <Text wrap="truncate-end">
              {'  '}
              <Text color={p.ci === 'fail' ? 'error' : p.ci === 'pending' ? 'warning' : p.ci === 'pass' ? 'suggestion' : 'inactive'}>
                {p.ci === 'fail' ? '✗ checks' : p.ci === 'pending' ? '… checks' : p.ci === 'pass' ? '✓ checks' : '– no checks'}
              </Text>
              {p.review && (
                <Text color={p.review === 'APPROVED' ? 'suggestion' : p.review === 'CHANGES_REQUESTED' ? 'error' : 'inactive'}>
                  {' · '}
                  {p.review.toLowerCase().replace('_', ' ')}
                </Text>
              )}
              {p.isConflicting && <Text color="error"> · conflicts</Text>}
              <Text color="subtle">
                {' · '}
                {p.branch}
                {p.closes.length > 0 ? ` · closes ${p.closes.map(n => `#${n}`).join(' ')}` : ''}
              </Text>
            </Text>
          </Box>
    )
    const issues = g.issues.slice(0, SHOW.issues)
    // Mentioned: the Work tab's list; PRs are in their own section above.
    const mentionedIssues = ment.items.filter(i => !i.isPR)
    // Merged branches (safe to delete) sink; current and unmerged work first.
    const branches = [...g.branches].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || Number(a.isMerged) - Number(b.isMerged))
    const stale = g.branches.filter(b => b.isMerged && !b.isCurrent).length

    // Related to this session: the current branch and base, branches and worktrees of mentioned issues and PRs.
    const nums = new Set(ment.items.map(i => i.number))
    const relatedBranches = new Set(g.prs.filter(p => nums.has(p.number)).map(p => p.branch))
    const isRelated = (branch: string, issue?: number) =>
      branch === g.head || relatedBranches.has(branch) || (issue !== undefined && nums.has(issue))
    const shownBranches = view.branches ? branches : branches.filter(b => b.isBase || isRelated(b.name, b.issue) || treeByBranch.has(b.name))
    const shownTrees = view.worktrees ? wts.items : wts.items.filter(w => w.isMain || isRelated(w.branch, w.issue))
    const onHead = new RegExp(`\\b[Oo]n ${(g.head ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
    const shownStashes = view.stashes ? g.stashes : g.stashes.filter(s => onHead.test(s.message))
    const shownCommits = view.commits ? g.commitsAll : g.commits
    const Toggle = (p: { k: string }) => (
      <Button
        key={`${p.k}-view`}
        label={view[p.k] ? 'show related' : 'show all'}
        onPress={() =>
          update($, views, v => ({ ...v, [p.k]: !v[p.k] })).catch(err => {
            $.ui.log(`reality-plus ${p.k} toggle failed: ${String(err)}`)
            $.ui.toast(`${p.k} toggle: ${String(err)}`)
          })
        }
      />
    )

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text backgroundColor="claude" color="inverseText" bold>
            {' GIT '}
          </Text>
          <Text color="suggestion"> ⑂ {g.head ?? '…'}</Text>
          {g.dirty !== undefined && g.dirty > 0 && <Text color="warning"> ●{g.dirty} changed</Text>}
          {g.dirty === 0 && <Text color="inactive"> clean</Text>}
          {ago !== undefined && <Text color="subtle"> · {ago}s ago</Text>}
        </Text>
        {!polling && <Text color="inactive">git polling off · /toggle-git to resume</Text>}
        {polling && g.errors.status && <Text color="red" wrap="truncate-end">git: {g.errors.status}</Text>}
        {polling && loading && <Text dimColor>loading…</Text>}

        {allPRs ? (
          <Head label="PULL REQUESTS" count={`${g.prs.length} open (all)`} err={polling && g.errors.prs ? `gh: ${g.errors.prs}` : undefined} />
        ) : (
          <Head label="PULL REQUESTS" count={`${mentionedPRs.length} mentioned`} err={polling && ment.error ? `gh: ${ment.error}` : undefined} />
        )}
        <Button
          key="prs-view"
          label={allPRs ? 'show mentioned' : 'show all open'}
          onPress={() =>
            update($, showAllPRs, v => !v).catch(err => {
              $.ui.log(`reality-plus PRs toggle failed: ${String(err)}`)
              $.ui.toast(`PRs toggle: ${String(err)}`)
            })
          }
        />
        {allPRs && !loading && !g.errors.prs && g.prs.length === 0 && <Text dimColor>none open</Text>}
        {!allPRs && ment.at > 0 && !ment.error && mentionedPRs.length === 0 && (
          <Text dimColor wrap="truncate-end">none yet: mention PR #123 or work on one with gh</Text>
        )}
        {!allPRs && ment.at === 0 && <Text dimColor>loading…</Text>}
        {allPRs && prs.map(p => prRow(p))}
        {allPRs && <More n={g.prs.length - prs.length} />}
        {!allPRs &&
          mentionedPRs.map(m => {
            const full = g.prs.find(p => p.number === m.number)
            // An open PR draws with its checks; a closed or merged one has no live status.
            return full ? (
              prRow(full)
            ) : (
              <Box flexDirection="row">
                <Link href={m.url}>{`#${m.number}`}</Link>
                <Text wrap="truncate-end" dimColor>
                  {m.state === 'closed' ? ' ✓ ' : ' '}
                  {m.title}
                </Text>
              </Box>
            )
          })}

        {all ? (
          <Head label="ISSUES" count={`${g.issues.length} open (all)`} err={polling && g.errors.issues ? `gh: ${g.errors.issues}` : undefined} />
        ) : (
          <Head label="ISSUES" count={`${mentionedIssues.length} mentioned`} err={polling && ment.error ? `gh: ${ment.error}` : undefined} />
        )}
        <Button
          key="issues-view"
          label={all ? 'show mentioned' : 'show all open'}
          onPress={() =>
            update($, showAll, v => !v).catch(err => {
              $.ui.log(`reality-plus issues toggle failed: ${String(err)}`)
              $.ui.toast(`Issues toggle: ${String(err)}`)
            })
          }
        />
        {all && !loading && !g.errors.issues && g.issues.length === 0 && <Text dimColor>none open</Text>}
        {!all && ment.at > 0 && !ment.error && mentionedIssues.length === 0 && (
          <Text dimColor wrap="truncate-end">none yet: mention #123 or work on one with gh</Text>
        )}
        {!all && ment.at === 0 && <Text dimColor>loading…</Text>}
        {!all &&
          mentionedIssues.map(i => (
            <Box flexDirection="row">
              <Link href={i.url}>{`#${i.number}`}</Link>
              <Text wrap="truncate-end" dimColor={i.state === 'closed'}>
                {i.state === 'closed' ? ' ✓ ' : prForIssue.has(i.number) ? ` ⇢PR#${prForIssue.get(i.number)} ` : ' '}
                {i.title}
              </Text>
            </Box>
          ))}
        {all &&
          issues.map(i => (
            <Box flexDirection="row">
              <Link href={i.url}>{`#${i.number}`}</Link>
              <Text wrap="truncate-end">
                {prForIssue.has(i.number) ? <Text color="suggestion"> ⇢PR#{prForIssue.get(i.number)} </Text> : ' '}
                {i.title}
                {i.labels.length > 0 && <Text color="subtle"> [{i.labels.join(',')}]</Text>}
                {i.assignees.length > 0 && <Text color="inactive"> @{i.assignees.join(',@')}</Text>}
              </Text>
            </Box>
          ))}
        {all && <More n={g.issues.length - issues.length} />}

        <Head
          label="BRANCHES"
          count={`${shownBranches.length}${view.branches ? ' (all)' : ` of ${g.branches.length}`}${stale > 0 ? ` · ${stale} merged` : ''} vs ${g.base ?? '…'}`}
          err={polling && g.errors.branches ? `git: ${g.errors.branches}` : undefined}
        />
        <Toggle k="branches" />
        {shownBranches.slice(0, SHOW.branches).map(b => {
          const pr = prByBranch.get(b.name)
          const tree = treeByBranch.get(b.name)
          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={b.isCurrent ? 'claude' : b.isMerged ? 'inactive' : 'suggestion'}>{b.isCurrent ? '● ' : '⑂ '}</Text>
                <Text dimColor={b.isMerged} bold={b.isCurrent}>
                  {b.name}
                </Text>
                {pr && <Text color="suggestion"> PR#{pr.number}</Text>}
                {tree && !tree.isMain && <Text color="inactive"> ⌂ worktree</Text>}
              </Text>
              <Text wrap="truncate-end">
                {'  '}
                {b.isBase && <Text color="inactive">base </Text>}
                {b.ahead > 0 && <Text color="suggestion">↑{b.ahead} </Text>}
                {b.behind > 0 && <Text color="inactive">↓{b.behind} </Text>}
                {b.isMerged && !b.isCurrent && <Text color="inactive">✓ merged · can delete </Text>}
                {b.track === 'gone' && <Text color="warning">upstream gone </Text>}
                {!b.upstream && !b.isBase && <Text color="warning">not pushed </Text>}
                {b.upstream && b.track !== '' && b.track !== 'gone' && <Text color="inactive">{b.track} </Text>}
                <Text color="subtle">· {b.age}</Text>
              </Text>
            </Box>
          )
        })}
        <More n={shownBranches.length - SHOW.branches} />

        <Head
          label="WORKTREES"
          count={`${shownTrees.length}${view.worktrees ? ' (all)' : ` of ${wts.items.length}`}`}
          err={polling && wts.error ? `git: ${wts.error}` : undefined}
        />
        <Toggle k="worktrees" />
        {shownTrees.map(w => (
          <Text wrap="truncate-end">
            <Text color={w.isPrunable ? 'error' : w.health && w.health.dirty > 0 ? 'warning' : 'suggestion'}>⌂ </Text>
            {basename(w.path)} <Text dimColor>{w.branch}</Text>
            {w.health && w.health.dirty > 0 && <Text color="warning"> ●{w.health.dirty}</Text>}
            {w.health && w.health.ahead > 0 && <Text color="suggestion"> ↑{w.health.ahead}</Text>}
            {w.health?.isMerged && !w.isMain && <Text color="inactive"> ✓ merged</Text>}
            {w.isPrunable && <Text color="error"> ⚠ prunable</Text>}
          </Text>
        ))}

        <Head
          label="STASHES"
          count={`${shownStashes.length}${view.stashes ? ' (all)' : ` of ${g.stashes.length}`}`}
          err={polling && g.errors.stashes ? `git: ${g.errors.stashes}` : undefined}
        />
        <Toggle k="stashes" />
        {!loading && !g.errors.stashes && shownStashes.length === 0 && <Text dimColor>none{view.stashes ? '' : ' on this branch'}</Text>}
        {shownStashes.slice(0, SHOW.stashes).map(s => (
          <Text wrap="truncate-end">
            <Text color="inactive">{s.ref} </Text>
            {s.message} <Text color="subtle">· {s.age}</Text>
          </Text>
        ))}
        <More n={shownStashes.length - SHOW.stashes} />

        <Head
          label="COMMITS"
          count={view.commits ? 'all branches' : `${g.head ?? ''} ahead of ${g.base ?? '…'}`}
          err={polling && g.errors.commits ? `git: ${g.errors.commits}` : undefined}
        />
        <Toggle k="commits" />
        {!view.commits && !loading && !g.errors.commits && g.commits.length === 0 && <Text dimColor>nothing ahead of {g.base}</Text>}
        {shownCommits.map(c => (
          <Text wrap="truncate-end">
            <Text color="inactive">{c.sha} </Text>
            {c.subject} <Text color="subtle">· {c.author}, {c.age}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
