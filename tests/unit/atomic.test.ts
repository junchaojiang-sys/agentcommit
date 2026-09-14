import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJson } from '@agentcommit/core'
import { makeTempDir } from '../helpers.js'

describe('atomic metadata writes (temp → validate → atomic replace)', () => {
  it('writes and reads back JSON', () => {
    const file = path.join(makeTempDir(), 'nested', 'dir', 'data.json')
    const value = { hello: 'world', nested: { list: [1, 2, 3] } }
    atomicWriteJson(file, value)
    expect(readJson<typeof value>(file)).toEqual(value)
  })

  it('atomically replaces an existing file', () => {
    const file = path.join(makeTempDir(), 'data.json')
    atomicWriteJson(file, { v: 1 })
    atomicWriteJson(file, { v: 2 })
    expect(readJson<{ v: number }>(file).v).toBe(2)
    // no temp litter left behind
    const dir = path.dirname(file)
    expect(readFileSync(file, 'utf8')).toContain('"v": 2')
    expect(existsSync(path.join(dir, '.data.json.tmp-0'))).toBe(false)
  })

  it('serialization failure leaves the target untouched', () => {
    const file = path.join(makeTempDir(), 'data.json')
    atomicWriteJson(file, { v: 1 })
    const before = readFileSync(file, 'utf8')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => atomicWriteJson(file, circular)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
