export type Hud = { branch: string }
export type TaskItem = { subject: string; status: string }
export type Goal = {
  condition?: string
  tasks: Record<string, TaskItem>
  todos: TaskItem[]
}
export type SessionName = { name?: string; error?: string }
// /wrap-up card (hooks/wrapup.tsx).
export type WrapUpLine = { text: string; isKept: boolean }
export type WrapUpCard = {
  phase: 'closed' | 'reading' | 'ready' | 'working'
  token: number
  threads: WrapUpLine[]
  files: string[]
  tasks: string[]
  isFilesKept: boolean
  isTasksKept: boolean
  name?: string
  isNameKept: boolean
  isTruncated: boolean
  status?: string
  error?: string
}

// Files pane (hooks/filetree.tsx).
export type FileHunk = { oldStart: number; newStart: number; lines: string[]; cut: number; tool: string; agent: boolean }
export type FileEntry = {
  reads: number
  edits: number
  added: number
  removed: number
  hunks: FileHunk[]
  seq: number
  created?: boolean
  agent?: boolean
  unstored?: number
  dropped?: number // hunks let go under the pane's total line budget
}
export type FileLog = { files: Record<string, FileEntry>; seq: number }
export type FileView = { open?: string; showAll: boolean }
// Transcript folding (hooks/transcript.tsx): tool_use_ids (and `more:<id>` card toggles).
export type TranscriptIds = string[]
// Notes pane (hooks/notes.tsx): this session's notes, newest last, and the pane's own status.
export type Note = { id: string; at: number; text: string }
export type NotesBook = { sessionId?: string; notes: Note[]; isLoaded: boolean; editing?: string; error?: string }

// Work-panel (merged into reality-plus 2026-11-05)
export type Issue = { number: number; title: string; state: string; url: string; isPR: boolean }
export type WorktreeHealth = {
  dirty: number
  ahead: number
  behind: number
  isMerged: boolean
  age: string
}
export type Worktree = {
  path: string
  branch: string
  issue?: number
  isMain: boolean
  isPrunable: boolean
  isLocked: boolean
  health?: WorktreeHealth
  healthError?: string
}
export type Snapshot<T> = { items: T[]; error?: string; at: number; base?: string }

// Git pane (hooks/gitpanel.tsx).
export type GitPR = {
  number: number
  title: string
  branch: string
  isDraft: boolean
  review?: string
  isConflicting: boolean
  ci: 'pass' | 'fail' | 'pending' | 'none'
  closes: number[]
  author: string
  url: string
}
export type GitIssue = { number: number; title: string; labels: string[]; assignees: string[]; url: string }
export type GitBranch = {
  name: string
  upstream?: string
  track: string
  isCurrent: boolean
  isBase: boolean
  isMerged: boolean
  ahead: number
  behind: number
  age: string
  issue?: number
}
export type GitStash = { ref: string; age: string; message: string }
export type GitCommit = { sha: string; age: string; author: string; subject: string }
export type GitData = {
  at: number
  base?: string
  head?: string
  dirty?: number
  prs: GitPR[]
  issues: GitIssue[]
  branches: GitBranch[]
  stashes: GitStash[]
  commits: GitCommit[]
  commitsAll: GitCommit[]
  errors: Record<string, string>
}

// Notifications (hooks/notify.tsx): the latest event; the wave's lead ship carries its tag for one lap.
export type Notice = { id: number; text: string; tag: string; kind: 'pass' | 'fail' | 'info'; born: number }

// /waiting box (hooks/waiting.tsx): a running agent, background shell or Monitor; ended rows hold a check, then go.
export type WaitItem = {
  kind: 'agent' | 'shell' | 'monitor'
  status?: string
  label: string
  detail?: string
  startedAt: number
  endedAt?: number
  endedPhase?: number
  ok?: boolean
  // Monitor only: when its timeout runs out (ms since epoch); absent for persistent watches.
  deadline?: number
}

declare module 'claude-code' {
  interface PluginState {
    'reality-plus-noslurm': {
      'wp-issues': Shaped<Snapshot<Issue>>
      'wp-refs': Shaped<number[]>
      'wp-worktrees': Shaped<Snapshot<Worktree>>
      'wp-activity': Shaped<Record<string, string>>
      'wp-tick': number
      'git-data': Shaped<GitData>
      'git-issues-all': boolean
      'wave-on': boolean
      'notify-latest': Shaped<Notice | null>
      'wave-phase': number
      'waiting-on': boolean
      'waiting-phase': number
      'waiting-items': Shaped<Record<string, WaitItem>>
      'waiting-ended': Shaped<string[]>
      'holding-on': boolean
      'git-on': boolean
      'git-prs-all': boolean
      'git-views': Shaped<Record<string, boolean>>
      hud: Shaped<Hud>
      goal: Shaped<Goal>
      model: string
      session: Shaped<SessionName>
      'wrapup-card': Shaped<WrapUpCard>
      'files-log': Shaped<FileLog>
      'files-view': Shaped<FileView>
      'files-folded': Shaped<Record<string, true>>
      'transcript-open': Shaped<TranscriptIds>
      'transcript-live': Shaped<TranscriptIds>
      'transcript-on': Shaped<boolean>
      'notes-book': Shaped<NotesBook>
    }
  }
}
