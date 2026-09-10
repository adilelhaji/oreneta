import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type AssistantMode = 'local' | 'remote'
export type AssistantAction = 'summary' | 'draft' | 'task_suggestion'

export type AssistantSource = { account_id: string; message_id: string }
export type AssistantTaskSuggestion = {
  account_id: string
  message_id: string
  title: string
  note: string
  due_at: number | null
}
export type AssistantResult = {
  text: string
  sources: AssistantSource[]
  tasks: AssistantTaskSuggestion[]
  warnings: string[]
}

export type AssistantProviderConfig = {
  mode: AssistantMode
  endpoint: string
  model: string
}

export type AssistantAttachmentContext = {
  name: string
  mime: string
  size: number
  content_base64?: string
}

export type AssistantContextItem = {
  message_id: string
  account_id: string
  sender?: string
  subject?: string
  body: string
  attachments?: AssistantAttachmentContext[]
}

export type AssistantPreview = {
  provider: AssistantProviderConfig
  action: AssistantAction
  manifest: {
    items: Array<{
      message_id: string
      account_id: string
      sender: string
      subject: string
      body_bytes: number
      attachments: Array<{ name: string; mime: string; size: number; content_selected: boolean }>
    }>
    total_bytes: number
    untrusted_input: boolean
  }
  requires_confirmation: boolean
  will_transmit: boolean
  automatic_mail_actions: boolean
  preview_token: string
}

const DEFAULT_PROVIDER: AssistantProviderConfig = {
  mode: 'local',
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  model: '',
}

export const assistant$ = observable<AssistantProviderConfig>({ ...DEFAULT_PROVIDER })
export const ASSISTANT_PREF_KEYS = ['assistant_mode', 'assistant_endpoint', 'assistant_model']

let hydrating = false
assistant$.onChange(({ changes }) => {
  if (hydrating) return
  const keys: Record<keyof AssistantProviderConfig, string> = {
    mode: 'assistant_mode',
    endpoint: 'assistant_endpoint',
    model: 'assistant_model',
  }
  const changed = new Set(changes.map((change) => change.path[0] as keyof AssistantProviderConfig))
  for (const field of changed) {
    if (field in keys) void invoke('app.prefsSet', { key: keys[field], value: assistant$[field].get() }).catch(() => {})
  }
})

export function sanitizeAssistantConfig(value: unknown): AssistantProviderConfig | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AssistantProviderConfig>
  const mode = candidate.mode === 'remote' ? 'remote' : candidate.mode === 'local' ? 'local' : null
  if (!mode) return null
  if (typeof candidate.endpoint !== 'string' || typeof candidate.model !== 'string') return null
  return { mode, endpoint: candidate.endpoint.trim(), model: candidate.model.trim() }
}

export function hydrateAssistant(prefs: Record<string, unknown>) {
  hydrating = true
  try {
    const mode = prefs.assistant_mode
    const endpoint = prefs.assistant_endpoint
    const model = prefs.assistant_model
    if ((mode === 'local' || mode === 'remote') && typeof endpoint === 'string' && typeof model === 'string') {
      assistant$.set({ mode, endpoint: endpoint.trim(), model: model.trim() })
    }
  } finally {
    hydrating = false
  }
}

export async function previewAssistantAction(
  action: AssistantAction,
  context: AssistantContextItem[],
  provider: AssistantProviderConfig = assistant$.get(),
) {
  return invoke<AssistantPreview>('assistant.preview', { provider, action, context })
}

export async function executeAssistantAction(
  action: AssistantAction,
  context: AssistantContextItem[],
  confirmed: boolean,
  previewToken: string,
  executionId: string,
  authorization?: string,
  provider: AssistantProviderConfig = assistant$.get(),
) {
  return invoke<{ prepared: AssistantPreview; response: string; persisted: false }>('assistant.execute', {
    provider,
    action,
    context,
    confirmed,
    preview_token: previewToken,
    execution_id: executionId,
    ...(authorization?.trim() ? { authorization: authorization.trim() } : {}),
  })
}

export async function cancelAssistantExecution(executionId: string) {
  if (!executionId.trim()) return
  await invoke('assistant.cancel', { execution_id: executionId })
}

export function parseAssistantResponse(response: string): AssistantResult {
  const fallback: AssistantResult = { text: response, sources: [], tasks: [], warnings: [] }
  try {
    const value = JSON.parse(response) as Record<string, unknown>
    if (!value || typeof value !== 'object') return fallback
    const text = typeof value.text === 'string' ? value.text : response
    const warnings: string[] = []
    const sourceValues = Array.isArray(value.sources) ? value.sources : []
    const sources = sourceValues.filter((source): source is AssistantSource => {
      const valid = !!source && typeof source === 'object' && typeof (source as AssistantSource).account_id === 'string' && typeof (source as AssistantSource).message_id === 'string'
      if (!valid) warnings.push('Some provider sources were malformed and were ignored.')
      return valid
    })
    const taskValues = Array.isArray(value.tasks) ? value.tasks : []
    const tasks = taskValues.flatMap((task) => {
        if (!task || typeof task !== 'object') return []
        const candidate = task as Partial<AssistantTaskSuggestion>
        if (typeof candidate.account_id !== 'string' || typeof candidate.message_id !== 'string' || typeof candidate.title !== 'string') {
          warnings.push('Some provider task suggestions were malformed and were ignored.')
          return []
        }
        return [{ account_id: candidate.account_id, message_id: candidate.message_id, title: candidate.title, note: typeof candidate.note === 'string' ? candidate.note : candidate.title, due_at: typeof candidate.due_at === 'number' ? candidate.due_at : null }]
      })
    return { text, sources, tasks, warnings }
  } catch {
    return fallback
  }
}

export function resetAssistantProvider() {
  assistant$.set({ ...DEFAULT_PROVIDER })
}
