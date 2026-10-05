import { describe, expect, it } from 'bun:test'
import { filterCommands, matchesCommand } from './paletteCommands'

describe('localized command matching', () => {
  const command = { label: 'Configuración de tipografía', keywords: 'tamaño fuente typography font' }
  it('folds accents and compatibility characters while preserving words and shortcuts', () => {
    for (const query of [
      '',
      '   ',
      'CONFIGURACIÓN',
      'configuracion',
      'tipografi\u0301a',
      'tamaño',
      'font',
      'ｆｏｎｔ',
      'ctg',
    ])
      expect(matchesCommand(command, query)).toBe(true)
  })
  it('never treats unsupported scripts, punctuation or combining marks as an empty wildcard', () => {
    for (const query of ['中文', '日本語', 'العربية', '😀', '!!!', '\u0301', 'я', 'zzz'])
      expect(matchesCommand(command, query)).toBe(false)
  })
  it('matches native script and meaningful literal symbols only when present', () => {
    expect(matchesCommand({ label: '日本語の設定' }, '日本語')).toBe(true)
    expect(matchesCommand({ label: 'Почта' }, 'поч')).toBe(true)
    expect(matchesCommand({ label: 'Project 🚀' }, '🚀')).toBe(true)
  })
  it('ranks a visible matching label above a fuzzy match without losing stable ties', () => {
    const entries = [command, { label: 'Firma' }, { label: 'Firma de cuenta' }]
    expect(filterCommands(entries, 'firma').map((item) => item.label)).toEqual([
      'Firma',
      'Firma de cuenta',
      command.label,
    ])
  })
})
