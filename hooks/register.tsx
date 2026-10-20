import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

import type { Peer, Settings } from '../types'

const PANE = 'switchboard'
const peers = atom({ plugin: 'switchboard', key: 'peers' } as const, [])
const window = atom({ plugin: 'switchboard', key: 'window' } as const, 200_000)
const failure = atom({ plugin: 'switchboard', key: 'error' } as const, '')
const configuring = atom({ plugin: 'switchboard', key: 'configuring' } as const, false)
const configError = atom({ plugin: 'switchboard', key: 'configError' } as const, '')
// Pids of sessions that finished (busy → idle) since you last went to them. Jumping to one
// from the pane, or the session going busy again, clears it.
const unseen = atom({ plugin: 'switchboard', key: 'unseen' } as const, [])

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
// $.audio.play has a player only on macOS (afplay); on Windows it plays nothing, so the clip
// goes through .NET's SoundPlayer instead.
async function play($: EngineInterface, sound: string) {
  if (!(await isWindows($))) return $.audio.play({ asset: `sounds/${sound}.wav` }).catch(() => {})
  await $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:SWITCHBOARD_SOUND).PlaySync()'], {
      env: { SWITCHBOARD_SOUND: `${$.plugin.root}/sounds/${sound}.wav` },
    })
    .catch(() => {})
}

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

type Summary = { mtimeMs: number; readAt: number; title: string; pr?: string; tokens?: number; repos: string[]; tickets: string[] }

// $.fs.read refuses files past 4 MB, and long sessions pass that. A bigger transcript is read
// from its last TAIL_BYTES through a process (its stdout holds 4 MB too), at most every
// BIG_REREAD_MS. The first, cut line of the tail fails to parse and is skipped.
const FS_READ_LIMIT = 4 * 1024 * 1024
const TAIL_BYTES = 3 * 1024 * 1024
const BIG_REREAD_MS = 30_000

// Single quotes only: PowerShell 5.1 loses double quotes in a -Command argument.
const TAIL_FILE = [
  "$f = [System.IO.File]::Open($env:SWITCHBOARD_FILE, 'Open', 'Read', 'ReadWrite')",
  '$n = [int][Math]::Min($f.Length, [int64]$env:SWITCHBOARD_BYTES)',
  "[void]$f.Seek(-$n, 'End')",
  '$b = New-Object byte[] $n',
  '$read = 0',
  'while ($read -lt $n) { $r = $f.Read($b, $read, $n - $read); if ($r -le 0) { break }; $read += $r }',
  '$f.Close()',
  '$out = [Console]::OpenStandardOutput()',
  '$out.Write($b, 0, $read)',
  '$out.Flush()',
].join('\n')

const TITLE_MARK = '"type":"ai-title"'
const TITLE_LINES = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Select-String -LiteralPath $env:SWITCHBOARD_FILE -SimpleMatch -Pattern $env:SWITCHBOARD_PATTERN | ForEach-Object { $_.Line }',
].join('\n')

async function readTranscript($: EngineInterface, path: string, size: number, onWindows: boolean) {
  if (size < FS_READ_LIMIT) return $.fs.read(path)
  const tail = onWindows
    ? await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TAIL_FILE], {
        env: { SWITCHBOARD_FILE: path, SWITCHBOARD_BYTES: String(TAIL_BYTES) },
      })
    : await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
  if (tail.exitCode !== 0) throw new Error(`could not read the end of ${path}: ${tail.stderr.trim()}`)
  if (tail.stdout.includes(TITLE_MARK)) return tail.stdout

  // Big tool output can push ai-title entries more than TAIL_BYTES apart, so a tail can miss
  // them all. The file's title lines go in front, where any later entry in the tail still wins.
  const titles = onWindows
    ? await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TITLE_LINES], {
        env: { SWITCHBOARD_FILE: path, SWITCHBOARD_PATTERN: TITLE_MARK },
      })
    : await $.process.run(['grep', '-F', TITLE_MARK, path])
  return `${titles.stdout}\n${tail.stdout}`
}

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
      // A session that starts or resumes writes a last-prompt entry with no lastPrompt.
      if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string') prompt = entry.lastPrompt
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
  const onWindows = await isWindows($)
  const alive = onWindows ? await livePids($) : undefined
  const now = await $.clock.now()

  for (const file of files) {
    const session: SessionFile = JSON.parse(await $.fs.read(`${dir}/${file.name}`).catch(() => '{}'))
    if (!session.sessionId) continue
    if (alive) {
      if (!alive.has(session.pid)) continue
    } else if (session.messagingSocketPath && !(await $.fs.exists(session.messagingSocketPath))) continue

    const transcriptPath = `${home}/.claude/projects/${projectDir(session.cwd)}/${session.sessionId}.jsonl`
    const stat = await $.fs.stat(transcriptPath).catch(() => undefined)
    let summary = summaries.get(session.sessionId)
    const isChanged = stat && summary?.mtimeMs !== stat.mtimeMs
    if (isChanged && (!summary || stat.size < FS_READ_LIMIT || now - summary.readAt >= BIG_REREAD_MS)) {
      // One transcript that can't be read or parsed keeps its last summary rather than failing the pane.
      const fresh = await readTranscript($, transcriptPath, stat.size, onWindows).then(summarize).catch(() => undefined)
      if (fresh !== undefined) {
        // A tail can start after the session's pr-link entry, so keep the PR already known.
        summary = { mtimeMs: stat.mtimeMs, readAt: now, ...fresh, pr: fresh.pr ?? summary?.pr }
        summaries.set(session.sessionId, summary)
      }
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
      tabTitles: [title, session.name].filter(Boolean),
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
  await update($, unseen, previous => {
    // Keep a mark while its session is still open, still another session, and not busy again.
    const kept = previous.filter(pid => rows.some(row => row.pid === pid && !row.isSelf && row.status !== 'busy'))
    const next = [...new Set([...kept, ...finished.map(row => row.pid)])]
    return next.length === previous.length && next.every(pid => previous.includes(pid)) ? previous : next
  })
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

// Windows Terminal titles each tab "<status glyph> <session title>". UI Automation finds the tab
// whose title is, or ends with, one of SWITCHBOARD_TABS, selects it and brings its window
// forward. Single quotes only: PowerShell 5.1 loses double quotes in a -Command argument.
const SELECT_WT_TAB = [
  'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
  '$A = [System.Windows.Automation.AutomationElement]',
  '$S = [System.Windows.Automation.TreeScope]',
  "$wanted = $env:SWITCHBOARD_TABS -split '\\r?\\n' | Where-Object { $_ }",
  "$windows = $A::RootElement.FindAll($S::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')))",
  'foreach ($window in $windows) {',
  '  $tabs = $window.FindAll($S::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)))',
  '  foreach ($tab in $tabs) {',
  '    $name = $tab.Current.Name',
  "    if (-not ($wanted | Where-Object { $name -eq $_ -or $name.EndsWith(' ' + $_) })) { continue }",
  '    $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()',
  '    [void](New-Object -ComObject WScript.Shell).AppActivate($window.Current.Name)',
  "    'ok'",
  '    exit',
  '  }',
  '}',
  "'missing'",
].join('\n')

async function jump($: EngineInterface, peer: Peer) {
  await update($, unseen, previous => (previous.includes(peer.pid) ? previous.filter(pid => pid !== peer.pid) : previous))
  if (await isWindows($)) {
    const found = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', SELECT_WT_TAB], {
      env: { SWITCHBOARD_TABS: peer.tabTitles.join('\n') },
    })
    if (found.stdout.trim() !== 'ok') $.ui.toast(`No Windows Terminal tab found for ${peer.name}`)
    return
  }
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
    const unseenPids = await read($, unseen)
    const isConfiguring = await read($, configuring)
    const settingsError = await read($, configError)
    const size = await read($, window)
    const now = await $.clock.now()
    const error = await read($, failure)

    // Chips never shrink: one the measure got wrong runs off the edge rather than being
    // squeezed into a column a character wide.
    const lay = (chips: Chip[], indent = 0) =>
      flow(chips, e.props.bodyColumns - indent).map(row => (
        <Box paddingLeft={indent}>
          {row.flatMap((chip, i) => {
            const node = <Box flexShrink={0}>{chip.node}</Box>
            return i === 0 ? [node] : [<Text>{GAP}</Text>, node]
          })}
        </Box>
      ))

    // A repo or ticket group is one line: the items that fit, then "…" for the rest.
    const detailWidth = e.props.bodyColumns - DETAIL_INDENT
    const group = (icon: string, items: string[], item: (label: string, value: string) => RenderElement): Chip[] => {
      if (items.length === 0) return []
      const shown: [string, string][] = []
      let width = cells(`${icon} `)
      for (const [i, value] of items.entries()) {
        const more = i < items.length - 1 ? 2 : 0 // room for " …" while items remain
        const step = (shown.length > 0 ? 1 : 0) + cells(value)
        if (width + step + more <= detailWidth) {
          shown.push([value, value])
          width += step
          continue
        }
        if (shown.length === 0) {
          const label = clip(value, Math.max(4, detailWidth - width))
          shown.push([label, value])
          width += cells(label)
        }
        break
      }
      const isCut = shown.length < items.length
      return [{
        width: width + (isCut ? 2 : 0),
        node: (
          <Box>
            <Text dimColor>{icon} </Text>
            {shown.flatMap(([label, value], i) => (i === 0 ? [item(label, value)] : [<Text> </Text>, item(label, value)]))}
            {isCut && <Text dimColor> …</Text>}
          </Box>
        ),
      }]
    }

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
      if (settings.showPr && peer.pr) {
        const pr = clip(`⎇ ${peer.pr}`, detailWidth)
        chips.push({ width: cells(pr), node: <Text dimColor>{pr}</Text> })
      }
      if (settings.showRepos) {
        chips.push(...group('📦', peer.repos, (label, repo) => (
          <Button key={`repo-${peer.pid}-${repo}`} label={label} plain dimColor onPress={() => openUrl($, `https://github.com/${repo}`)} />
        )))
      }
      if (settings.showTickets) {
        chips.push(...group('🎫', peer.tickets, (label, ticket) => settings.ticketUrl ? (
          <Button key={`ticket-${peer.pid}-${ticket}`} label={label} plain dimColor onPress={() => openUrl($, `${settings.ticketUrl}${ticket}`)} />
        ) : (
          <Text key={`ticket-${peer.pid}-${ticket}`} dimColor>{label}</Text>
        )))
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
          // Every line is cut to the pane rather than wrapped. The arrow and dot take 5 cells; the
          // name gets what's left, and the age and folder are cut to the room after it (dropped
          // under 4 cells), so a narrow pane never squeezes them into a column.
          const number = `${index + 1}: `
          const you = peer.isSelf ? ' (you)' : ''
          const waiting = peer.status === 'waiting' ? ` ${peer.waitingFor ?? 'needs you'}` : ''
          const bell = unseenPids.includes(peer.pid) ? '🔔 ' : ''
          const room = e.props.bodyColumns - 5 - cells(bell)
          const name = clip(peer.isWorkroom ? `📁 ${peer.name}` : peer.name, Math.max(8, room - number.length - you.length - cells(waiting)))
          const metaRoom = room - number.length - cells(name) - you.length - cells(waiting) - 3
          const meta = metaRoom >= 4 ? clip(`${age(now - peer.startedAt)} · ${peer.folder}`, metaRoom) : ''
          return (
            <Box flexDirection="column">
              <Text color={peer.isSelf ? 'claude' : 'subtle'}>{'━'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
              <Box>
                <Box flexShrink={0}>
                  <Text color="claude">{peer.isSelf ? '▶ ' : '  '}</Text>
                  <Text>{DOT[peer.status] ?? '⚪'} </Text>
                  {bell && <Text>{bell}</Text>}
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
                {meta && <Text dimColor> · {meta}</Text>}
              </Box>
              {peer.title && <Text>{clip(peer.title, e.props.bodyColumns)}</Text>}
              {lay(details(peer), DETAIL_INDENT)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
