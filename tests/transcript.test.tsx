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
