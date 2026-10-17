import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Switchboard', isFocused: true, bodyColumns: 60, placement: 'dock' } as const
const HOME = 'C:\\Users\\me'
// The engine hands paths over with Windows separators, so compare them with slashes.
const slashed = (path: string) => path.replace(/\\/g, '/')

const SESSIONS: Record<string, object> = {
  'live.json': { pid: 100, sessionId: 'live', cwd: `${HOME}\\work\\workroom-abc`, startedAt: 1, name: 'live', nameSource: 'derived', status: 'idle', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-1' },
  'gone.json': { pid: 200, sessionId: 'gone', cwd: `${HOME}\\work\\old`, startedAt: 2, name: 'gone', nameSource: 'derived', status: 'idle', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-2' },
}

test('on Windows it reads USERPROFILE, checks pids with tasklist, and opens wt and the default browser', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: HOME })
  const runs: string[][] = []
  const statted: string[] = []
  const toasts: string[] = []

  on('fs.list', async (_, e) => (slashed(e.path) === 'C:/Users/me/.claude/sessions' ? { value: Object.keys(SESSIONS).map(name => ({ name, kind: 'file' as const, size: 1 })) } : { deny: `ENOENT ${e.path}` }))
  on('fs.read', async (_, e) => {
    const session = SESSIONS[slashed(e.path).split('/').pop() ?? '']
    if (session) return { value: JSON.stringify(session) }
    return { value: '{"type":"ai-title","aiTitle":"Fix the thing"}\n' }
  })
  on('fs.stat', async (_, e) => {
    statted.push(slashed(e.path))
    return { value: { kind: 'file' as const, size: 50, mtimeMs: 1 } }
  })
  on('fs.exists', async () => ({ value: false }))
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'tasklist' ? '"claude.exe","100","Console","1","90,000 K"\r\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: 'self' }))
  on('session.cwd', async () => ({ value: `${HOME}\\work` }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  // The kit doesn't start a session by itself, and nothing beneath the plugin answers these.
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: `${HOME}\\work`, surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    runs.length = 0
    toasts.length = 0
    const ui = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', props: PANE, requestId: 'switchboard' })

    expect(await ui.find({ text: /abc/ })).toBeTruthy()
    expect(await ui.find({ text: /gone/ })).toBeFalsy()
    expect(statted).toContain('C:/Users/me/.claude/projects/C--Users-me-work-workroom-abc/live.jsonl')

    await ui.press({ key: 'jump-100' })
    expect(toasts.at(-1)).toContain("isn't supported on Windows")

    await ui.press({ key: 'new-terminal' })
    expect(runs).toContainEqual(['wt.exe', '-w', '0', 'new-tab', '-d', `${HOME}\\work`, 'claude'])

    await ui.press({ key: 'new-browser' })
    expect(runs).toContainEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://github.com/pulls/review-requested'])
  }
})
