import type { test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Out = { exitCode: number; stdout: string; stderr: string }
type Run = (_: unknown, e: { argv: readonly string[] }) => { value: Out & { isStdoutTruncated: boolean; isStderrTruncated: boolean } }

// A machine's worth of file system for the shared polls (sharedpoll.ts): HOME, the result files, and
// the mkdir (lock), mv and rm commands act on `files`/`dirs`; every other command goes to `run`.
export const withSharedFs = (on: On, run: Run) => {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const done = (exitCode = 0, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('env.get', () => ({ value: '/h' }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: Date.now(), isLink: false } }))
  on('process.run', (_, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'mkdir' && args[0] === '-p') return done()
    if (cmd === 'mkdir') {
      if (dirs.has(args[0])) return done(1, 'File exists')
      dirs.add(args[0])
      return done()
    }
    if (cmd === 'mv') {
      files.set(args[2], files.get(args[1]) ?? '')
      files.delete(args[1])
      return done()
    }
    if (cmd === 'rm') {
      dirs.delete(args[1])
      return done()
    }
    return run(_, e)
  })
  return { files, dirs }
}

// The shared file system plus squeue (from `squeue`) and every other command succeeding with no
// output (git prints a branch); `calls` lists each command run.
export const fakeHost = (on: On, squeue: () => Out) => {
  const calls: string[] = []
  const host = withSharedFs(on, (_, e) => {
    calls.push(e.argv[0])
    const out = e.argv[0] === 'squeue' ? squeue() : { exitCode: 0, stdout: e.argv[0] === 'git' ? 'main\n' : '', stderr: '' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ...host, calls }
}
