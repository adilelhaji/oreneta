import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createFixture, scenario } from './fixtures'
import { createBaselineBridge } from './bridge'

describe('isolated synthetic baseline', () => {
  it('is deterministic, internally linked and independent between calls', () => {
    const a = createFixture(),
      b = createFixture()
    expect(a).toEqual(b)
    expect(a.account.email).toEndWith('@example.test')
    expect(a.tasks[0].thread_id).toBe(a.threads[0].thread_id)
    expect(new Set(a.threads.map((row) => row.id)).size).toBe(a.threads.length)
    a.threads[0].subject = 'Changed'
    expect(b.threads[0].subject).not.toBe('Changed')
    for (const message of b.messages) expect(message.from_addr).toEndWith('@example.test')
  })
  it('validates requested scenarios rather than silently changing them', () => {
    expect(scenario(new URLSearchParams())).toEqual({ scene: 'inbox', theme: 'light' })
    expect(() => scenario(new URLSearchParams('scene=real-account'))).toThrow()
    expect(() => scenario(new URLSearchParams('theme=unknown'))).toThrow()
  })
  it('returns independent mock responses and rejects every unlisted command', async () => {
    const bridge = createBaselineBridge(createFixture())
    const response = (await bridge.Invoke('tasks.list', { include_completed: false })) as {
      tasks: unknown[]
    }
    response.tasks.length = 0
    expect(
      ((await bridge.Invoke('tasks.list', { include_completed: false })) as { tasks: unknown[] })
        .tasks,
    ).toHaveLength(1)
    for (const command of ['mail.send', 'account.add', 'mail.sync', 'toString']) {
      await expect(bridge.Invoke(command, {})).rejects.toThrow('Baseline denied')
    }
    expect(bridge.denied).toHaveLength(4)
    await expect(
      bridge.Invoke('mail.saveDraft', {
        account_id: 'real-account',
        to: 'real@example.test',
        body: 'x',
      }),
    ).rejects.toThrow()
    await expect(bridge.Invoke('app.prefsSet', null)).rejects.toThrow()
    await expect(bridge.Invoke('tasks.list', {})).rejects.toThrow()
    expect(bridge.calls[0]).toEqual({
      command: 'tasks.list',
      payload: { include_completed: false },
    })
  })
  it('does not install a mock in the production entry or bridge', () => {
    for (const filename of ['../src/main.tsx', '../src/lib/bridge.ts']) {
      const source = readFileSync(new URL(filename, import.meta.url), 'utf8')
      expect(source).not.toContain('createBaselineBridge')
      expect(source).not.toContain('/baseline/')
    }
    expect(readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8')).toContain(
      'throw new Error',
    )
    const sourceRoot = new URL('../src/', import.meta.url)
    for (const filename of readdirSync(sourceRoot, { recursive: true })) {
      if (typeof filename !== 'string' || !/\.tsx?$/.test(filename)) continue
      expect(readFileSync(new URL(filename.replaceAll('\\', '/'), sourceRoot), 'utf8')).not.toMatch(
        /(?:from\s*|import\s*\()\s*['"][^'"]*baseline/,
      )
    }
    const entry = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
    expect(entry).not.toMatch(/import\(['"][^'"]*(?:\/App|\/boot|\/useAppEffects)['"]\)/)
  })
})
