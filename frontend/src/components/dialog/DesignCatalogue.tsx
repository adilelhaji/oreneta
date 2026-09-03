import { useState } from 'react'
import { Archive, Bookmark, Mail, Palette, Send, Star, Trash2 } from 'lucide-react'
import { ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { Chip } from '../chip/Chip'
import { SelectInput, TextInput } from '../field/Field'
import { Notice } from '../notice/Notice'
import { MenuItem } from '../menu/MenuItem'
import { EmptyState } from '../empty-state/EmptyState'
import { ErrorState, LoadingState } from '../empty-state/StateViews'
import { SettingsGroup, Switch, ToggleRow } from './AccountSettingsRows'
import { Dialog } from './Dialog'

/**
 * Every component in every state, on one screen.
 *
 * Not for readers — it opens from the command palette and nothing links to
 * it. It is for looking at the whole library at once and seeing what has
 * drifted: a button whose hover differs from its neighbour's, a chip a pixel
 * taller than the one beside it, a state nobody had painted. A design system
 * that lives only in the components that use it is a system nobody can check.
 *
 * Deliberately untranslated. The words are the names of things in the
 * library, not copy a reader sees.
 */
export function DesignCatalogue() {
  const [on, setOn] = useState(true)
  const [chip, setChip] = useState(true)
  const onClose = () => ui$.catalogueOpen.set(false)

  return (
    <Dialog title="Design catalogue" subtitle="Every component, every state" icon={Palette} width="xl" onClose={onClose}>
      <Section title="Type scale" note="Six steps. Nothing on a screen should be a size that is not one of these.">
        <div className="flex flex-col gap-1">
          <p className="text-2xs">text-2xs · 10px · badges, kickers</p>
          <p className="text-caption">text-caption · 11px · captions, hints, chip labels</p>
          <p className="text-xs">text-xs · 12px · dense secondary text</p>
          <p className="text-ui">text-ui · 13px · menu items, rows, controls</p>
          <p className="text-sm">text-sm · 14px · body</p>
          <p className="text-title font-bold">text-title · 15px · dialog and section titles</p>
        </div>
      </Section>

      <Section title="Buttons" note="Four variants, two sizes. Disabled is the same shape at half strength.">
        <Row>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="sm" leftIcon={Send}>Small with icon</Button>
          <Button size="sm" variant="secondary" rightIcon={Archive}>Small trailing</Button>
          <IconButton icon={Star} label="Icon button" />
          <IconButton icon={Star} label="Icon button, active" active />
          <IconButton icon={Trash2} label="Icon button, danger" variant="danger" />
          <IconButton icon={Mail} label="Icon button, accent" variant="accent" />
          <IconButton icon={Mail} label="Icon button, small" size="sm" />
        </Row>
      </Section>

      <Section title="Fields" note="Three sizes; invalid carries its own border, not a message.">
        <Row>
          <TextInput placeholder="Small" fieldSize="sm" />
          <TextInput placeholder="Medium" fieldSize="md" />
          <TextInput placeholder="Large" fieldSize="lg" />
        </Row>
        <Row>
          <TextInput placeholder="Invalid" invalid />
          <TextInput placeholder="Disabled" disabled />
          <SelectInput defaultValue="a">
            <option value="a">Select</option>
            <option value="b">Another</option>
          </SelectInput>
          <Switch checked={on} label="Switch" onChange={() => setOn(!on)} />
        </Row>
      </Section>

      <Section title="Chips" note="One height per size. A colour is a tint, never a fill, so text keeps its contrast.">
        <Row>
          <Chip>Neutral</Chip>
          <Chip tone="accent">Accent</Chip>
          <Chip colour="#0f9d58">Coloured</Chip>
          <Chip colour="#c2255c" size="sm">Small coloured</Chip>
          <Chip onClick={() => setChip(!chip)} selected={chip}>
            Toggle · {chip ? 'on' : 'off'}
          </Chip>
          <Chip onRemove={() => {}} removeLabel="Remove">Removable</Chip>
        </Row>
      </Section>

      <Section title="Menu items">
        <div className="w-56 rounded-control border border-border bg-chats p-1 shadow-overlay">
          <MenuItem icon={<Bookmark size={13} className="text-secondary" />} label="Item" />
          <MenuItem icon={<Archive size={13} className="text-secondary" />} label="Item with trailing" trailing={<span className="text-2xs text-secondary">⌘E</span>} />
          <MenuItem icon={<Trash2 size={13} />} label="Danger item" danger />
          <MenuItem label="Disabled item" disabled />
        </div>
      </Section>

      <Section title="Notices" note="Tone paints the border and the icon, not the box.">
        <div className="flex flex-col gap-2">
          <Notice>Information, in a line the reader sees without being interrupted.</Notice>
          <Notice tone="success" title="Done">With a title, and a body under it.</Notice>
          <Notice tone="warning">Something to know before going on.</Notice>
          <Notice tone="danger" action={<Button size="sm" variant="secondary">Retry</Button>}>
            Something went wrong, with the one action that follows.
          </Notice>
        </div>
      </Section>

      <Section title="Settings rows">
        <SettingsGroup title="Group">
          <ToggleRow icon={<Mail size={15} />} title="A toggle row" hint="With a hint under it." checked={on} onChange={() => setOn(!on)} />
        </SettingsGroup>
      </Section>

      <Section title="Panel states" note="Empty, loading and error share one shape, and loading never looks like empty.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="h-56 rounded-panel border border-border bg-chats"><EmptyState title="Nothing here" text="An empty folder, said plainly." /></div>
          <div className="h-56 rounded-panel border border-border bg-chats"><LoadingState title="Still coming" text="The rows have not arrived yet." /></div>
          <div className="h-56 rounded-panel border border-border bg-chats"><ErrorState title="Could not load" text="The server did not answer." retryLabel="Try again" onRetry={() => {}} /></div>
        </div>
      </Section>
    </Dialog>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-bold">{title}</h3>
        {note && <p className="text-caption text-secondary">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}
