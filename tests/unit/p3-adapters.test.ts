import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  claudeAdapter,
  codexAdapter,
  deepseekAdapter,
  detectCommand,
  genericAdapter,
  getAdapter,
  listAdapters,
  parseCommand,
  zcodeAdapter,
} from '@agentcommit/adapters'

describe('P3 agent identity adapters', () => {
  it('parses quoted command groups and empty arguments without shell evaluation', () => {
    expect(parseCommand('"C:\\Program Files\\node.exe" "" "a b" *.txt $HOME')).toEqual({
      command: 'C:\\Program Files\\node.exe',
      args: ['', 'a b', '*.txt', '$HOME'],
    })
  })

  it.each(['', '   ', '"" --version', 'node "unfinished'])(
    'rejects an invalid command string: %j',
    (command) => expect(() => parseCommand(command)).toThrow(),
  )

  it('resolves generic configured commands and appends passthrough arguments', () => {
    expect(genericAdapter.resolveCommand({ command: 'node "agent script.mjs"' }, ['--prompt', 'hello'])).toEqual({
      command: 'node',
      args: ['agent script.mjs', '--prompt', 'hello'],
    })
  })

  it('uses the first passthrough argument as the generic executable when no command is configured', () => {
    expect(genericAdapter.resolveCommand({}, ['node', 'agent.mjs', '--flag'])).toEqual({
      command: 'node',
      args: ['agent.mjs', '--flag'],
    })
    expect(() => genericAdapter.resolveCommand({}, [])).toThrow(/executable/i)
  })

  it('uses Codex and Claude defaults while allowing explicit command overrides', () => {
    expect(codexAdapter.resolveCommand({}, ['run'])).toEqual({ command: 'codex', args: ['run'] })
    expect(claudeAdapter.resolveCommand({}, ['--print'])).toEqual({ command: 'claude', args: ['--print'] })
    expect(codexAdapter.resolveCommand({ command: 'node codex.mjs' }, ['run'])).toEqual({
      command: 'node', args: ['codex.mjs', 'run'],
    })
  })

  it('requires configured launch commands for Z Code and DeepSeek', () => {
    expect(() => zcodeAdapter.resolveCommand({}, [])).toThrow(/configured command/i)
    expect(() => deepseekAdapter.resolveCommand({}, [])).toThrow(/configured command/i)
    expect(zcodeAdapter.resolveCommand({ command: 'node zcode.mjs' }, ['task'])).toEqual({
      command: 'node', args: ['zcode.mjs', 'task'],
    })
  })

  it('keeps the existing registry API and identities', () => {
    expect(listAdapters().map(({ kind }) => kind)).toEqual(['generic', 'codex', 'claude', 'zcode', 'deepseek'])
    expect(getAdapter('codex')).toBe(codexAdapter)
    expect(getAdapter('missing')).toBeUndefined()
  })

  it('runs a bounded real argv version probe without shell interpretation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentcommit-adapter-'))
    const script = path.join(root, 'version probe.mjs')
    writeFileSync(script, 'console.log("synthetic-agent 1.2.3")\n')

    const result = await detectCommand({ command: process.execPath, args: [script] }, process.env)

    expect(result.found).toBe(true)
    expect(result.command).toBe(process.execPath)
    expect(result.version).toBe('synthetic-agent 1.2.3')
  })

  it('reports an unavailable executable without launching a shell', async () => {
    const result = await detectCommand({ command: 'agentcommit-definitely-missing', args: [] }, process.env)
    expect(result.found).toBe(false)
    expect(result.version).toBeUndefined()
  })

  it('distinguishes an executable with an unsupported version flag from a missing command', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentcommit-adapter-'))
    const script = path.join(root, 'unsupported-version.mjs')
    writeFileSync(script, 'process.exit(2)\n')
    const result = await detectCommand({
      command: process.execPath,
      args: [script],
    }, process.env)
    expect(result.found).toBe(true)
    expect(result.version).toBeUndefined()
    expect(result.notes).toEqual(['Version probe exited with code 2'])
  })

  it('does not claim automatic detection for configurable-only adapters', async () => {
    await expect(zcodeAdapter.detect(process.env)).resolves.toMatchObject({ found: false })
    await expect(deepseekAdapter.detect(process.env)).resolves.toMatchObject({ found: false })
  })
})
