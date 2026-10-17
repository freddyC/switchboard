import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Switchboard', isFocused: true, bodyColumns: 60, placement: 'dock' } as const
const HOME = 'C:\\Users\\me'
// The engine hands paths over with Windows separators, so compare them with slashes.
const slashed = (path: string) => path.replace(/\\/g, '/')

const SESSIONS: Record<string, object> = {
  'live.json': { pid: 100, sessionId: 'live', cwd: `${HOME}\\work\\workroom-abc`, startedAt: 0, name: 'live', nameSource: 'derived', status: 'idle', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-1' },
  'gone.json': { pid: 200, sessionId: 'gone', cwd: `${HOME}\\work\\old`, startedAt: 2, name: 'gone', nameSource: 'derived', status: 'idle', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-2' },
}

// A repo ending a sentence, and a github.com page that isn't a repo.
const TRANSCRIPT = [
  { type: 'ai-title', aiTitle: 'Fix the thing' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'See github.com/freddyC/centipede. Then open github.com/pulls/review-requested' }] } },
].map(entry => JSON.stringify(entry)).join('\n')

const REPOS = ['freddyC/workroom', 'freddyC/switchboard', 'freddyC/centipede']
const MANY_REPOS = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: REPOS.map(repo => `github.com/${repo}`).join(' ') }] } })

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
    // As the engine does for the 5 MB transcript fs.stat reports below.
    return { deny: `${e.path} refused: the file is over the 4194304-byte limit` }
  })
  on('fs.stat', async (_, e) => {
    statted.push(slashed(e.path))
    // Past the 4 MB the pane used to skip, which left a long session with no details.
    return { value: { kind: 'file' as const, size: 5 * 1024 * 1024, mtimeMs: 1 } }
  })
  on('fs.exists', async () => ({ value: false }))
  let tabExists = true
  const tabsAsked: string[] = []
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    let stdout = ''
    if (e.argv[0] === 'tasklist') stdout = '"claude.exe","100","Console","1","90,000 K"\r\n'
    const env = e.init?.env ?? {}
    if (e.argv[0] === 'powershell.exe' && env.SWITCHBOARD_FILE) {
      // The tail read of a big transcript: it starts mid-line, as a real tail does.
      expect(slashed(env.SWITCHBOARD_FILE)).toBe('C:/Users/me/.claude/projects/C--Users-me-work-workroom-abc/live.jsonl')
      stdout = `ut":1}\n${TRANSCRIPT}`
    }
    if (e.argv[0] === 'powershell.exe' && env.SWITCHBOARD_TABS) {
      tabsAsked.push(env.SWITCHBOARD_TABS)
      stdout = tabExists ? 'ok\r\n' : 'missing\r\n'
    }
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
    expect(await ui.find({ text: 'Fix the thing' })).toBeTruthy()
    expect(await ui.find({ text: /gone/ })).toBeFalsy()
    expect(statted).toContain('C:/Users/me/.claude/projects/C--Users-me-work-workroom-abc/live.jsonl')

    // Jump asks UI Automation for a tab titled with the session's AI title or its name.
    tabExists = true
    await ui.press({ key: 'jump-100' })
    expect(tabsAsked.at(-1)).toBe('Fix the thing\nlive')
    expect(toasts).toEqual([])
    tabExists = false
    await ui.press({ key: 'jump-100' })
    expect(toasts.at(-1)).toContain('No Windows Terminal tab found')

    await ui.press({ key: 'new-terminal' })
    expect(runs).toContainEqual(['wt.exe', '-w', '0', 'new-tab', '-d', `${HOME}\\work`, 'claude'])

    await ui.press({ key: 'new-browser' })
    expect(runs).toContainEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://github.com/pulls/review-requested'])

    expect(await ui.find({ key: 'repo-100-freddyC/centipede' })).toBeTruthy()
    expect(await ui.find({ text: /centipede\.|pulls\/review/ })).toBeFalsy()

    // Wide: the age and folder sit on the name's line.
    expect(await ui.find({ text: /^ · 0m · workroom-abc$/ })).toBeTruthy()
  }
})

test('in a narrow pane the age and folder move under the name instead of squeezing', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: HOME })
  on('fs.list', async () => ({ value: [{ name: 'live.json', kind: 'file' as const, size: 1 }] }))
  on('fs.read', async (_, e) => ({ value: slashed(e.path).endsWith('live.json') ? JSON.stringify(SESSIONS['live.json']) : MANY_REPOS }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 50, mtimeMs: 1 } }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '"claude.exe","100","Console","1","90,000 K"\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', async () => ({ value: 'self' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: {} }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    // The detail rows (indented Boxes), and which of them holds each repo's chip.
    const repoRows = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', props: { ...PANE, bodyColumns }, requestId: 'switchboard' })
      const rows = (await ui.findAll({ type: 'Box' })).filter(box => box.props.paddingLeft === 6).map(box => JSON.stringify(box.children))
      const metaMoved = Boolean(await ui.find({ text: /^0m · workroom-abc$/ })) && !(await ui.find({ text: /^ · 0m/ }))
      await ui.unmount()
      return { metaMoved, rowOf: REPOS.map(repo => rows.findIndex(row => row.includes(`repo-100-${repo}`))) }
    }

    const narrow = await repoRows(30)
    expect(narrow.metaMoved).toBe(true)
    // 24 cells of detail width: each repo wraps onto its own row instead of one squeezed row.
    expect(narrow.rowOf.every(row => row >= 0)).toBe(true)
    expect(new Set(narrow.rowOf).size).toBe(REPOS.length)

    const wide = await repoRows(80)
    expect(wide.metaMoved).toBe(false)
    expect(new Set(wide.rowOf).size).toBe(1)
  }
})
