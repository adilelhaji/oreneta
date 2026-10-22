import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Link2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Baseline,
  Highlighter,
  Eraser,
  IndentIncrease,
  IndentDecrease,
  Table as TableIcon,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  BetweenVerticalStart,
  BetweenVerticalEnd,
  Rows3,
  Columns3,
  Trash2,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { useTranslation } from '../../lib/i18n'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import {
  ALIGNMENTS,
  BACKGROUND_COLORS,
  COLOR_NAMES,
  FONT_FAMILIES,
  FONT_SIZES,
  TEXT_COLORS,
  safeCssColor,
  safeFontFamily,
  safeFontSize,
  type Alignment,
  type ColorName,
} from './richText'

// What the toolbar shows for the selection: read through the same validators
// as the sent HTML, so a value pasted in that would not be sent is not shown.
function formatState(editor: Editor) {
  const style = editor.getAttributes('textStyle')
  return {
    fontFamily: safeFontFamily(style.fontFamily) ?? '',
    fontSize: safeFontSize(style.fontSize) ?? '',
    color: safeCssColor(style.color) ?? '',
    backgroundColor: safeCssColor(style.backgroundColor) ?? '',
    align: ALIGNMENTS.find((align) => editor.isActive({ textAlign: align })) ?? null,
    inTable: editor.isActive('table'),
  }
}

const SELECT_CLASS =
  'h-7 max-w-[9rem] rounded-control-sm border border-border bg-app px-1 text-caption text-primary cursor-pointer'

// A row of swatches under a toolbar button, and one to take the colour off.
function ColorMenu({
  title,
  icon,
  palette,
  current,
  onPick,
  onClear,
}: {
  title: string
  icon: ReactNode
  palette: Record<ColorName, string>
  current: string
  onPick: (color: string) => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(
    open,
    (target) => Boolean(wrapRef.current?.contains(target as Node | null)),
    () => setOpen(false),
  )
  const pick = (run: () => void) => {
    setOpen(false)
    run()
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-control-sm transition-colors cursor-pointer ${
          current ? 'bg-accent/15 text-accent-fg' : 'text-secondary hover:bg-hover'
        }`}
      >
        {icon}
      </button>
      {open && (
        <div
          role="group"
          aria-label={title}
          className="absolute start-0 top-full z-50 mt-1 flex items-center gap-1 rounded-control border border-border bg-panel p-1.5 shadow-raised"
        >
          {COLOR_NAMES.map((name) => {
            const label = t(`composer.toolbar.color.${name}`)
            return (
              <button
                key={name}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={current === palette[name]}
                onClick={() => pick(() => onPick(palette[name]))}
                className="h-5 w-5 rounded-full border border-border cursor-pointer"
                style={{ background: palette[name] }}
              />
            )
          })}
          <button
            type="button"
            title={t('composer.toolbar.removeColor')}
            aria-label={t('composer.toolbar.removeColor')}
            onClick={() => pick(onClear)}
            className="flex h-5 w-5 items-center justify-center rounded-full text-secondary hover:bg-hover cursor-pointer"
          >
            <Eraser size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  )
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-7 w-7 items-center justify-center rounded-control-sm transition-colors cursor-pointer ${
        active ? 'bg-active text-accent-fg' : 'text-secondary hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

// Rich-text formatting toolbar shown above the body in rich mode.
export function ComposerToolbar({ editor, onSetLink }: { editor: Editor; onSetLink: () => void }) {
  const { t } = useTranslation()
  // Re-rendered on every change of what the selection carries, so the
  // controls follow the caret and the table buttons appear inside a table.
  const format = useEditorState({ editor, selector: ({ editor }) => formatState(editor) })
  const familyIsListed = FONT_FAMILIES.some((family) => family.value === format.fontFamily)
  const sizeIsListed = (FONT_SIZES as readonly string[]).includes(format.fontSize)
  const alignButtons: { align: Alignment; label: string; icon: ReactNode }[] = [
    { align: 'left', label: t('composer.toolbar.alignLeft'), icon: <AlignLeft size={16} strokeWidth={1.75} /> },
    { align: 'center', label: t('composer.toolbar.alignCenter'), icon: <AlignCenter size={16} strokeWidth={1.75} /> },
    { align: 'right', label: t('composer.toolbar.alignRight'), icon: <AlignRight size={16} strokeWidth={1.75} /> },
    { align: 'justify', label: t('composer.toolbar.alignJustify'), icon: <AlignJustify size={16} strokeWidth={1.75} /> },
  ]
  const tableButtons: { label: string; icon: ReactNode; run: () => boolean }[] = [
    {
      label: t('composer.toolbar.addRowBefore'),
      icon: <BetweenHorizontalStart size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().addRowBefore().run(),
    },
    {
      label: t('composer.toolbar.addRowAfter'),
      icon: <BetweenHorizontalEnd size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().addRowAfter().run(),
    },
    {
      label: t('composer.toolbar.addColumnBefore'),
      icon: <BetweenVerticalStart size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: t('composer.toolbar.addColumnAfter'),
      icon: <BetweenVerticalEnd size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().addColumnAfter().run(),
    },
    {
      label: t('composer.toolbar.deleteRow'),
      icon: <Rows3 size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().deleteRow().run(),
    },
    {
      label: t('composer.toolbar.deleteColumn'),
      icon: <Columns3 size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().deleteColumn().run(),
    },
    {
      label: t('composer.toolbar.deleteTable'),
      icon: <Trash2 size={16} strokeWidth={1.75} />,
      run: () => editor.chain().focus().deleteTable().run(),
    },
  ]

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-header px-3 py-1.5 select-none">
      <ToolbarButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={t('composer.toolbar.bold')}
      >
        <Bold size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={t('composer.toolbar.italic')}
      >
        <Italic size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title={t('composer.toolbar.underline')}
      >
        <UnderlineIcon size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title={t('composer.toolbar.strikethrough')}
      >
        <Strikethrough size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <select
        aria-label={t('composer.toolbar.fontFamily')}
        title={t('composer.toolbar.fontFamily')}
        value={format.fontFamily}
        onChange={(event) => {
          const value = event.target.value
          if (value) editor.chain().focus().setFontFamily(value).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t('composer.toolbar.defaultFormat')}</option>
        {/* A font that came in with pasted or quoted text, shown as it is. */}
        {format.fontFamily && !familyIsListed && (
          <option value={format.fontFamily}>{format.fontFamily.split(',')[0].replace(/'/g, '')}</option>
        )}
        {FONT_FAMILIES.map((family) => (
          <option key={family.value} value={family.value}>
            {family.label}
          </option>
        ))}
      </select>
      <select
        aria-label={t('composer.toolbar.fontSize')}
        title={t('composer.toolbar.fontSize')}
        value={format.fontSize}
        onChange={(event) => {
          const value = event.target.value
          if (value) editor.chain().focus().setFontSize(value).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t('composer.toolbar.defaultFormat')}</option>
        {format.fontSize && !sizeIsListed && <option value={format.fontSize}>{format.fontSize}</option>}
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size.replace(/pt$/, '')}
          </option>
        ))}
      </select>
      <ColorMenu
        title={t('composer.toolbar.textColor')}
        icon={<Baseline size={16} strokeWidth={1.75} />}
        palette={TEXT_COLORS}
        current={format.color}
        onPick={(color) => editor.chain().focus().setColor(color).run()}
        onClear={() => editor.chain().focus().unsetColor().run()}
      />
      <ColorMenu
        title={t('composer.toolbar.backgroundColor')}
        icon={<Highlighter size={16} strokeWidth={1.75} />}
        palette={BACKGROUND_COLORS}
        current={format.backgroundColor}
        onPick={(color) => editor.chain().focus().setBackgroundColor(color).run()}
        onClear={() => editor.chain().focus().unsetBackgroundColor().run()}
      />
      <span className="mx-1 h-4 w-px bg-border" />
      {alignButtons.map(({ align, label, icon }) => (
        <ToolbarButton
          key={align}
          active={format.align === align}
          onClick={() => editor.chain().focus().setTextAlign(align).run()}
          title={label}
        >
          {icon}
        </ToolbarButton>
      ))}
      <ToolbarButton
        active={false}
        onClick={() => editor.chain().focus().decreaseIndent().run()}
        title={t('composer.toolbar.outdent')}
      >
        <IndentDecrease size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={false}
        onClick={() => editor.chain().focus().increaseIndent().run()}
        title={t('composer.toolbar.indent')}
      >
        <IndentIncrease size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title={t('composer.toolbar.heading')}
      >
        <Heading2 size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title={t('composer.toolbar.bulletList')}
      >
        <List size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title={t('composer.toolbar.numberedList')}
      >
        <ListOrdered size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title={t('composer.toolbar.quote')}
      >
        <Quote size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive('link')} onClick={onSetLink} title={t('composer.toolbar.link')}>
        <Link2 size={16} strokeWidth={1.75} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton
        active={format.inTable}
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        title={t('composer.toolbar.insertTable')}
      >
        <TableIcon size={16} strokeWidth={1.75} />
      </ToolbarButton>
      {format.inTable &&
        tableButtons.map(({ label, icon, run }) => (
          <ToolbarButton key={label} active={false} onClick={run} title={label}>
            {icon}
          </ToolbarButton>
        ))}
      <span
        className="ms-auto hidden items-center gap-1 pe-1 text-2xs font-medium text-secondary select-none min-[900px]:flex"
        title={t('composer.toolbar.markdownHint')}
      >
        {t('composer.toolbar.markdown')}:
        <code className="rounded bg-raised px-1">**bold**</code>
        <code className="rounded bg-raised px-1"># heading</code>
        <code className="rounded bg-raised px-1">- list</code>
      </span>
    </div>
  )
}
