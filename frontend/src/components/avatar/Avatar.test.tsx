import { afterEach, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { Avatar } from './Avatar'

afterEach(cleanup)

// An account with no local copy of its picture (#194) is drawn as its
// initials, and nothing in the page can request an image.
it('shows the initials and loads no image when an account has no local picture', () => {
  const view = render(<Avatar name="Ana Prat" src="" size={44} />)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.getByText('AP')).toBeTruthy()
})

it('shows a local copy of the picture', () => {
  const view = render(<Avatar name="Ana Prat" src="/media/avatars/ana/me.png" size={44} />)
  const image = view.container.querySelector('img')
  expect(image?.getAttribute('src')).toBe('/media/avatars/ana/me.png')
})
