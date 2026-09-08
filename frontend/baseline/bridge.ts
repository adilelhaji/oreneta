import type { BaselineFixture } from './fixtures'

/** In-memory test transport. Never delegates to Wails, a network or a profile. */
export function createBaselineBridge(fixture: BaselineFixture) {
  const calls: { command: string; payload: unknown }[] = []
  const denied: string[] = []
  const responses: Record<string, unknown> = {
    'app.prefsSet': null,
    'tasks.list': { tasks: fixture.tasks },
    'mail.saveDraft': { id: 'synthetic-draft' },
    'templates.list': { templates: [] },
    'pgp.secretKeys': { keys: [] },
    'pgp.certs': { certs: [] },
    'smime.identities': { identities: [] },
    'smime.certs': { certs: [] },
  }
  return {
    calls,
    denied,
    async Invoke(command: string, payload: unknown) {
      calls.push({ command, payload: structuredClone(payload) })
      const p = payload as Record<string, unknown> | null
      const validObject = p !== null && typeof p === 'object' && !Array.isArray(p)
      const valid =
        validObject &&
        (command === 'app.prefsSet'
          ? typeof p.key === 'string' && Object.hasOwn(p, 'value')
          : command === 'tasks.list'
            ? typeof p.include_completed === 'boolean'
            : command === 'mail.saveDraft'
              ? p.account_id === fixture.account.id &&
                p.to === 'morgan@example.test' &&
                typeof p.body === 'string'
              : Object.keys(p).length === 0)
      if (!Object.hasOwn(responses, command) || !valid) {
        denied.push(command)
        throw new Error(`Baseline denied backend command or payload: ${command}`)
      }
      return structuredClone(responses[command])
    },
  }
}
