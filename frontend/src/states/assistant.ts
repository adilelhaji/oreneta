import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type AssistantMode = 'local' | 'remote'
export type AssistantAction = 'summary' | 'draft' | 'task_suggestion'

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
  authorization?: string,
  provider: AssistantProviderConfig = assistant$.get(),
) {
  return invoke<{ prepared: AssistantPreview; response: string; persisted: false }>('assistant.execute', {
    provider,
    action,
    context,
    confirmed,
    preview_token: previewToken,
    ...(authorization?.trim() ? { authorization: authorization.trim() } : {}),
  })
}

export function resetAssistantProvider() {
  assistant$.set({ ...DEFAULT_PROVIDER })
}
