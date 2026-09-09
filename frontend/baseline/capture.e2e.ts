import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { FIXED_NOW, SCENES, createFixture } from './fixtures'

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 1024, 600]) {
    for (const scene of SCENES) {
      test(`${scene}-${theme}-${width}`, async ({ page, context, browser }, info) => {
        const errors: string[] = []
        const externalRequests: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text())
        })
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url())
          const request = route.request()
          if (
            url.origin !== 'http://127.0.0.1:4179' ||
            request.method() !== 'GET' ||
            ['fetch', 'xhr'].includes(request.resourceType()) ||
            /^\/(api|media|wails|profile)(\/|$)/.test(url.pathname)
          ) {
            externalRequests.push(url.href)
            return route.abort()
          }
          return route.continue()
        })
        await page.setViewportSize({ width, height: 900 })
        await page.clock.setFixedTime(new Date(FIXED_NOW))
        await page.goto(`/?scene=${scene}&theme=${theme}`)
        await expect(page.getByTestId('baseline-banner')).toHaveText(
          `Synthetic baseline · ${scene} · ${theme} · no real backend`,
        )
        await expect(page.getByTestId('baseline-content')).toBeVisible()
        expect(
          await page.getByTestId('baseline-content').evaluate((el) => getComputedStyle(el).display),
        ).toBe('flex')
        if (scene === 'composer') {
          await expect(page.locator('textarea').filter({ visible: true }).first()).toHaveValue(
            /synthetic review draft/,
          )
        } else if (scene === 'reader') {
          await expect(
            page.getByText('Thanks Morgan. I will review the checklist today.', { exact: false }),
          ).toBeVisible()
        } else {
          await expect(
            page.getByText('Pilot checklist — synthetic conversation', { exact: false }).first(),
          ).toBeVisible()
        }
        await page.evaluate(() => document.fonts.ready)
        if (scene === 'composer') {
          await expect
            .poll(() =>
              page.evaluate(() =>
                (window as any).__baseline.bridge.calls.map((c: any) => c.command),
              ),
            )
            .toEqual(expect.arrayContaining(['pgp.secretKeys', 'smime.identities']))
        }
        if (scene === 'tasks') {
          await page.getByRole('checkbox', { name: /show completed/i }).check()
          await expect
            .poll(() => page.evaluate(() => (window as any).__baseline.bridge.calls))
            .toEqual(
              expect.arrayContaining([
                { command: 'tasks.list', payload: { include_completed: true } },
              ]),
            )
          await page.getByRole('checkbox', { name: /show completed/i }).uncheck()
        }
        await expect(page.locator('html')).toHaveClass(
          theme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/,
        )
        const metadata = await page.evaluate(() => {
          const state = (window as any).__baseline
          return { fixture: state.fixture, denied: state.bridge.denied }
        })
        expect(metadata.fixture).toEqual(createFixture())
        expect(metadata.denied).toEqual([])
        expect(externalRequests).toEqual([])
        expect(errors).toEqual([])
        // #85 replaces the historical 600px cutoff with positive visibility.
        const knownLimitations: string[] = []
        if (scene === 'reader') {
          const reply = page.getByText('Thanks Morgan. I will review the checklist today.', {
            exact: false,
          })
          await expect(reply).toBeInViewport()
        }
        const screenshot = await page.screenshot({
          path: info.outputPath('baseline.png'),
          animations: 'disabled',
        })
        await info.attach('baseline', { body: screenshot, contentType: 'image/png' })
        const worktreeDirty =
          execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
        if (process.env.CI) expect(worktreeDirty).toBe(false)
        await info.attach('provenance', {
          body: JSON.stringify(
            {
              sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              workflowSha: process.env.GITHUB_SHA ?? null,
              worktreeDirty,
              fixtureSHA256: createHash('sha256')
                .update(JSON.stringify(metadata.fixture))
                .digest('hex'),
              browser: browser.version(),
              platform: process.platform,
              node: process.version,
              theme,
              scene,
              width,
              height: 900,
              locale: 'en-US',
              timezone: 'UTC',
              clock: FIXED_NOW,
              transport: 'synthetic-only',
              font: 'platform fallback; remote font import removed',
              knownLimitations,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      })
    }
  }
}
