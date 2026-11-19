import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'quarterdeck',
  component: 'Pane',
  requestId: 'files',
  props: {
    title: 'Files',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const EDIT_RESULT = {
  filePath: '/proj/hooks/a.tsx',
  oldString: 'one',
  newString: 'uno\ndos',
  originalFile: 'x\none\ny\n',
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' x', '-one', '+uno', '+dos', ' y'] }],
  userModified: false,
  replaceAll: false,
}

const bigCreate = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')

test('live Read/Edit/Write calls build the tree; folding and opening a diff work', async ($, on) => {
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') return { result: EDIT_RESULT }
    if (e.tool === 'Write')
      return { result: { type: 'create', filePath: '/proj/hooks/new.ts', content: bigCreate, structuredPatch: [], originalFile: null } }
    return { result: { type: 'text', file: { filePath: '/proj/README.md', content: 'hi', numLines: 1, startLine: 1, totalLines: 1 } } }
  })

  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/hooks/a.tsx', old_string: 'one', new_string: 'uno\ndos' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/hooks/new.ts', content: bigCreate })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /2 changed/ }))?.text).toContain('1 read')
    expect(await ui.find({ key: 'file:/proj/README.md' })).toBeTruthy()
    const edited = await ui.find({ key: 'file:/proj/hooks/a.tsx' })
    expect(edited?.text).toContain('+2')
    expect(edited?.text).toContain('−1')

    // Fold the hooks/ folder: its files leave the tree.
    await ui.press({ key: 'dir:hooks' })
    expect(await ui.find({ key: 'file:/proj/hooks/a.tsx' })).toBeFalsy()
    expect((await ui.find({ key: 'dir:hooks' }))?.text).toContain('2 files')
    await ui.press({ key: 'dir:hooks' })

    // Open the edited file: numbered hunk lines.
    await ui.press({ key: 'file:/proj/hooks/a.tsx' })
    expect(await ui.find({ type: 'Text', text: /@@ −1 \+1 @@/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /uno/ }))?.text).toMatch(/2 \+ uno/)
    expect((await ui.find({ type: 'Text', text: /one$/ }))?.text).toMatch(/2 - one/)

    // Open the created file: capped at 40 lines with a "more" toggle.
    await ui.press({ key: 'file:/proj/hooks/new.ts' })
    expect(await ui.find({ type: 'Text', text: /line 40$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /line 41$/ })).toBeFalsy()
    expect((await ui.find({ key: 'files-more' }))?.text).toContain('20 more lines')
    await ui.press({ key: 'files-more' })
    expect(await ui.find({ type: 'Text', text: /line 60$/ })).toBeTruthy()
    await ui.press({ key: 'files-more' })

    await ui.press({ key: 'files-close' })
    expect(await ui.find({ key: 'files-close' })).toBeFalsy()
    await ui.unmount()
  }
})

test('a resumed session is seeded from the transcript, subagent files marked', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('session.messages', (_, e) => {
    if (e.agentId === 'ag1')
      return {
        value: [
          {
            role: 'assistant',
            text: '',
            toolUses: [{ tool_use_id: 's1', tool: 'Edit', input: { file_path: '/proj/sub/b.py', old_string: 'a', new_string: 'b' } }],
          },
        ],
      }
    return {
      value: [
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { tool_use_id: 't1', tool: 'Edit', input: { file_path: '/proj/hooks/a.tsx' }, result: EDIT_RESULT },
            { tool_use_id: 't2', tool: 'Agent', input: {}, agentId: 'ag1' },
          ],
        },
      ],
    }
  })

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let sub = await ui.find({ key: 'file:/proj/sub/b.py' })
  for (let i = 0; i < 20 && !sub; i++) {
    await Promise.resolve()
    sub = await ui.find({ key: 'file:/proj/sub/b.py' })
  }
  expect(logged.filter(l => l.includes('files'))).toEqual([])
  expect(sub?.text).toContain('subagent')
  expect((await ui.find({ key: 'file:/proj/hooks/a.tsx' }))?.text).toContain('+2')
  await ui.press({ key: 'file:/proj/sub/b.py' })
  expect(await ui.find({ type: 'Text', text: /without a stored diff/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not numbered/ })).toBeTruthy()
  await ui.unmount()
})
