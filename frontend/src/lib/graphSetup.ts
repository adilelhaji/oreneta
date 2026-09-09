export type GraphLease = { account: string; generation: string }
export type GraphProgress = {
  state: string
  pages?: number
  changes?: number
  error?: string
  retry_after_seconds?: number
  mail_backend_ready?: boolean
}
type Call = <T>(command: string, payload?: unknown) => Promise<T>

/** One serial poller per wizard. A cancelled late Begin is cancelled in the
 * backend too; no token, OAuth URL or checkpoint is held by the UI. */
export class GraphSetupFlow {
  private generation = 0
  private attempt = ''
  private lease: GraphLease | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private call: Call,
    private update: (state: GraphProgress) => void,
    private ready: (account: string, current: () => boolean) => Promise<void>,
  ) {}

  async cancel() {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const lease = this.lease
    const attempt = this.attempt
    await Promise.all([
      lease
        ? this.call('graph.activationCancel', lease).then(() => {
            if (this.lease === lease) this.lease = null
          })
        : Promise.resolve(),
      attempt
        ? this.call('oauth.graphCancel', { attempt }).then(() => {
            if (this.attempt === attempt) this.attempt = ''
          })
        : Promise.resolve(),
    ])
  }

  async begin(account: string, displayName: string) {
    const generation = this.generation + 1
    try {
      await this.cancel()
    } catch {
      if (generation === this.generation) this.update({ state: 'failed', error: 'cancel_failed' })
      return
    }
    if (generation !== this.generation) return
    this.update({ state: 'authorizing' })
    try {
      const { attempt } = await this.call<{ attempt: string }>('oauth.graphBegin', { account })
      if (generation !== this.generation) {
        await this.call('oauth.graphCancel', { attempt })
        return
      }
      this.attempt = attempt
      await this.poll(generation, displayName)
    } catch {
      if (generation === this.generation) this.update({ state: 'failed', error: 'authorization_failed' })
    }
  }

  private async poll(generation: number, displayName: string) {
    if (generation !== this.generation) return
    try {
      if (!this.lease) {
        const auth = await this.call<GraphProgress>('oauth.graphPoll', { attempt: this.attempt })
        if (generation !== this.generation) return
        if (auth.state === 'authorized') {
          const lease = await this.call<GraphLease>('graph.activationBegin', {
            attempt: this.attempt,
            display_name: displayName,
          })
          if (generation !== this.generation) {
            await this.call('graph.activationCancel', lease)
            return
          }
          this.lease = lease
          this.update({ state: 'syncing', pages: 0, changes: 0 })
        } else if (['failed', 'cancelled', 'expired'].includes(auth.state)) {
          this.update(auth)
          return
        }
      } else {
        const progress = await this.call<GraphProgress>('graph.activationPoll', this.lease)
        if (generation !== this.generation) return
        this.update(progress)
        if (progress.state === 'ready' && progress.mail_backend_ready) {
          const account = this.lease.account
          this.lease = null // Unmount must not cancel an already completed job.
          await this.ready(account, () => generation === this.generation)
          return
        }
        if (['failed', 'cancelled'].includes(progress.state)) return
      }
      this.timer = setTimeout(() => void this.poll(generation, displayName), 1000)
    } catch {
      if (generation === this.generation) this.update({ state: 'failed', error: 'activation_failed' })
    }
  }
}
