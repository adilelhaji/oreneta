import { useEffect, useState } from 'react'
import { Inbox, Tag, Undo2, UserRound } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  assignCategory,
  categories$,
  categoryReason,
  fieldLabel,
  opLabel,
  type Category,
  type CategoryVerdict,
} from '../../states/categories'
import { isInboxFolder } from '../../states/mail'
import { MenuItem } from '../menu/MenuItem'
import { MenuGroup } from '../menu/Menu'

const icon = (Icon: typeof Tag) => <Icon size={14} className="text-secondary" strokeWidth={1.75} />

/**
 * Which category a conversation is in, why, and how to say otherwise
 * (#91, ADR-0023). Fetched when the menu opens, like the priority reason.
 */
export function CategoryMenuSection({
  threadId,
  accountId,
  folderId,
  onAct,
}: {
  threadId: string
  accountId: string
  folderId: string
  onAct: () => void
}) {
  const { t } = useTranslation()
  const list = useValue(categories$.list)
  const [verdict, setVerdict] = useState<CategoryVerdict | null>(null)
  const applies = list.length > 0 && isInboxFolder(folderId, accountId)

  useEffect(() => {
    if (!applies) return
    let live = true
    void categoryReason(threadId).then((found) => live && setVerdict(found))
    return () => {
      live = false
    }
  }, [threadId, applies])

  if (!applies || !verdict) return null
  const other = t('categories.other', { defaultValue: 'Other' })
  const nameOf = (id: string) => list.find((c) => c.id === id)?.name ?? other
  const current: Category | undefined = list.find((c) => c.id === verdict.category)
  const reason = describe(verdict, current)
  const act = (category: string | null, scope: 'conversation' | 'sender') => {
    onAct()
    void assignCategory(threadId, category, scope)
  }

  function describe(v: CategoryVerdict, category: Category | undefined): string {
    switch (v.reason.kind) {
      case 'conversation':
        return t('categories.why.conversation', { defaultValue: 'You put this conversation here.' })
      case 'sender':
        return t('categories.why.sender', { sender: v.reason.addr, defaultValue: 'You put mail from {sender} here.' })
      case 'conditions': {
        const held = v.reason.held
          .map((i) => category?.conditions[i])
          .filter((c) => !!c)
          .map((c) =>
            t('categories.why.condition', {
              field: fieldLabel(c.field),
              op: opLabel(c.op),
              value: c.value,
              defaultValue: '{field} {op} “{value}”',
            }),
          )
          .join(t('categories.why.and', { defaultValue: ' and ' }))
        return t('categories.why.rule', { rule: held, defaultValue: 'Its rule matched: {rule}.' })
      }
      default:
        return t('categories.why.nothing', { defaultValue: 'No category’s rules matched.' })
    }
  }

  const targets = [...list.map((c) => c.id), ''].filter((id) => id !== verdict.category)
  const corrected = verdict.reason.kind === 'conversation' || verdict.reason.kind === 'sender'

  return (
    // Where it is and why, naming the group of the ways to say otherwise.
    <MenuGroup
      separated
      label={
        <span className="flex items-center gap-1.5">
          <Inbox size={14} aria-hidden="true" className="text-secondary" strokeWidth={1.75} />
          {t('categories.inCategory', { name: nameOf(verdict.category), defaultValue: 'Category: {name}' })}
        </span>
      }
      labelClassName="px-2 pt-0.5 text-caption font-semibold text-primary"
      description={reason}
      descriptionClassName="mt-0.5 px-2 pb-1 text-2xs leading-snug text-secondary"
    >
      {targets.map((id) => (
        <MenuItem
          key={id || 'other'}
          icon={icon(Tag)}
          label={t('categories.moveTo', { name: nameOf(id), defaultValue: 'Move to {name}' })}
          onClick={() => act(id, 'conversation')}
        />
      ))}
      {verdict.sender && verdict.reason.kind !== 'sender' && (
        <MenuItem
          icon={icon(UserRound)}
          label={t('categories.alwaysSender', {
            sender: verdict.sender,
            name: nameOf(verdict.category),
            defaultValue: 'Always put mail from {sender} in {name}',
          })}
          onClick={() => act(verdict.category, 'sender')}
        />
      )}
      {corrected && (
        <MenuItem
          icon={icon(Undo2)}
          label={t('categories.letRulesDecide', { defaultValue: 'Let the rules decide' })}
          onClick={() => act(null, verdict.reason.kind === 'sender' ? 'sender' : 'conversation')}
        />
      )}
    </MenuGroup>
  )
}
