export type Peer = {
  pid: number
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

declare module 'claude-code' {
  interface PluginState {
    'sessions-pane': { peers: Peer[]; window: number; error: string }
  }
}
