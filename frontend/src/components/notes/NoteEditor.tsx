import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Pin, RotateCcw, Trash2 } from 'lucide-react'
import { EditorContent, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import { Image as TiptapImage } from '@tiptap/extension-image'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { settings$ } from '../../states/settings'
import { confirmAction, showToast } from '../../states/ui'
import {
  getNote,
  loadNotes,
  notes$,
  parseTags,
  purgeNote,
  restoreNote,
  trashNote,
  writeNote,
  type Note,
  type NoteFields,
} from '../../states/notes'
import { Button } from '../button/Button'
import { ComposerToolbar } from '../composer/ComposerToolbar'
import { NoteAttachments } from './NoteAttachments'

const SAVE_DEBOUNCE_MS = 800
/** One picture; the note as a whole is bounded by the core. */
const MAX_PICTURE_BYTES = 5 * 1024 * 1024

type Status = 'idle' | 'saving' | 'saved' | 'failed'
type Clash = { kind: 'conflict'; stored: Note } | { kind: 'gone' }

/**
 * One note, read from the core when it opens and saved as it is written.
 *
 * Saves settle for a moment before they are sent, and a pending one is sent
 * when the editor closes rather than dropped. Each names the revision it was
 * made from: if the note changed elsewhere meanwhile, nothing is written and
 * both versions are shown until the reader picks one.
 */
export function NoteEditor({ initialId }: { initialId: string | null }) {
  const { t } = useTranslation()
  const spellCheck = useValue(settings$.spellCheck)
  const [loaded, setLoaded] = useState(initialId === null)
  const [title, setTitle] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [pinned, setPinned] = useState(false)
  const [trashed, setTrashed] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [clash, setClash] = useState<Clash | null>(null)
  const id = useRef<string | null>(initialId)
  const revision = useRef(0)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fields = useRef<NoteFields>({ title: '', html: '', tags: [], pinned: false })
  const picker = useRef<HTMLInputElement | null>(null)
  const clashRef = useRef<Clash | null>(null)
  clashRef.current = clash

  const save = async () => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (!dirty.current || clashRef.current) return
    const current = fields.current
    const empty =
      !current.title.trim() && !current.html.replace(/<[^>]*>/g, '').trim() && !current.html.includes('<img')
    if (!id.current && empty) return
    dirty.current = false
    setStatus('saving')
    const result = await writeNote(id.current, revision.current, current)
    if (result.status === 'saved') {
      const created = !id.current
      id.current = result.note.id
      revision.current = result.note.revision
      setStatus('saved')
      if (created) notes$.selected.set(result.note.id)
      void loadNotes()
    } else if (result.status === 'conflict') {
      setStatus('idle')
      setClash({ kind: 'conflict', stored: result.stored })
    } else if (result.status === 'gone') {
      setStatus('idle')
      setClash({ kind: 'gone' })
    } else {
      dirty.current = true
      setStatus('failed')
      showToast(result.message || t('notes.couldNotSave', { defaultValue: 'Could not save the note' }), 'error')
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const changed = (patch: Partial<NoteFields>) => {
    fields.current = { ...fields.current, ...patch }
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void saveRef.current(), SAVE_DEBOUNCE_MS)
  }

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TiptapImage.configure({ allowBase64: true })],
    content: '',
    editorProps: {
      attributes: {
        class: 'tiptap-body focus:outline-none min-h-[240px] px-4 py-3 text-ui leading-relaxed',
        // The text keeps its own direction, whatever the interface's (ADR-0055).
        dir: 'auto',
        spellcheck: String(spellCheck),
        'aria-label': t('notes.body', { defaultValue: 'Note' }),
      },
    },
    onUpdate: ({ editor }) => {
      // Only a change to the text is an edit.
      const html = editor.getHTML()
      if (html !== fields.current.html) changed({ html })
    },
  })

  const seed = (note: Note) => {
    revision.current = note.revision
    fields.current = { title: note.title, html: note.html, tags: note.tags, pinned: note.pinned }
    setTitle(note.title)
    setTagsText(note.tags.join(', '))
    setPinned(note.pinned)
    setTrashed(note.deleted_at !== null)
    editor?.commands.setContent(note.html, { emitUpdate: false })
    // Without `false` this counts as an edit, and merely opening a note saved it.
    editor?.setEditable(note.deleted_at === null, false)
  }

  useEffect(() => {
    if (!editor || initialId === null) return
    let live = true
    void getNote(initialId)
      .then((note) => {
        if (!live) return
        if (note) seed(note)
        else setClash({ kind: 'gone' })
        setLoaded(true)
      })
      .catch(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
    // Seeded once per opened note: the editor is keyed by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // A pending edit is sent, not dropped, when another note is opened.
  useEffect(() => () => void (timer.current !== undefined && saveRef.current()), [])

  const keepMine = async () => {
    if (!clash) return
    if (clash.kind === 'conflict') revision.current = clash.stored.revision
    else id.current = null
    setClash(null)
    clashRef.current = null
    dirty.current = true
    await saveRef.current()
  }

  const keepSaved = () => {
    if (clash?.kind !== 'conflict') return
    dirty.current = false
    seed(clash.stored)
    setClash(null)
  }

  const addPicture = (file: File | undefined) => {
    if (!file || !editor) return
    if (!file.type.startsWith('image/')) return
    if (file.size > MAX_PICTURE_BYTES) {
      showToast(t('notes.pictureTooLarge', { defaultValue: 'Pictures up to 5 MB can be added to a note' }), 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') editor.chain().focus().setImage({ src: reader.result }).run()
    }
    reader.readAsDataURL(file)
  }

  const setLink = () => {
    if (!editor) return
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt(t('notes.linkUrl', { defaultValue: 'Link URL' }), prev ?? 'https://')
    if (url === null) return
    if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const remove = async () => {
    if (!id.current) {
      notes$.selected.set(null)
      return
    }
    if (trashed) {
      const confirmed = await confirmAction({
        title: t('notes.purgeTitle', { defaultValue: 'Delete this note for good?' }),
        message: t('notes.purgeText', { defaultValue: 'It cannot be restored afterwards.' }),
        confirmLabel: t('buttons.delete'),
        tone: 'danger',
      })
      if (confirmed) await purgeNote(id.current)
      return
    }
    await save()
    await trashNote(id.current)
  }

  if (!editor) return null
  const statusText =
    status === 'saving'
      ? t('notes.saving', { defaultValue: 'Saving…' })
      : status === 'saved'
        ? t('notes.saved', { defaultValue: 'Saved on this computer' })
        : status === 'failed'
          ? t('notes.notSaved', { defaultValue: 'Not saved' })
          : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={!loaded}>
      {clash?.kind === 'conflict' && (
        <div role="alert" className="border-b border-border bg-warning-soft px-4 py-3 text-caption text-primary">
          <p className="font-semibold">
            {t('notes.conflictTitle', { defaultValue: 'This note was changed elsewhere. Nothing was saved.' })}
          </p>
          <p className="mt-1 text-secondary">
            {t('notes.conflictSaved', { defaultValue: 'The saved version:' })}{' '}
            <span className="text-primary">
              {[clash.stored.title, clash.stored.text].filter(Boolean).join(' — ').slice(0, 300)}
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void keepMine()}>
              {t('notes.keepMine', { defaultValue: 'Keep mine' })}
            </Button>
            <Button size="sm" variant="secondary" onClick={keepSaved}>
              {t('notes.keepSaved', { defaultValue: 'Use the saved one' })}
            </Button>
          </div>
        </div>
      )}
      {clash?.kind === 'gone' && (
        <div role="alert" className="border-b border-border bg-warning-soft px-4 py-3 text-caption text-primary">
          <p className="font-semibold">
            {t('notes.goneTitle', { defaultValue: 'This note was deleted elsewhere. Nothing was saved.' })}
          </p>
          <Button className="mt-2" size="sm" onClick={() => void keepMine()}>
            {t('notes.saveAsNew', { defaultValue: 'Keep it as a new note' })}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <input
          value={title}
          readOnly={trashed}
          onChange={(event) => {
            setTitle(event.target.value)
            changed({ title: event.target.value })
          }}
          placeholder={t('notes.titlePlaceholder', { defaultValue: 'Title' })}
          aria-label={t('notes.titleLabel', { defaultValue: 'Title' })}
          className="min-w-0 flex-1 basis-48 bg-transparent text-heading-sm font-bold text-primary placeholder-secondary outline-none"
        />
        <span aria-live="polite" className="text-2xs text-secondary">
          {statusText}
        </span>
        {!trashed && (
          <button
            type="button"
            aria-pressed={pinned}
            title={pinned ? t('notes.unpin', { defaultValue: 'Unpin' }) : t('notes.pin', { defaultValue: 'Pin' })}
            aria-label={pinned ? t('notes.unpin', { defaultValue: 'Unpin' }) : t('notes.pin', { defaultValue: 'Pin' })}
            onClick={() => {
              setPinned(!pinned)
              changed({ pinned: !pinned })
            }}
            className={clsx(
              'flex h-8 w-8 items-center justify-center rounded-control-sm transition-colors cursor-pointer',
              pinned ? 'text-accent' : 'text-secondary hover:bg-hover',
            )}
          >
            <Pin size={16} strokeWidth={1.75} />
          </button>
        )}
        {trashed && id.current && (
          <Button size="sm" variant="secondary" onClick={() => void restoreNote(id.current!)}>
            <RotateCcw size={14} strokeWidth={1.75} />
            {t('notes.restore', { defaultValue: 'Restore' })}
          </Button>
        )}
        <button
          type="button"
          title={
            trashed
              ? t('notes.purge', { defaultValue: 'Delete for good' })
              : t('notes.delete', { defaultValue: 'Move to the trash' })
          }
          aria-label={
            trashed
              ? t('notes.purge', { defaultValue: 'Delete for good' })
              : t('notes.delete', { defaultValue: 'Move to the trash' })
          }
          onClick={() => void remove()}
          className="flex h-8 w-8 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-danger-soft hover:text-danger cursor-pointer"
        >
          <Trash2 size={16} strokeWidth={1.75} />
        </button>
      </div>
      {!trashed && (
        <div className="flex items-stretch bg-header">
          <div className="min-w-0 flex-1">
            <ComposerToolbar editor={editor} onSetLink={setLink} />
          </div>
          <button
            type="button"
            title={t('notes.addPicture', { defaultValue: 'Add a picture' })}
            aria-label={t('notes.addPicture', { defaultValue: 'Add a picture' })}
            onClick={() => picker.current?.click()}
            className="flex w-10 shrink-0 items-center justify-center border-b border-border text-secondary hover:bg-hover hover:text-primary cursor-pointer"
          >
            <ImagePlus size={16} strokeWidth={1.75} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              addPicture(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
      {id.current && <NoteAttachments noteId={id.current} readOnly={trashed} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
        <label htmlFor="note-tags" className="text-caption text-secondary">
          {t('notes.tags', { defaultValue: 'Tags' })}
        </label>
        <input
          id="note-tags"
          value={tagsText}
          readOnly={trashed}
          onChange={(event) => {
            setTagsText(event.target.value)
            changed({ tags: parseTags(event.target.value) })
          }}
          placeholder={t('notes.tagsPlaceholder', { defaultValue: 'work, ideas' })}
          className="min-w-0 flex-1 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent"
        />
        <span className="text-2xs text-secondary">
          {t('notes.localOnly', { defaultValue: 'Kept on this computer only' })}
        </span>
      </div>
    </div>
  )
}
