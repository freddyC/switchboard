import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Switchboard', isFocused: true, bodyColumns: 60, placement: 'dock' } as const
// The mark beside a finished session's name (the mute button's 🔔 is a Button, not a Text).
const BELL = { type: 'Text', text: /^🔔 $/ }

test('a session that finished shows a bell until you jump to it or it goes busy again', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  let status = 'busy'
  on('fs.list', async () => ({ value: [{ name: 'peer.json', kind: 'file' as const, size: 1 }] }))
  on('fs.read', async () => ({ value: JSON.stringify({ pid: 100, sessionId: 'peer', cwd: '/Users/me/repo', startedAt: 0, name: 'peer', status }) }))
  on('fs.stat', async () => ({ deny: 'ENOENT' }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('audio.play', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'self' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/Users/me', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'switchboard', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'switchboard' })
  expect(await ui.find(BELL)).toBeFalsy()

  status = 'idle'
  await clock.advance(5000)
  expect(await ui.find(BELL)).toBeTruthy()

  await ui.press({ key: 'jump-100' })
  expect(await ui.find(BELL)).toBeFalsy()

  // Finishing again marks it again; typing in it (busy) clears the mark without a jump.
  status = 'busy'
  await clock.advance(5000)
  status = 'idle'
  await clock.advance(5000)
  expect(await ui.find(BELL)).toBeTruthy()
  status = 'busy'
  await clock.advance(5000)
  expect(await ui.find(BELL)).toBeFalsy()
})
