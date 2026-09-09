import { useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  FileText,
  Inbox,
  Mail,
  PenLine,
  Reply,
  Search,
  Send,
  Star,
  Table2,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { BaselineFixture } from './fixtures'
import type { Message } from '../src/types'

// Presentation-only state: no production stores, bridge or provider transport.
export function ReferenceMail({ fixture, scene, theme }: { fixture: BaselineFixture; scene: string; theme: string }) {
  const [folder, setFolder] = useState('INBOX')
  const [rows, setRows] = useState(fixture.threads)
  const [selectedId, setSelectedId] = useState<string | null>(
    ['inbox', 'table', 'selection'].includes(scene) ? null : fixture.threads[0].id,
  )
  const [checked, setChecked] = useState<string[]>(
    scene === 'selection' ? fixture.threads.slice(0, 2).map((row) => row.id) : [],
  )
  const [table, setTable] = useState(scene === 'table')
  const [query, setQuery] = useState('')
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [composing, setComposing] = useState(scene === 'composer' || scene === 'uncertain')
  const [uncertain, setUncertain] = useState(scene === 'uncertain')
  const [to, setTo] = useState('morgan@example.test')
  const [subject, setSubject] = useState('Re: Pilot checklist')
  const [body, setBody] = useState('Hello Morgan,\n\nHere is the synthetic review draft. Nothing will be sent.')
  const [notice, setNotice] = useState('')
  const [sortAscending, setSortAscending] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLHeadingElement>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const selected = rows.find((row) => row.id === selectedId)
  const visible = rows
    .filter(
      (row) =>
        row.folder_id === folder && `${row.from_name} ${row.subject}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => (sortAscending ? a.date - b.date : b.date - a.date))
  const folderName = fixture.folders.find((item) => item.id === folder)?.name ?? folder

  function openMessage(row: Message) {
    setSelectedId(row.id)
    setTable(false)
    setComposing(false)
    requestAnimationFrame(() => titleRef.current?.focus())
  }
  function backToList() {
    setSelectedId(null)
    setComposing(false)
    requestAnimationFrame(() => listRef.current?.focus())
  }
  function compose(mode: 'new' | 'reply' | 'forward') {
    setFoldersOpen(false)
    setTo(mode === 'reply' ? (selected?.from_addr ?? '') : '')
    setSubject(mode === 'new' ? '' : `${mode === 'reply' ? 'Re' : 'Fwd'}: ${selected?.subject ?? ''}`)
    setBody(mode === 'forward' ? (selected?.body ?? '') : '')
    setUncertain(false)
    setComposing(true)
    requestAnimationFrame(() => toRef.current?.focus())
  }
  function move(target: string) {
    const ids = checked.length ? checked : selectedId ? [selectedId] : []
    setRows((current) => current.map((row) => (ids.includes(row.id) ? { ...row, folder_id: target } : row)))
    setChecked([])
    backToList()
    setNotice(`${ids.length} message(s) moved to ${target} in this prototype only.`)
  }
  return (
    <div className="mail-reference" data-theme={theme} data-pane={composing || selected ? 'reader' : 'list'}>
      <div className="reference-banner">
        Design reference · synthetic data · no mail is sent · {scene}
        <a href={`/?scene=reader&theme=${theme}`}>Compare baseline</a>
        <a href={`?scene=${scene}&theme=${theme === 'light' ? 'dark' : 'light'}`}>Switch theme</a>
      </div>
      <header className="reference-toolbar">
        <span className="reference-brand">
          <Mail aria-hidden="true" /> Oreneta
        </span>
        <button className="reference-primary" onClick={() => compose('new')}>
          <PenLine /> New message
        </button>
        {!composing && body && (
          <button
            onClick={() => {
              setFoldersOpen(false)
              setComposing(true)
              requestAnimationFrame(() => toRef.current?.focus())
            }}
          >
            Resume draft
          </button>
        )}
        <button
          onClick={() => setFoldersOpen((value) => !value)}
          aria-expanded={foldersOpen}
          className="reference-folder-toggle"
        >
          <Inbox /> Folders
        </button>
        <label className="reference-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Search mail"
            placeholder="Search mail"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedId(null)
              setComposing(false)
              setChecked([])
            }}
          />
        </label>
      </header>
      <main className="reference-workspace" data-table={table && !composing}>
        <nav aria-label="Mail folders" className="reference-folders" data-open={foldersOpen}>
          <p className="reference-kicker">MAILBOX</p>
          <strong>{fixture.account.display_name}</strong>
          <small>{fixture.account.email}</small>
          {[...fixture.folders, { id: 'Archive', name: 'Archive' }, { id: 'Trash', name: 'Trash' }].map((item) => (
            <button
              key={item.id}
              aria-current={folder === item.id ? 'page' : undefined}
              onClick={() => {
                setFolder(item.id)
                setQuery('')
                setChecked([])
                setFoldersOpen(false)
                backToList()
              }}
            >
              {item.id === 'INBOX' ? (
                <Inbox />
              ) : item.id === 'Sent' ? (
                <Send />
              ) : item.id === 'Archive' ? (
                <Archive />
              ) : item.id === 'Trash' ? (
                <Trash2 />
              ) : (
                <FileText />
              )}
              <span>{item.name}</span>
              <small>{rows.filter((row) => row.folder_id === item.id && row.unread).length || ''}</small>
            </button>
          ))}
          <p className="reference-kicker">LABELS</p>
          <span className="reference-label">
            <i /> Work
          </span>
          <span className="reference-label">
            <i /> Needs review
          </span>
          <p className="reference-folder-note">
            Mail workspace reference
            <br />
            Calendar, contacts and tasks follow in #38.
          </p>
        </nav>
        <section className="reference-list" aria-label="Message list">
          <div className="reference-section-heading">
            <h1 tabIndex={-1} ref={listRef}>
              {folderName}
            </h1>
            <span>{visible.length} conversations</span>
          </div>
          <div className="reference-list-tools">
            <label>
              <input
                type="checkbox"
                aria-label="Select all visible messages"
                checked={visible.length > 0 && visible.every((row) => checked.includes(row.id))}
                disabled={!visible.length}
                onChange={(event) => setChecked(event.target.checked ? visible.map((row) => row.id) : [])}
              />{' '}
              Select
            </label>
            <button
              aria-pressed={table}
              onClick={() => {
                setTable((value) => !value)
                backToList()
              }}
            >
              <Table2 /> Table
            </button>
            <button onClick={() => setSortAscending((value) => !value)}>
              {sortAscending ? 'Oldest first' : 'Newest first'}
            </button>
          </div>
          {checked.length > 0 && (
            <div className="reference-selection" role="status">
              <strong>{checked.length} selected</strong>
              <button onClick={() => move('Archive')}>Archive selected</button>
              <button onClick={() => setChecked([])}>Clear selection</button>
            </div>
          )}
          <div className="reference-rows" data-table={table}>
            {visible.length === 0 ? (
              <p className="reference-empty">{query ? 'No messages match your search.' : 'This folder is empty.'}</p>
            ) : table ? (
              <table className="reference-table">
                <thead className="reference-table-head">
                  <tr>
                    <th scope="col">Select</th>
                    <th scope="col">From</th>
                    <th scope="col">Subject</th>
                    <th scope="col" aria-sort={sortAscending ? 'ascending' : 'descending'}>
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.id} data-unread={row.unread} data-checked={checked.includes(row.id)}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.subject}`}
                          checked={checked.includes(row.id)}
                          onChange={(event) =>
                            setChecked((current) =>
                              event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                            )
                          }
                        />
                      </td>
                      <td title={row.from_name}>{row.from_name}</td>
                      <td>
                        <button onClick={() => openMessage(row)}>{row.subject}</button>
                      </td>
                      <td>
                        {new Date(row.date * 1000).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: 'UTC',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              visible.map((row) => (
                <div
                  className="reference-row"
                  key={row.id}
                  data-open={selectedId === row.id}
                  data-unread={row.unread}
                  data-checked={checked.includes(row.id)}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.subject}`}
                    checked={checked.includes(row.id)}
                    onChange={(event) =>
                      setChecked((current) =>
                        event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                      )
                    }
                  />
                  <button onClick={() => openMessage(row)} aria-current={selectedId === row.id ? 'true' : undefined}>
                    <span className="reference-row-top">
                      <span>{row.from_name}</span>
                      <time>
                        {new Date(row.date * 1000).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: 'UTC',
                        })}
                      </time>
                    </span>
                    <span className="reference-subject">{row.subject}</span>
                    {!table && <span className="reference-preview">{row.preview}</span>}
                    {!!row.labels?.length && (
                      <span className="reference-tags">
                        {row.labels.map((label) => (
                          <span key={label}>{label === 'work' ? 'Work' : 'Needs review'}</span>
                        ))}
                      </span>
                    )}
                  </button>
                  {row.starred && <Star className="reference-star" aria-label="Starred" />}
                </div>
              ))
            )}
          </div>
        </section>
        <section className="reference-reader" aria-label={composing ? 'Compose message' : 'Reading pane'}>
          <div className="reference-reader-actions">
            <button onClick={backToList}>
              <ArrowLeft /> Back to list
            </button>
            {!composing && selected && (
              <>
                <button onClick={() => compose('reply')}>
                  <Reply /> Reply
                </button>
                <button onClick={() => compose('forward')}>
                  <ChevronRight /> Forward
                </button>
                <button onClick={() => move('Archive')}>
                  <Archive /> Archive
                </button>
                <button onClick={() => move('Trash')}>
                  <Trash2 /> Delete
                </button>
              </>
            )}
          </div>
          {composing ? (
            <form
              className="reference-compose"
              onSubmit={(event) => {
                event.preventDefault()
                setUncertain(true)
              }}
            >
              <h2>New message</h2>
              <p className="reference-from">
                From: {fixture.account.display_name} &lt;{fixture.account.email}&gt;
              </p>
              <label>
                To
                <input
                  ref={toRef}
                  aria-label="To"
                  type="email"
                  required
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
              <label>
                Subject
                <input
                  aria-label="Subject"
                  required
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              </label>
              {uncertain && (
                <div className="reference-warning" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Delivery not confirmed</strong>
                    <p>
                      The server response is unknown. Check Sent before deciding whether to send again. Your draft is
                      retained.
                    </p>
                    <small>Illustrated state only; this prototype sends nothing.</small>
                  </div>
                </div>
              )}
              <textarea
                aria-label="Message body"
                required
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <div className="reference-compose-footer">
                <button type="submit" className="reference-primary" disabled={uncertain}>
                  <Send /> Simulate send
                </button>
                <span>{uncertain ? 'Draft retained in this session' : 'Prototype · edits last until reload'}</span>
              </div>
            </form>
          ) : selected ? (
            <article className="reference-message">
              <h2 ref={titleRef} tabIndex={-1}>
                {selected.subject}
              </h2>
              <div className="reference-message-meta">
                <span className="reference-avatar">MR</span>
                <div>
                  <strong>{selected.from_name}</strong>
                  <p>{selected.from_addr}</p>
                  <p>To: {selected.to}</p>
                </div>
                <time>8 Sep 2026</time>
              </div>
              <div className="reference-tags">
                {selected.labels?.map((label) => (
                  <span key={label}>{label === 'work' ? 'Work' : 'Needs review'}</span>
                ))}
              </div>
              <div className="reference-message-body">{selected.body}</div>
              {selected.thread_id === fixture.messages[0].thread_id && (
                <details>
                  <summary>Additional conversation messages</summary>
                  <p className="reference-message-body">{fixture.messages[1].body}</p>
                </details>
              )}
              <button className="reference-reply" onClick={() => compose('reply')}>
                <Reply /> Reply to {selected.from_name}
              </button>
            </article>
          ) : (
            <div className="reference-reader-empty">
              <Mail />
              <h2>Select a message</h2>
              <p>Read your mail here, with folders always within reach.</p>
            </div>
          )}
        </section>
      </main>
      <footer className="reference-status" role="status">
        {notice || `${fixture.account.email} · Synthetic local session · No connection`}
      </footer>
    </div>
  )
}
