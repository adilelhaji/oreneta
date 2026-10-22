import { describe, expect, it } from 'bun:test'
import { COMMAND_AREAS, filterCommands, groupCommandsByArea, matchesCommand, type CommandArea } from './paletteCommands'

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

describe('the areas of the app menu (#343)', () => {
  const command = (id: string, area: CommandArea, kind?: 'setting') => ({ id, area, kind })
  it('groups the commands in the order of the areas, each once, in their order inside an area', () => {
    const commands = [
      command('settings.section.appearance', 'settings', 'setting'),
      command('compose.new', 'mail'),
      command('theme.dark', 'theme'),
      command('module.calendar', 'modules'),
      command('mail.sync', 'mail'),
      command('settings.open', 'settings'),
      command('app.about', 'app'),
      command('theme.light', 'theme'),
    ]
    const groups = groupCommandsByArea(commands)
    expect(groups.map((group) => group.area)).toEqual(['modules', 'mail', 'theme', 'settings', 'app'])
    expect(groups.map((group) => group.commands.map((item) => item.id))).toEqual([
      ['module.calendar'],
      ['compose.new', 'mail.sync'],
      ['theme.dark', 'theme.light'],
      // The action before the sections it can open, whatever the list's order.
      ['settings.open', 'settings.section.appearance'],
      ['app.about'],
    ])
    expect(groups.flatMap((group) => group.commands)).toHaveLength(commands.length)
  })
  it('leaves out an area with no command, and keeps an order for every area', () => {
    expect(groupCommandsByArea([])).toEqual([])
    expect(new Set(COMMAND_AREAS).size).toBe(COMMAND_AREAS.length)
    expect(COMMAND_AREAS[0]).toBe('modules')
  })
})
