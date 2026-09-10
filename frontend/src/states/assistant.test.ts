import { beforeEach, describe, expect, it } from 'bun:test'
import { assistant$, hydrateAssistant, parseAssistantResponse, resetAssistantProvider, sanitizeAssistantConfig } from './assistant'

describe('assistant provider state', () => {
  beforeEach(() => {
    resetAssistantProvider()
  })

  it('keeps only local or remote provider configurations', () => {
    expect(sanitizeAssistantConfig({ mode: 'remote', endpoint: ' https://ai.example.test ', model: ' model ' })).toEqual({
      mode: 'remote',
      endpoint: 'https://ai.example.test',
      model: 'model',
    })
    expect(sanitizeAssistantConfig({ mode: 'hosted', endpoint: 'https://ai.example.test', model: 'model' })).toBeNull()
    expect(sanitizeAssistantConfig({ mode: 'local', endpoint: 42, model: 'model' })).toBeNull()
  })

  it('hydrates persisted provider settings without accepting unknown modes', () => {
    hydrateAssistant({ assistant_mode: 'remote', assistant_endpoint: 'https://ai.example.test', assistant_model: 'model' })
    expect(assistant$.get()).toEqual({ mode: 'remote', endpoint: 'https://ai.example.test', model: 'model' })
    hydrateAssistant({ assistant_mode: 'hosted', assistant_endpoint: 'https://evil.test', assistant_model: 'x' })
    expect(assistant$.get()).toEqual({ mode: 'remote', endpoint: 'https://ai.example.test', model: 'model' })
  })

  it('parses source-linked results and ignores malformed suggestions', () => {
    expect(parseAssistantResponse(JSON.stringify({
      text: 'Summary',
      sources: [{ account_id: 'a1', message_id: 'm1' }, { account_id: 1, message_id: 'bad' }],
      tasks: [{ account_id: 'a1', message_id: 'm1', title: 'Call back', note: 'Today', due_at: 1 }, { title: 42 }],
    }))).toEqual({
      text: 'Summary',
      sources: [{ account_id: 'a1', message_id: 'm1' }],
      tasks: [{ account_id: 'a1', message_id: 'm1', title: 'Call back', note: 'Today', due_at: 1 }],
      warnings: ['Some provider sources were malformed and were ignored.', 'Some provider task suggestions were malformed and were ignored.'],
    })
    expect(parseAssistantResponse('plain provider response')).toEqual({ text: 'plain provider response', sources: [], tasks: [], warnings: [] })
  })
})
