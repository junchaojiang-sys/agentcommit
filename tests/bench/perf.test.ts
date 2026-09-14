import { describe, expect, it } from 'vitest'
import { createPreSnapshot, initializeWorkspace } from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

/**
 * Perf smoke (not a strict CI gate): a few hundred small files across nested
 * directories plus one multi-MB file must complete comfortably. Logs real
 * timings for the P1 report; the assertion is intentionally loose.
 */
describe('scan performance smoke', () => {
  // Allow fixture setup plus the existing 60s scan budget under parallel I/O.
  it('scans a 600-file workspace with a 5 MB file in reasonable time', { timeout: 90_000 }, async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)

    const files: Record<string, string> = {}
    for (let dir = 0; dir < 30; dir++) {
      for (let file = 0; file < 20; file++) {
        files[`pkg/module-${dir}/src/file-${file}.ts`] = `export const n = ${dir * 20 + file};\n`
      }
    }
    const bigChunk = 'x'.repeat(1024) // 1 KiB x 5120 = 5 MB
    files['assets/big.bin'] = bigChunk.repeat(5 * 1024)
    writeTree(ws, files)

    const started = Date.now()
    const { manifest, summary } = await createPreSnapshot({
      workspaceRoot: ws,
      stateRoot: makeStateRoot(makeTempDir()),
    })
    const elapsedMs = Date.now() - started

    console.log(
      `[perf] files=${manifest.files.length} bytes≈${Math.round(5 * 1024 + 12 * 600)}B ` +
        `scan+snapshot=${elapsedMs}ms unprotected=${summary.unprotectedPaths.length}`,
    )
    expect(manifest.files.length).toBe(603) // 600 generated + assets/big.bin + 2 init files
    expect(elapsedMs).toBeLessThan(60_000)
  })
})
