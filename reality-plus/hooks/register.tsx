import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Goal, Hud, Notice, TaskItem } from '../types'
import { registerTranscript } from './transcript'
import { registerWrapUp } from './wrapup'
import { registerFileTree } from './filetree'
import { registerNotes } from './notes'
import { registerWorkPanel, toggleTabs } from './workpanel'
import { registerWindDown } from './winddown'
import { registerWave, waveRows } from './wave'
import { registerNotify } from './notify'
import { registerWaiting, waitingBox } from './waiting'
import { holdingBar, registerHolding } from './holding'
import { onGitResume, registerGitPoll } from './gitpoll'

// Owned by gitpoll.tsx (/toggle-git); read here.
const gitOn = atom({ plugin: 'reality-plus', key: 'git-on' } as const, true)

// Colours are theme keys, so the skin follows ~/.claude/themes/reality-plus.json
// (pick "Reality+" in /theme): Claude's traditional orange #D77757 as the one
// accent, TRO cyan, soft lavender #A99CF0 for live/warning; degrades gracefully under any other theme.
const ACCENT = 'claude' // Claude orange #D77757
const SIGNAL = 'suggestion' // softened TRO cyan #5EB0BA
const HOT = 'warning' // lavender #A99CF0
const INK = 'inverseText' // near-black, for text on a filled tag
const DIM = 'inactive'
const RULE = 'subtle'

const HUD_EVERY_MS = 20_000

const hud = atom({ plugin: 'reality-plus', key: 'hud' } as const, { branch: '…', running: 0, pending: 0 }, { shape: 'hud-1' })
const goal = atom({ plugin: 'reality-plus', key: 'goal' } as const, { tasks: {}, todos: [] } as Goal, { shape: 'goal-1' })
const sessionName = atom({ plugin: 'reality-plus', key: 'session' } as const, {}, { shape: 'session-1' })

const waveOn = atom({ plugin: 'reality-plus', key: 'wave-on' } as const, false)
const wavePhase = atom({ plugin: 'reality-plus', key: 'wave-phase' } as const, 0)
const notifyLatest = atom({ plugin: 'reality-plus', key: 'notify-latest' } as const, null as Notice | null, { shape: 'notify-1' })

const SESSION_EVERY_MS = 30_000
const NAME_EVERY_MS = 5_000 // a /rename should show within seconds
const modelName = atom({ plugin: 'reality-plus', key: 'model' } as const, '')

// claude-opus-5-5 -> "Opus 5.5"; an id that does not follow that shape is shown as is.
const prettyModel = (id: string) => {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}


const bar = (done: number, total: number, width = 10) => {
  const n = total === 0 ? 0 : Math.round((done / total) * width)
  return '▰'.repeat(n) + '▱'.repeat(width - n)
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)


export const register: Register = on => {
  registerTranscript(on)
  registerWrapUp(on)
  registerFileTree(on)
  registerNotes(on)
  registerWorkPanel(on)
  registerWindDown(on)
  registerWave(on)
  registerNotify(on)
  registerWaiting(on)
  registerHolding(on)
  registerGitPoll(on)
  let project = 'SESSION'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cwd = e.cwd
    project = (cwd.replace(/\/+$/, '').split('/').pop() ?? 'session').toUpperCase()

    const refresh = async () => {
      if (!(await read($, gitOn))) {
        await update($, hud, h => ({ ...h, branch: 'git off' }))
        return
      }
      const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
      const branch = git.exitCode === 0 ? git.stdout.trim() : 'no-git'
      const sq = await $.process.run(['squeue', '--me', '-h', '-o', '%t'], { timeoutMs: 20_000 })
      if (sq.exitCode !== 0) {
        await update($, hud, () => ({ branch, running: 0, pending: 0, slurmError: sq.stderr.trim().slice(0, 60) || `exit ${sq.exitCode}` }))
        return
      }
      const states = sq.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      await update($, hud, () => ({
        branch,
        running: states.filter(s => s === 'R').length,
        pending: states.filter(s => s === 'PD').length,
      }))
    }
    const run = () => {
      refresh().catch(err => $.ui.log(`reality-plus HUD refresh failed: ${String(err)}`))
    }
    run()
    onGitResume(run)
    $.clock.every(HUD_EVERY_MS, run)

    // Session name. Current Claude Code keeps the /rename title in a sidecar file,
    // <project dir>/<session id>/custom-title.json; sessions from older versions recorded it as
    // "custom-title" rows in the transcript instead. The sidecar is read first; the transcript only
    // when a session has no sidecar (it never had one written).
    const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    let transcript: string | undefined
    let transcriptOf: string | undefined
    const refreshName = async () => {
      // /clear (a wrap-up handoff) starts a new session id with no session.start: look the transcript up again.
      const id = await $.session.id()
      if (id !== transcriptOf) {
        transcript = undefined
        transcriptOf = id
      }
      if (!transcript) {
        const found = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
        transcript = found.stdout.split('\n').find(Boolean)
        if (!transcript) {
          await update($, sessionName, () => ({ error: 'transcript not found' }))
          return
        }
      }
      const sidecar = transcript.replace(/\.jsonl$/, '/custom-title.json')
      if (await $.fs.exists(sidecar)) {
        const parsed = JSON.parse(String(await $.fs.read(sidecar))) as { customTitle?: unknown }
        if (typeof parsed.customTitle !== 'string') throw new Error(`${sidecar} has no customTitle string`)
        const name = parsed.customTitle
        await update($, sessionName, s => (s.name === name && !s.error ? s : { name }))
        return
      }
      const g = await $.process.run(['grep', '-o', '"customTitle":"\\([^"\\\\]\\|\\\\.\\)*"', transcript])
      if (g.exitCode === 1) {
        await update($, sessionName, () => ({}))
        return
      }
      if (g.exitCode !== 0) {
        await update($, sessionName, () => ({ error: g.stderr.trim().slice(0, 60) || `grep exit ${g.exitCode}` }))
        return
      }
      const last = g.stdout.trim().split('\n').pop() ?? ''
      const name = (JSON.parse(`{${last}}`) as { customTitle: string }).customTitle
      await update($, sessionName, s => (s.name === name && !s.error ? s : { name }))
    }
    const runName = () => {
      refreshName().catch(err => $.ui.log(`reality-plus session-name refresh failed: ${String(err)}`))
    }
    runName()
    $.clock.every(NAME_EVERY_MS, runName)

    // The model can change mid-session (/model), so it is re-read on the same beat.
    const runModel = () => {
      $.session
        .model()
        .then(id => update($, modelName, () => prettyModel(id)))
        .catch(err => $.ui.log(`reality-plus model read failed: ${String(err)}`))
    }
    runModel()
    $.clock.every(SESSION_EVERY_MS, runModel)

    return started
  })

  // Turn footer ("Baked for 12.4s"): hidden. The ctrl+o transcript and a footer that is
  // waiting on background agents keep the engine's line.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.waitingFor) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })


  // Goal + task progress, main conversation only.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const r = await next(e)
    const args = e.args.trim()
    if (args === 'clear') await update($, goal, g => ({ ...g, condition: undefined }))
    else if (args) await update($, goal, g => ({ ...g, condition: args }))
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !('result' in r) || r.isError) return r
    const input = e as unknown as Record<string, unknown>
    const result = r.result as Record<string, unknown> | undefined
    const record = (f: (g: Goal) => Goal) =>
      update($, goal, f).catch(err => $.ui.log(`reality-plus goal update failed: ${String(err)}`))
    if (e.tool === 'ProposeGoal' && typeof result?.condition === 'string') {
      const condition = result.condition
      void record(g => ({ ...g, condition }))
    } else if (e.tool === 'TaskCreate') {
      const task = result?.task as { id: string; subject: string } | undefined
      if (task) void record(g => ({ ...g, tasks: { ...g.tasks, [task.id]: { subject: task.subject, status: 'pending' } } }))
    } else if (e.tool === 'TaskUpdate') {
      const taskId = input.taskId as string
      const status = input.status as string | undefined
      const subject = input.subject as string | undefined
      void record(g => {
        const old = g.tasks[taskId]
        if (!old) return g
        const tasks = { ...g.tasks }
        if (status === 'deleted') delete tasks[taskId]
        else tasks[taskId] = { subject: subject ?? old.subject, status: status ?? old.status }
        return { ...g, tasks }
      })
    } else if (e.tool === 'TodoWrite') {
      const todos = (input.todos as { content: string; status: string }[]).map(t => ({ subject: t.content, status: t.status }))
      void record(g => ({ ...g, todos }))
    }
    return r
  })

  // HUD strip above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const hudState = await read($, hud)
    const model = await read($, modelName)
    const g = await read($, goal)
    const waving = await read($, waveOn)
    const phase = waving ? await read($, wavePhase) : 0
    const notice = waving ? await read($, notifyLatest) : null
    const sn = await read($, sessionName)
    const items: TaskItem[] = [...Object.values(g.tasks), ...g.todos]
    const done = items.filter(t => t.status === 'completed').length
    const active = items.find(t => t.status === 'in_progress')
    const sep = <Text color={SIGNAL}> ░ </Text>
    const showGoal = Boolean(g.condition) || items.length > 0
    const room = e.props.bodyColumns
    const strip = (
      <Box>
        <Box flexGrow={1} flexShrink={1}>
      <Text wrap="truncate-end">
        <Text color={ACCENT} bold>
          {project}
        </Text>
        {sep}
        {sn.error ? (
          <Text color="error">SESSION ✗ {sn.error}</Text>
        ) : (
          <Text bold>{sn.name ?? 'unnamed session'}</Text>
        )}
        {sep}
        <Text color={SIGNAL}>⑂ {hudState.branch}</Text>
        {sep}
        {hudState.slurmError ? (
          <Text color="error">SLURM ✗ {hudState.slurmError}</Text>
        ) : (
          <Text>
            <Text color={DIM}>SLURM </Text>
            <Text color={SIGNAL}>▶{hudState.running}</Text>
            <Text color={DIM}> ⏸{hudState.pending}</Text>
          </Text>
        )}
        {model && (
          <Text>
            {sep}
            <Text color={ACCENT}>{model}</Text>
          </Text>
        )}
      </Text>
        </Box>
        <Button
          key="tabs"
          label="TABS"
          onPress={() =>
            toggleTabs($).catch(err => {
              $.ui.log(`reality-plus TABS button failed: ${String(err)}`)
              $.ui.toast(`TABS: ${String(err)}`)
            })
          }
        />
      </Box>
    )
    const wave = waving ? waveRows(phase, e.props.bodyColumns, notice).map(row => (
          <Text>
            {row.map(seg => (
              <Text color={seg.color}>{seg.text}</Text>
            ))}
          </Text>
        )) : []
    const waitBox = await waitingBox($, e, room)
    const holdBar = await holdingBar($, e, room)
    if (!showGoal && !waving && !waitBox && !holdBar) return strip
    return (
      <Box flexDirection="column">
        {holdBar}
        {wave}
        {waitBox}
        {strip}
        {showGoal && (
        <Text wrap="truncate-end">
          <Text backgroundColor={SIGNAL} color={INK} bold>
            {' GOAL '}
          </Text>{' '}
          {g.condition ? <Text>{clip(g.condition, Math.max(20, Math.floor(room / 2)))}</Text> : <Text color={DIM}>no /goal set</Text>}
          {items.length > 0 && (
            <Text>
              {sep}
              <Text color={ACCENT}>{bar(done, items.length)}</Text>
              <Text color={DIM}> {done}/{items.length}</Text>
              {active && <Text color={HOT}> ▸ {active.subject}</Text>}
            </Text>
          )}
        </Text>
        )}
      </Box>
    )
  })
}
