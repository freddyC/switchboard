export type Peer = {
  pid: number
  isSelf: boolean
  isWorkroom: boolean
  name: string
  status: string
  waitingFor?: string
  startedAt: number
  folder: string
  title: string
  pr?: string
  tokens?: number
  repos: string[]
  tickets: string[]
}

export type Settings = {
  chime: boolean
  showContext: boolean
  showRepos: boolean
  showTickets: boolean
  showPr: boolean
  workroomNames: boolean
  ticketUrl: string
  browserHome: string
  titleLength: number
  refreshSeconds: number
}

declare module 'claude-code' {
  interface PluginState {
    'switchboard': { peers: Peer[]; window: number; error: string; configuring: boolean; configError: string }
  }
}
