import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@agentcommit/core': path.resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@agentcommit/adapters': path.resolve(import.meta.dirname, 'packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    // Several integration files rebuild packages/*/dist in beforeAll; running test
    // FILES in parallel lets one worker import a half-written dist (torn ESM
    // module). Serializing files removes the race (tests within a file still run
    // in parallel where safe).
    fileParallelism: false,
  },
})
