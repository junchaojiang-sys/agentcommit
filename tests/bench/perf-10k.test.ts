import { describe, expect, it } from 'vitest'
import { createPreSnapshot, initializeWorkspace } from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

/**
 * Recorded baseline benchmark (non-blocking, per P1 rectification §6):
 * 10,000 small files — scan + hash + CAS + manifest. No aggressive gate;
 * the assertion only guards against pathological regressions.
 */
describe('scan performance baseline (10,000 small files)', () => {
  it('records scan+hash+CAS+manifest time for 10k files', { timeout: 300_000 }, async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)

    const files: Record<string, string> = {}
    for (let dir = 0; dir < 100; dir++) {
      for (let file = 0; file < 100; file++) {
        files[`pkg/module-${dir}/src/file-${file}.ts`] =
          `export const value = ${dir * 100 + file};\n`
      }
    }
    writeTree(ws, files)

    const started = Date.now()
    const { manifest } = await createPreSnapshot({
      workspaceRoot: ws,
      stateRoot: makeStateRoot(makeTempDir()),
    })
    const elapsedMs = Date.now() - started

    console.log(
      `[perf-10k] files=${manifest.files.length} total=${elapsedMs}ms ` +
        `avg=${(elapsedMs / manifest.files.length).toFixed(2)}ms/file`,
    )
    expect(manifest.files.length).toBe(10002) // 10,000 generated + 2 init files
    expect(elapsedMs).toBeLessThan(120_000)
  })
})
