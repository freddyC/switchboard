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

declare module 'claude-code' {
  interface PluginState {
    'switchboard': { peers: Peer[]; window: number; error: string }
  }
}
