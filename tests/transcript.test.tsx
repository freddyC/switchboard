import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Switchboard', isFocused: true, bodyColumns: 60, placement: 'dock' } as const
const SESSION = { pid: 100, sessionId: 'fresh', cwd: '/Users/me/repo', startedAt: 0, name: 'fresh-session', nameSource: 'derived', status: 'busy' }
// What Claude Code writes when a session starts or resumes, before the session has an ai-title.
const TRANSCRIPT = [
  JSON.stringify({ type: 'last-prompt', leafUuid: 'a', sessionId: 'fresh' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'look at github.com/freddyC/workroom' } }),
].join('\n')

test('a new session whose last-prompt entry has no prompt is still listed', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  on('fs.list', async () => ({ value: [{ name: 'fresh.json', kind: 'file' as const, size: 1 }] }))
  on('fs.read', async (_, e) => ({ value: e.path.endsWith('.jsonl') ? TRANSCRIPT : JSON.stringify(SESSION) }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: TRANSCRIPT.length, mtimeMs: 1 } }))
  on('session.id', async () => ({ value: 'self' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'switchboard', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'switchboard' })
  expect(await ui.find({ text: /Refresh failed/ })).toBeFalsy()
  expect(await ui.find({ text: /fresh-session/ })).toBeTruthy()
  expect(await ui.find({ key: 'repo-100-freddyC/workroom' })).toBeTruthy()
})

test('a long session keeps its title when its last ai-title is before the tail', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  const runs: string[][] = []
  on('fs.list', async () => ({ value: [{ name: 'fresh.json', kind: 'file' as const, size: 1 }] }))
  on('fs.read', async (_, e) => (e.path.endsWith('.jsonl') ? { deny: `${e.path} refused: the file is over the 4194304-byte limit` } : { value: JSON.stringify(SESSION) }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 9 * 1024 * 1024, mtimeMs: 1 } }))
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    // The tail starts mid-entry and has only tool output, no ai-title.
    const stdout = e.argv[0] === 'tail' ? `ut":1}\n${TRANSCRIPT}` : e.argv[0] === 'grep' ? `${JSON.stringify({ type: 'ai-title', aiTitle: 'Old title', sessionId: 'fresh' })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Latest title', sessionId: 'fresh' })}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: 'self' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'switchboard', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'switchboard' })
  expect(runs).toContainEqual(['grep', '-F', '"type":"ai-title"', '/Users/me/.claude/projects/-Users-me-repo/fresh.jsonl'])
  expect(await ui.find({ text: /Latest title/ })).toBeTruthy()
  expect(await ui.find({ key: 'repo-100-freddyC/workroom' })).toBeTruthy()
})

test('a renamed session shows its new name without the old title; a workroom indents its title', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  const sessions: Record<string, object> = {
    'renamed.json': { pid: 100, sessionId: 'renamed', cwd: '/Users/me/claude', startedAt: 0, name: 'video-streaming-svc', nameSource: 'user', status: 'idle' },
    'room.json': { pid: 200, sessionId: 'room', cwd: '/Users/me/claude/workroom-abc', startedAt: 0, name: 'room', nameSource: 'derived', status: 'idle' },
  }
  const titled = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'x' })
  on('fs.list', async () => ({ value: Object.keys(sessions).map(name => ({ name, kind: 'file' as const, size: 1 })) }))
  on('fs.read', async (_, e) => {
    if (e.path.endsWith('renamed.jsonl')) return { value: titled('Resolve.ai chat thread') }
    if (e.path.endsWith('room.jsonl')) return { value: titled('Fix the thing') }
    return { value: JSON.stringify(sessions[e.path.split('/').pop() ?? '']) }
  })
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 100, mtimeMs: 1 } }))
  on('session.id', async () => ({ value: 'self' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'switchboard', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'switchboard' })
  expect(await ui.find({ text: /video-streaming-svc/ })).toBeTruthy()
  expect(await ui.find({ text: /Resolve\.ai chat thread/ })).toBeFalsy()
  expect(await ui.find({ type: 'Box', props: { paddingLeft: 6 }, text: 'Fix the thing' })).toBeTruthy()
})
