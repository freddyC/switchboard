import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

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
// github.com paths whose first part is a GitHub page, not an owner (github.com/pulls/review-requested).
const NOT_OWNERS = new Set(['pulls', 'issues', 'orgs', 'settings', 'notifications', 'login', 'search', 'marketplace', 'features', 'sponsors', 'topics', 'apps'])
const REPO = /github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[/\s"')#?]|$)|--repo[ =]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/g

type Chip = { width: number; node: RenderElement }

const GAP = '   '
const DETAIL_INDENT = 6
const isWide = (code: number) => code >= 0x1f000 || (code >= 0xff01 && code <= 0xff60)
const cells = (text: string) => [...text].reduce((width, char) => width + (isWide(char.codePointAt(0) ?? 0) ? 2 : 1), 0)
// A terminal Button draws as "[ label ]"; a hotkeyed one adds "n: " before the label.
const BUTTON_FRAME = 4

const flow = (chips: Chip[], width: number, gap = GAP) => {
  const rows: Chip[][] = []
  let used = 0
  for (const chip of chips) {
    const last = rows.at(-1)
    if (last && used + gap.length + chip.width <= width) {
      last.push(chip)
      used += gap.length + chip.width
    } else {
      rows.push([chip])
      used = chip.width
    }
  }
  return rows
}

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
        for (const match of text.matchAll(REPO)) {
          // A repo at the end of a sentence ("see freddyC/centipede.") keeps the period otherwise.
          const repo = (match[1] ?? match[2]).replace(/\.+$/, '')
          if (!NOT_OWNERS.has(repo.split('/')[0])) tally(repos, repo)
        }
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
let paneTitle = ''

async function retitle($: EngineInterface, count: number) {
  const title = `Switchboard (${count})`
  if (title === paneTitle) return
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isOpen) return
  paneTitle = title
  await $.ui.open({ id: PANE, title })
}

// Windows sets USERPROFILE rather than HOME, and has no ps, osascript, open or sh.
const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

const homeDir = async ($: EngineInterface) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

// Claude names a project's transcript folder after its cwd with every non-alphanumeric
// character turned into a dash: /Users/me/repo -> -Users-me-repo, C:\Users\me -> C--Users-me.
const projectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const pathParts = (path: string) => path.split(/[\\/]/)

// A Windows session's messagingSocketPath is a named pipe, which the fs calls can't see,
// so liveness there is the session's pid in one tasklist snapshot.
async function livePids($: EngineInterface) {
  const { stdout } = await $.process.run(['tasklist', '/FO', 'CSV', '/NH'])
  return new Set([...stdout.matchAll(/^"[^"]*","(\d+)"/gm)].map(match => Number(match[1])))
}

async function refresh($: EngineInterface, settings: Settings) {
  const home = await homeDir($)
  const self = await $.session.id()
  const dir = `${home}/.claude/sessions`
  const files = (await $.fs.list(dir)).filter(entry => entry.name.endsWith('.json'))
  const rows: Peer[] = []
  const alive = (await isWindows($)) ? await livePids($) : undefined

  for (const file of files) {
    const session: SessionFile = JSON.parse(await $.fs.read(`${dir}/${file.name}`).catch(() => '{}'))
    if (!session.sessionId) continue
    if (alive) {
      if (!alive.has(session.pid)) continue
    } else if (session.messagingSocketPath && !(await $.fs.exists(session.messagingSocketPath))) continue

    const transcriptPath = `${home}/.claude/projects/${projectDir(session.cwd)}/${session.sessionId}.jsonl`
    const stat = await $.fs.stat(transcriptPath).catch(() => undefined)
    let summary = summaries.get(session.sessionId)
    if (stat && stat.size < 4 * 1024 * 1024 && summary?.mtimeMs !== stat.mtimeMs) {
      summary = { mtimeMs: stat.mtimeMs, ...summarize(await $.fs.read(transcriptPath)) }
      summaries.set(session.sessionId, summary)
    }

    const title = summary && summary.title !== NO_TITLE ? summary.title : ''
    const isNamedByUser = session.nameSource !== 'derived'
    const workroom = settings.workroomNames ? pathParts(session.cwd).find(part => part.startsWith('workroom-')) : undefined
    const name = workroom ? workroom.slice('workroom-'.length) : isNamedByUser || !title ? session.name : clip(title, settings.titleLength)
    rows.push({
      pid: session.pid,
      isSelf: session.sessionId === self,
      name,
      isWorkroom: workroom !== undefined,
      status: session.status,
      waitingFor: session.waitingFor,
      startedAt: session.startedAt,
      folder: pathParts(session.cwd).pop() ?? session.cwd,
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
  await retitle($, rows.length)
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
  if (await isWindows($)) return $.ui.toast(`Jumping to a tab isn't supported on Windows; ${peer.name} is in ${peer.folder}`)
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
  if (await isWindows($)) {
    // -w 0 opens the tab in the most recent Windows Terminal window.
    const opened = await $.process.run(['wt.exe', '-w', '0', 'new-tab', '-d', await $.session.cwd(), 'claude'])
    if (opened.exitCode !== 0) $.ui.toast(`Could not open Windows Terminal: ${opened.stderr.trim()}`)
    return
  }
  const { stdout } = await $.process.run(['pwd'])
  const script = NEW_TAB.flatMap(line => ['-e', line])
  const opened = await $.process.run(['osascript', ...script, stdout.trim(), await ownTty($)])
  if (opened.stdout.trim() === 'window') {
    $.ui.toast('Opened a window: allow Terminal in System Settings › Privacy & Security › Accessibility to get tabs')
  }
}

async function openBrowser($: EngineInterface, url: string) {
  if (await isWindows($)) return openUrl($, url)
  const found = await $.process.run(['sh', '-lc', 'command -v terminal-browser'])
  const terminalBrowser = found.stdout.trim()
  if (found.exitCode === 0 && terminalBrowser) {
    const opened = await $.process.run(['open', '-na', 'Ghostty', '--args', '-e', terminalBrowser, 'open', url])
    if (opened.exitCode === 0) return
  }
  const opened = await $.process.run(['open', url])
  if (opened.exitCode !== 0) $.ui.toast(`Could not open the browser: ${opened.stderr.trim()}`)
}

async function openUrl($: EngineInterface, url: string) {
  // rundll32 hands the URL to the default browser without a shell to quote for.
  if (await isWindows($)) await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url])
  else await $.process.run(['open', url])
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'switchboard', description: 'Show your Claude sessions in the Switchboard pane' })
    void $.ui.open({ id: PANE, title: paneTitle || 'Switchboard' })
    const tick = () =>
      refresh($, settings)
        .then(() => update($, failure, () => ''))
        .catch(error => update($, failure, () => String(error)))
    void tick()
    $.clock.every(settings.refreshSeconds * 1000, () => void tick())

    return next(e)
  })

  on('command.run', { command: 'switchboard' }, async $ => {
    await $.ui.open({ id: PANE, title: paneTitle || 'Switchboard' })

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

    const lay = (chips: Chip[], indent = 0) =>
      flow(chips, e.props.bodyColumns - indent).map(row => <Box paddingLeft={indent}>{row.flatMap((chip, i) => (i === 0 ? [chip.node] : [<Text>{GAP}</Text>, chip.node]))}</Box>)

    const details = (peer: Peer): Chip[] => {
      const chips: Chip[] = []
      if (settings.showContext && peer.tokens !== undefined) {
        const percent = (peer.tokens / size) * 100
        const bar = meter(percent, GLYPHS)
        const label = ` ${Math.round(percent)}% · ${Math.round(peer.tokens / 1000)}k / ${Math.round(size / 1000)}k`
        chips.push({
          width: cells(bar + label),
          node: (
            <Text>
              <Text color={contextColor(percent)}>{bar}</Text>
              <Text dimColor>{label}</Text>
            </Text>
          ),
        })
      }
      if (settings.showPr && peer.pr) chips.push({ width: cells(`⎇ ${peer.pr}`), node: <Text dimColor>⎇ {peer.pr}</Text> })
      if (settings.showRepos && peer.repos.length > 0) {
        chips.push({
          width: cells(`📦 ${peer.repos.join(' ')}`),
          node: (
            <Box>
              <Text dimColor>📦 </Text>
              {peer.repos.map((repo, i) => (
                <Button key={`repo-${peer.pid}-${repo}`} label={i === 0 ? repo : ` ${repo}`} plain dimColor onPress={() => openUrl($, `https://github.com/${repo}`)} />
              ))}
            </Box>
          ),
        })
      }
      if (settings.showTickets && peer.tickets.length > 0) {
        chips.push({
          width: cells(`🎫 ${peer.tickets.join(' ')}`),
          node: (
            <Box>
              <Text dimColor>🎫 </Text>
              {peer.tickets.map((ticket, i) => {
                const label = i === 0 ? ticket : ` ${ticket}`
                return settings.ticketUrl ? (
                  <Button key={`ticket-${peer.pid}-${ticket}`} label={label} plain dimColor onPress={() => openUrl($, `${settings.ticketUrl}${ticket}`)} />
                ) : (
                  <Text key={`ticket-${peer.pid}-${ticket}`} dimColor>{label}</Text>
                )
              })}
            </Box>
          ),
        })
      }
      return chips
    }

    const button = (key: string, label: string, onPress: () => unknown, hotkey: string): Chip => ({
      width: cells(label) + BUTTON_FRAME,
      node: <Button key={key} label={label} hotkey={hotkey} onPress={onPress} />,
    })
    const toolbar = [
      button('new-terminal', '＋ New terminal', () => openTerminal($), 'n'),
      button('new-browser', '＋ New browser', () => openBrowser($, settings.browserHome), 'b'),
      button('mute', settings.chime ? '🔔' : '🔕', () => save($, 'chime', !settings.chime), 'm'),
      button('configure', isConfiguring ? '✓ Done' : '⚙ Configure', () => update($, configuring, open => !open), 'c'),
    ]

    return (
      <Box flexDirection="column">
        {/* The toolbar flows onto a second row in a narrow pane rather than splitting a button. */}
        <Box flexDirection="column" marginBottom={1}>
          {flow(toolbar, e.props.bodyColumns, ' ').map(row => (
            <Box>{row.flatMap((chip, i) => (i === 0 ? [chip.node] : [<Text> </Text>, chip.node]))}</Box>
          ))}
        </Box>
        {isConfiguring && (
          <Box flexDirection="column">
            {lay(
              TOGGLES.map(([key, label]) => {
                const text = `${settings[key] ? '✅' : '⬜'} ${label}`
                return { width: cells(text), node: <Button key={`toggle-${key}`} label={text} plain onPress={() => save($, key, !settings[key])} /> }
              }),
            )}
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
        {!isConfiguring && list.map((peer, index) => {
          // The arrow and dot take 5 cells. The name is clipped to what's left, and the age and
          // folder stay on its line only when they fit; otherwise they lead the details row, so
          // a narrow pane never squeezes them into a column a character or two wide.
          const number = `${index + 1}: `
          const you = peer.isSelf ? ' (you)' : ''
          const waiting = peer.status === 'waiting' ? ` ${peer.waitingFor ?? 'needs you'}` : ''
          const meta = `${age(now - peer.startedAt)} · ${peer.folder}`
          const room = e.props.bodyColumns - 5
          const name = clip(peer.isWorkroom ? `📁 ${peer.name}` : peer.name, Math.max(8, room - number.length - you.length))
          const isMetaInline = number.length + cells(name) + you.length + cells(waiting) + cells(` · ${meta}`) <= room
          const metaChip: Chip = { width: cells(meta), node: <Text dimColor>{meta}</Text> }
          return (
            <Box flexDirection="column">
              <Text color={peer.isSelf ? 'claude' : 'subtle'}>{'━'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
              <Box>
                <Box flexShrink={0}>
                  <Text color="claude">{peer.isSelf ? '▶ ' : '  '}</Text>
                  <Text>{DOT[peer.status] ?? '⚪'} </Text>
                </Box>
                {peer.isSelf ? (
                  <Text bold color="claude">
                    {number}{name} <Text dimColor>(you)</Text>
                  </Text>
                ) : (
                  <Button
                    key={`jump-${peer.pid}`}
                    label={name}
                    hotkey={index < 9 ? String(index + 1) : undefined}
                    plain
                    onPress={() => jump($, peer)}
                  />
                )}
                {waiting && <Text color="red">{waiting}</Text>}
                {isMetaInline && <Text dimColor> · {meta}</Text>}
              </Box>
              {peer.title && <Text>{peer.title}</Text>}
              {lay(isMetaInline ? details(peer) : [metaChip, ...details(peer)], DETAIL_INDENT)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
