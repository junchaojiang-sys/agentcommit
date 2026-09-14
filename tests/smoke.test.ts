import { describe, expect, it } from 'vitest'
import {
  AGENT_KINDS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  ErrorCodes,
  SessionStatus,
} from '@agentcommit/core'
import { getAdapter, listAdapters } from '@agentcommit/adapters'

describe('phase 0 skeleton (spec-as-code)', () => {
  it('exposes the frozen session state machine values', () => {
    expect(Object.values(SessionStatus)).toEqual([
      'ready',
      'snapshot',
      'running',
      'review',
      'committed',
      'rolled_back',
      'rollback_failed',
      'failed',
      // P4 crashed-running disposition, user-confirmed D1 (20260909): explicit
      // operator decision to stop tracking an interrupted session; evidence kept.
      'abandoned',
    ])
  })

  it('pins the frozen V0.1 defaults', () => {
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024)
    expect(DEFAULT_IGNORE_PATTERNS).toContain('.git/**')
    expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/**')
    expect(AGENT_KINDS).toEqual(['generic', 'codex', 'claude', 'zcode', 'deepseek'])
  })

  it('exposes stable error codes', () => {
    expect(ErrorCodes.Conflict).toBe('CONFLICT')
    expect(ErrorCodes.BlobMissing).toBe('BLOB_MISSING')
    expect(ErrorCodes.BlobCorrupt).toBe('BLOB_CORRUPT')
  })

  it('lists the five adapter kinds with generic as the floor', () => {
    expect(listAdapters().map((a) => a.kind)).toEqual([
      'generic',
      'codex',
      'claude',
      'zcode',
      'deepseek',
    ])
    expect(getAdapter('deepseek')?.displayName).toBe('DeepSeek')
    expect(getAdapter('unknown-agent')).toBeUndefined()
  })
})
