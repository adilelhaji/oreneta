import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createFixture, FIXED_NOW } from './fixtures'

const scenes = ['inbox', 'reader', 'composer', 'table', 'selection', 'uncertain']
test.beforeEach(async ({ page, context }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW))
  await context.route('**/*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (
      url.origin !== 'http://127.0.0.1:4179' ||
      request.method() !== 'GET' ||
      ['fetch', 'xhr'].includes(request.resourceType())
    ) {
      throw new Error(`Reference attempted external communication: ${url.href}`)
    }
    return route.continue()
  })
})

for (const theme of ['light', 'dark'])
  for (const width of [1440, 1024, 600])
    for (const scene of scenes) {
      test(`reference-${scene}-${theme}-${width}`, async ({ page, browser }, info) => {
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text())
        })
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/reference.html?scene=${scene}&theme=${theme}`)
        await expect(page.locator('.reference-banner')).toContainText('synthetic data')
        await expect(page.locator('.mail-reference')).toHaveAttribute('data-theme', theme)
        if (scene === 'composer' || scene === 'uncertain') {
          await expect(page.getByRole('textbox', { name: 'Message body' })).toHaveValue(/synthetic review draft/)
          await expect(page.getByRole('textbox', { name: 'Message body' })).toBeInViewport()
        } else if (scene === 'reader') {
          await expect(page.getByRole('heading', { name: createFixture().threads[0].subject })).toBeInViewport()
        } else {
          await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeInViewport()
        }
        if (scene === 'uncertain') {
          await expect(page.getByRole('alert')).toContainText('Delivery not confirmed')
          await expect(page.getByRole('button', { name: 'Simulate send' })).toBeDisabled()
        }
        if (width > 600) {
          await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeInViewport()
        }
        if (scene === 'selection') await expect(page.getByText('2 selected', { exact: true })).toBeInViewport()
        if (scene === 'table') await expect(page.getByRole('columnheader', { name: 'Subject' })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await page.evaluate(() => ({ wails: 'go' in window, preferences: localStorage.length }))).toEqual({
          wails: false,
          preferences: 0,
        })
        await page.evaluate(() => document.fonts.ready)
        expect(errors).toEqual([])
        await info.attach('reference', {
          body: await page.screenshot({ path: info.outputPath('reference.png'), animations: 'disabled' }),
          contentType: 'image/png',
        })
        const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
        if (process.env.CI) expect(dirty).toBe(false)
        await info.attach('provenance', {
          body: JSON.stringify(
            {
              sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              workflowSha: process.env.GITHUB_SHA ?? null,
              worktreeDirty: dirty,
              fixtureSHA256: createHash('sha256').update(JSON.stringify(createFixture())).digest('hex'),
              theme,
              width,
              height: 900,
              scene,
              clock: FIXED_NOW,
              platform: process.platform,
              browser: browser.version(),
              transport: 'none; synthetic presentation state',
              locale: 'en-US',
              timezone: 'UTC',
              limitations: [
                'Not a production entry or native WebView2 test',
                'No provider or real send validation',
                'Platform fallback fonts',
              ],
            },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      })
    }

test('reference keyboard reading, reply, validation and uncertain draft retention', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 })
  await page.goto('/reference.html?scene=inbox')
  await expect(page.getByRole('button', { name: 'Resume draft' })).toHaveCount(0)
  const message = page.getByRole('button', { name: /Morgan Rivera.*Pilot checklist/ }).first()
  await message.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: createFixture().threads[0].subject })).toBeFocused()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('morgan@example.test')
  await page.getByRole('button', { name: 'Simulate send' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message body' }).fill('Keep this review draft')
  await page.getByRole('button', { name: 'Simulate send' }).click()
  await expect(page.getByRole('alert')).toContainText('Check Sent')
  await expect(page.getByRole('textbox', { name: 'Message body' })).toHaveValue('Keep this review draft')
  await page.getByRole('textbox', { name: 'Message body' }).fill('Still editable after uncertain result')
  await expect(page.getByRole('button', { name: 'Simulate send' })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to list' }).click()
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Resume draft' }).click()
  await expect(page.getByRole('textbox', { name: 'Message body' })).toHaveValue('Still editable after uncertain result')
  await expect(page.getByRole('button', { name: 'Simulate send' })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to list' }).click()
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await page.getByRole('button', { name: 'Sent', exact: true }).click()
  await expect(page.getByText('This folder is empty.')).toBeInViewport()
})

test('reference search, selection, archive and folder recovery', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/reference.html?scene=inbox')
  await page.getByRole('textbox', { name: 'Search mail' }).pressSequentially('no matching subject')
  await expect(page.getByRole('textbox', { name: 'Search mail' })).toBeFocused()
  await expect(page.getByText('No messages match your search.')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Select all visible messages' })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Search mail' }).fill('Budget review')
  await expect(page.locator('.reference-row')).toHaveCount(1)
  await page.getByRole('checkbox', { name: 'Select all visible messages' }).check()
  await page.getByRole('button', { name: 'Archive selected' }).click()
  await expect(page.getByText('1 message(s) moved to Archive in this prototype only.')).toBeVisible()
  await page.getByRole('button', { name: /^Archive/ }).click()
  await expect(page.locator('.reference-row')).toHaveCount(1)
  await expect(page.locator('.reference-row')).toContainText('Budget review')
  await page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.locator('.reference-row')).toHaveCount(5)
})

test('reference table sorts, opens a conversation and clears selection', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 })
  await page.goto('/reference.html?scene=table')
  await expect(page.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending')
  await page.getByRole('button', { name: 'Newest first' }).click()
  await expect(page.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'ascending')
  await expect(page.locator('tbody tr').first()).toContainText('Welcome to the internal demo')
  await page.getByRole('checkbox', { name: 'Select all visible messages' }).check()
  await expect(page.getByText('6 selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear selection' }).click()
  await expect(page.getByRole('checkbox', { name: 'Select all visible messages' })).not.toBeChecked()
  await page.getByRole('button', { name: 'Budget review: Q4 planning', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Budget review: Q4 planning' })).toBeFocused()
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'To', exact: true })).toBeInViewport()
})
