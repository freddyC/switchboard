import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Peer, Settings } from '../types'

const PANE = 'switchboard'
const peers = atom({ plugin: 'switchboard', key: 'peers' } as const, [])
const window = atom({ plugin: 'switchboard', key: 'window' } as const, 200_000)
const failure = atom({ plugin: 'switchboard', key: 'error' } as const, '')
const configuring = atom({ plugin: 'switchboard', key: 'configuring' } as const, false)
const configError = atom({ plugin: 'switchboard', key: 'configError' } as const, '')

const DEFAULTS: Settings = {
  chime: true,
  sound: 'chime',
  showContext: true,
  showRepos: true,
  showTickets: true,
  showPr: true,
  workroomNames: true,
  ticketUrl: '',
  browserHome: 'https://github.com/pulls/review-requested',
  titleLength: 48,
  refreshSeconds: 5,
}

type Toggle = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]
type Field = Exclude<keyof Settings, Toggle | 'sound'>

const SOUNDS = ['chime', 'bell', 'marimba', 'pop']
const play = ($: EngineInterface, sound: string) => $.audio.play({ asset: `sounds/${sound}.wav` }).catch(() => {})

const TOGGLES: [Toggle, string][] = [
  ['chime', 'Chime when a session finishes'],
  ['showContext', 'Context meter'],
  ['showRepos', 'Repos'],
  ['showTickets', 'Tickets'],
  ['showPr', 'Pull request'],
  ['workroomNames', 'Name sessions after their workroom'],
]

const FIELDS: [Field, string, string][] = [
  ['ticketUrl', 'Ticket URL prefix', 'https://yourcompany.atlassian.net/browse/'],
  ['browserHome', 'Browser home page', DEFAULTS.browserHome],
  ['titleLength', 'Name length', String(DEFAULTS.titleLength)],
  ['refreshSeconds', 'Refresh every (seconds)', String(DEFAULTS.refreshSeconds)],
]

const readSettings = (options: PluginOptions) => {
  const settings = Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => [key, typeof options[key] === typeof fallback ? options[key] : fallback]),
  ) as Settings
  return SOUNDS.includes(settings.sound) ? settings : { ...settings, sound: DEFAULTS.sound }
}

async function save($: EngineInterface, key: keyof Settings, raw: string | boolean) {
  const value = typeof DEFAULTS[key] === 'number' ? Number(raw) : typeof raw === 'string' ? raw.trim() : raw
  if (typeof value === 'number' && !(value > 0)) return update($, configError, () => `${key} must be a number above 0`)
  const result = await $.config.set({ key: `switchboard.${key}`, value })
  await update($, configError, () => ('deny' in result ? String(result.deny) : ''))
}

type SessionFile = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  name: string
  nameSource?: string
  status: string
  waitingFor?: string
  messagingSocketPath?: string
}

const DOT: Record<string, string> = { waiting: '🔴', busy: '🟡', idle: '🟢' }
const NO_TITLE = '(no title yet)'
const GLYPHS = { full: '▰', empty: '▱' }

const meter = (percent: number, glyphs: { full: string; empty: string }) => {
  const filled = Math.min(8, Math.round(percent / 12.5))

  return glyphs.full.repeat(filled) + glyphs.empty.repeat(8 - filled)
}

const contextColor = (percent: number) => (percent >= 80 ? 'red' : percent >= 60 ? 'yellow' : 'green')

type Summary = { mtimeMs: number; title: string; pr?: string; tokens?: number; repos: string[]; tickets: string[] }

const TICKET = /\b[A-Z]{2,10}-\d{1,6}\b/g
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'GPT', 'AES', 'TLS', 'HTTP', 'UTC', 'GMT'])
const REPO = /github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[/\s"')#?]|$)|--repo[ =]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/g

const tally = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
const top = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key]) => key)

const textsOf = (entry: { type: string; message?: { content?: unknown } }) => {
  const content = entry.message?.content
  if (typeof content === 'string') return entry.type === 'user' ? [content] : []
  if (!Array.isArray(content)) return []

  return content.flatMap(block =>
    block.type === 'text' ? [block.text] : block.type === 'tool_use' ? [JSON.stringify(block.input)] : [],
  )
}

const age = (ms: number) => {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

const summarize = (transcript: string): Omit<Summary, 'mtimeMs'> => {
  let title = ''
  let prompt = ''
  let pr: string | undefined
  let tokens: number | undefined
  const repos = new Map<string, number>()
  const tickets = new Map<string, number>()
  for (const line of transcript.split('\n')) {
    if (line.includes('"isSidechain":true')) continue
    const isMessage = line.includes('"type":"assistant"') || line.includes('"type":"user"')
    if (!isMessage && !line.includes('"type":"ai-title"') && !line.includes('"type":"last-prompt"') && !line.includes('"type":"pr-link"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'ai-title') title = entry.aiTitle
      if (entry.type === 'last-prompt') prompt = entry.lastPrompt
      if (entry.type === 'pr-link') {
        pr = `${entry.prRepository}#${entry.prNumber}`
        tally(repos, entry.prRepository)
      }
      for (const text of textsOf(entry)) {
        for (const [ticket] of text.matchAll(TICKET)) if (!NOT_TICKETS.has(ticket.split('-')[0])) tally(tickets, ticket)
        for (const match of text.matchAll(REPO)) tally(repos, match[1] ?? match[2])
      }
      const usage = entry.type === 'assistant' ? entry.message?.usage : undefined
      if (usage) tokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    } catch {}
  }

  return { title: title || prompt.slice(0, 80) || NO_TITLE, pr, tokens, repos: top(repos), tickets: top(tickets) }
}

const summaries = new Map<string, Summary>()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const lastStatus = new Map<number, string>()

const homeDir = async ($: EngineInterface) => (await $.env.get('HOME')) ?? ''

async function refresh($: EngineInterface, settings: Settings) {
  const home = await homeDir($)
  const self = await $.session.id()
  const dir = `${home}/.claude/sessions`
  const files = (await $.fs.list(dir)).filter(entry => entry.name.endsWith('.json'))
  const rows: Peer[] = []

  for (const file of files) {
    const session: SessionFile = JSON.parse(await $.fs.read(`${dir}/${file.name}`).catch(() => '{}'))
    if (!session.sessionId) continue
    if (session.messagingSocketPath && !(await $.fs.exists(session.messagingSocketPath))) continue

    const transcriptPath = `${home}/.claude/projects/${session.cwd.replace(/[/.]/g, '-')}/${session.sessionId}.jsonl`
    const stat = await $.fs.stat(transcriptPath).catch(() => undefined)
    let summary = summaries.get(session.sessionId)
    if (stat && stat.size < 4 * 1024 * 1024 && summary?.mtimeMs !== stat.mtimeMs) {
      summary = { mtimeMs: stat.mtimeMs, ...summarize(await $.fs.read(transcriptPath)) }
      summaries.set(session.sessionId, summary)
    }

    const title = summary && summary.title !== NO_TITLE ? summary.title : ''
    const isNamedByUser = session.nameSource !== 'derived'
    const workroom = settings.workroomNames ? session.cwd.split('/').find(part => part.startsWith('workroom-')) : undefined
    const name = workroom ? workroom.slice('workroom-'.length) : isNamedByUser || !title ? session.name : clip(title, settings.titleLength)
    rows.push({
      pid: session.pid,
      isSelf: session.sessionId === self,
      name,
      isWorkroom: workroom !== undefined,
      status: session.status,
      waitingFor: session.waitingFor,
      startedAt: session.startedAt,
      folder: session.cwd.split('/').pop() ?? session.cwd,
      title: workroom || isNamedByUser ? title : '',
      pr: summary?.pr,
      tokens: summary?.tokens,
      repos: summary?.repos ?? [],
      tickets: summary?.tickets ?? [],
    })
  }

  const size = (await $.session.usage()).context.window
  if (size) await update($, window, previous => (previous === size ? previous : size))

  rows.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)

  const isBellOwner = rows[0]?.isSelf === true
  const finished = rows.filter(row => !row.isSelf && lastStatus.get(row.pid) === 'busy' && row.status === 'idle')
  lastStatus.clear()
  for (const row of rows) lastStatus.set(row.pid, row.status)
  if (settings.chime && isBellOwner && finished.length > 0) void play($, settings.sound)
  await update($, peers, previous => (JSON.stringify(previous) === JSON.stringify(rows) ? previous : rows))
}

const SELECT_TAB = [
  'on run argv',
  'tell application "Terminal"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'if tty of t is item 1 of argv then',
  'set selected of t to true',
  'set index of w to 1',
  'activate',
  'return "ok"',
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'return "missing"',
  'end run',
]

async function jump($: EngineInterface, peer: Peer) {
  const ps = await $.process.run(['ps', '-o', 'tty=', '-p', String(peer.pid)])
  const tty = ps.stdout.trim()
  if (!tty || tty === '??') return $.ui.toast(`${peer.name} has no terminal tab`)

  const script = SELECT_TAB.flatMap(line => ['-e', line])
  const found = await $.process.run(['osascript', ...script, `/dev/${tty}`])
  if (found.stdout.trim() !== 'ok') $.ui.toast(`No Terminal tab found for ${peer.name}`)
}

const NEW_TAB = [
  'on run argv',
  'set command to "cd " & quoted form of item 1 of argv & " && claude"',
  'tell application "Terminal"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'if tty of t is item 2 of argv then set index of w to 1',
  'end repeat',
  'end repeat',
  'activate',
  'end tell',
  'try',
  'tell application "System Events" to keystroke "t" using command down',
  'on error',
  'tell application "Terminal" to do script command',
  'return "window"',
  'end try',
  'delay 0.3',
  'tell application "Terminal" to do script command in selected tab of front window',
  'return "tab"',
  'end run',
]

async function ownTty($: EngineInterface) {
  const self = await $.session.id()
  const dir = `${await homeDir($)}/.claude/sessions`
  for (const file of await $.fs.list(dir)) {
    const session: SessionFile = JSON.parse(await $.fs.read(`${dir}/${file.name}`).catch(() => '{}'))
    if (session.sessionId !== self) continue
    const ps = await $.process.run(['ps', '-o', 'tty=', '-p', String(session.pid)])
    return `/dev/${ps.stdout.trim()}`
  }
  return ''
}

async function openTerminal($: EngineInterface) {
  const { stdout } = await $.process.run(['pwd'])
  const script = NEW_TAB.flatMap(line => ['-e', line])
  const opened = await $.process.run(['osascript', ...script, stdout.trim(), await ownTty($)])
  if (opened.stdout.trim() === 'window') {
    $.ui.toast('Opened a window: allow Terminal in System Settings › Privacy & Security › Accessibility to get tabs')
  }
}

async function openBrowser($: EngineInterface, url: string) {
  const home = await homeDir($)
  const opened = await $.process.run([
    'open', '-na', `${home}/Applications/Ghostty.app`,
    '--args', '-e', '/opt/homebrew/bin/terminal-browser', 'open', url,
  ])
  if (opened.exitCode !== 0) $.ui.toast(`Could not open the browser: ${opened.stderr.trim()}`)
}

async function openUrl($: EngineInterface, url: string) {
  await $.process.run(['open', url])
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'switchboard', description: 'Show your Claude sessions in the Switchboard pane' })
    void $.ui.open({ id: PANE, title: 'Switchboard' })
    const tick = () =>
      refresh($, settings)
        .then(() => update($, failure, () => ''))
        .catch(error => update($, failure, () => String(error)))
    void tick()
    $.clock.every(settings.refreshSeconds * 1000, () => void tick())

    return next(e)
  })

  on('command.run', { command: 'switchboard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Switchboard' })

    return { text: 'Switchboard opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const list = await read($, peers)
    const isConfiguring = await read($, configuring)
    const settingsError = await read($, configError)
    const size = await read($, window)
    const now = await $.clock.now()
    const error = await read($, failure)

    return (
      <Box flexDirection="column">
        <Text bold>
          Switchboard <Text dimColor>({list.length})</Text>
        </Text>
        <Box marginBottom={1}>
          <Button key="new-terminal" label="＋ New terminal" hotkey="n" onPress={() => openTerminal($)} />
          <Text> </Text>
          <Button key="new-browser" label="＋ New browser" hotkey="b" onPress={() => openBrowser($, settings.browserHome)} />
          <Text> </Text>
          <Button key="mute" label={settings.chime ? '🔔' : '🔕'} hotkey="m" onPress={() => save($, 'chime', !settings.chime)} />
          <Text> </Text>
          <Button
            key="configure"
            label={isConfiguring ? '✓ Done' : '⚙ Configure'}
            hotkey="c"
            onPress={() => update($, configuring, open => !open)}
          />
        </Box>
        {isConfiguring && (
          <Box flexDirection="column">
            {TOGGLES.map(([key, label]) => (
              <Button key={`toggle-${key}`} label={`${settings[key] ? '✅' : '⬜'} ${label}`} plain onPress={() => save($, key, !settings[key])} />
            ))}
            <Box>
              <Text>Sound: </Text>
              {SOUNDS.map(sound => (
                <Button
                  key={`sound-${sound}`}
                  label={`${sound === settings.sound ? '🔊' : '🔈'} ${sound} `}
                  plain
                  dimColor={sound !== settings.sound}
                  onPress={() => Promise.all([play($, sound), save($, 'sound', sound)])}
                />
              ))}
            </Box>
            {FIELDS.map(([key, label, placeholder]) => (
              <Input key={`field-${key}`} label={`${label}: `} value={String(settings[key])} placeholder={placeholder} submitLabel="save" onSubmit={value => save($, key, value)} />
            ))}
            {settingsError && <Text color="red">{settingsError}</Text>}
            <Text dimColor>Press Enter in a field to save it.</Text>
          </Box>
        )}
        {!isConfiguring && error && <Text color="red">Refresh failed: {error}</Text>}
        {!isConfiguring && list.length <= 1 && !error && <Text dimColor>No other sessions running.</Text>}
        {!isConfiguring && list.map((peer, index) => (
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="claude">{peer.isSelf ? '▶ ' : '  '}</Text>
              <Text>{DOT[peer.status] ?? '⚪'} </Text>
              {peer.isSelf ? (
                <Text bold color="claude">
                  {index + 1}: {peer.isWorkroom ? '📁 ' : ''}{peer.name} <Text dimColor>(you)</Text>
                </Text>
              ) : (
                <Button
                  key={`jump-${peer.pid}`}
                  label={peer.isWorkroom ? `📁 ${peer.name}` : peer.name}
                  hotkey={index < 9 ? String(index + 1) : undefined}
                  plain
                  onPress={() => jump($, peer)}
                />
              )}
              {peer.status === 'waiting' && <Text color="red"> {peer.waitingFor ?? 'needs you'}</Text>}
              <Text dimColor>
                {' '}· {age(now - peer.startedAt)} · {peer.folder}
              </Text>
            </Box>
            {peer.title && <Text>{peer.title}</Text>}
            {settings.showContext && peer.tokens !== undefined && (
              <Text>
                <Text color={contextColor((peer.tokens / size) * 100)}>
                  {meter((peer.tokens / size) * 100, GLYPHS)}
                </Text>
                <Text dimColor>
                  {' '}{Math.round((peer.tokens / size) * 100)}% · {Math.round(peer.tokens / 1000)}k / {Math.round(size / 1000)}k
                </Text>
              </Text>
            )}
            {settings.showPr && peer.pr && <Text dimColor>⎇ {peer.pr}</Text>}
            {settings.showRepos && peer.repos.length > 0 && (
              <Box>
                <Text dimColor>📦 </Text>
                {peer.repos.map(repo => (
                  <Button key={`repo-${peer.pid}-${repo}`} label={`${repo} `} plain dimColor onPress={() => openUrl($, `https://github.com/${repo}`)} />
                ))}
              </Box>
            )}
            {settings.showTickets && peer.tickets.length > 0 && (
              <Box>
                <Text dimColor>🎫 </Text>
                {peer.tickets.map(ticket =>
                  settings.ticketUrl ? (
                    <Button key={`ticket-${peer.pid}-${ticket}`} label={`${ticket} `} plain dimColor onPress={() => openUrl($, `${settings.ticketUrl}${ticket}`)} />
                  ) : (
                    <Text key={`ticket-${peer.pid}-${ticket}`} dimColor>{`${ticket} `}</Text>
                  ),
                )}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
