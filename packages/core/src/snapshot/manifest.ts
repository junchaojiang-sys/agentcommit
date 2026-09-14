import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { ScanResult } from './scanner.js'
import {
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type ProtectionPolicySnapshot,
  type ProtectionSummary,
} from './types.js'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { atomicWriteJson, readJson } from '../storage/atomic.js'
import { manifestPath } from '../storage/paths.js'

export interface BuildManifestInput {
  workspaceId: string
  sessionId: string
  /** Frozen protection policy captured at pre-snapshot (Blocker 1). */
  protectionPolicy: ProtectionPolicySnapshot
  maxFileSizeBytes: number
  scan: ScanResult
  /** Injectable for tests; defaults to now. */
  createdAt?: string
  /** Injectable for tests; defaults to a random UUID. */
  id?: string
}

/** Assemble the immutable pre-manifest (docs/TRANSACTION_MODEL §1–2). */
export function buildManifest(input: BuildManifestInput): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    protectionPolicy: input.protectionPolicy,
    maxFileSizeBytes: input.maxFileSizeBytes,
    files: input.scan.files,
    ignored: input.scan.ignored,
    stats: input.scan.stats,
  }
}

export function persistManifest(
  stateRoot: string,
  workspaceId: string,
  manifest: Manifest,
): void {
  atomicWriteJson(manifestPath(stateRoot, workspaceId, manifest.id), manifest)
}

/** Load + integrity-check a persisted manifest (schema version enforced). */
export function loadManifest(
  stateRoot: string,
  workspaceId: string,
  manifestId: string,
): Manifest {
  const p = manifestPath(stateRoot, workspaceId, manifestId)
  if (!existsSync(p)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Manifest not found: ${manifestId}`)
  }
  let manifest: Manifest
  try {
    manifest = readJson<Manifest>(p)
  } catch (error) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Manifest is not valid JSON: ${p}`,
      { cause: error },
    )
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Unsupported manifest schema version ${String(manifest.schemaVersion)}: ${p}`,
    )
  }
  if (
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.ignored) ||
    typeof manifest.protectionPolicy !== 'object' ||
    manifest.protectionPolicy === null
  ) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Manifest failed an integrity check (files/ignored/policy): ${p}`,
    )
  }
  if (manifest.protectionPolicy.schemaVersion !== 1) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Manifest carries an unsupported protection policy schema: ${p}`,
    )
  }
  return manifest
}

/**
 * Structured Protection Summary data (docs/TRANSACTION_MODEL §4). Phase 1
 * produces the data model only; interactive CLI rendering lands in Phase 3.
 * Nothing unprotected is ever silent: every unprotected path is listed with
 * its reason.
 */
export function buildProtectionSummary(manifest: Manifest): ProtectionSummary {
  const unprotectedPaths = manifest.files
    .filter((record) => !record.protected)
    .map((record) => ({
      path: record.path,
      reason: record.reasonUnprotected ?? ('unsupported-special-file' as const),
      size: record.size,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const ignoredBoundaries = [...manifest.ignored].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )

  return {
    protectedFiles: manifest.stats.protectedFiles,
    ignoredEntries: manifest.stats.ignoredEntries,
    ignoredBoundaries,
    symlinks: manifest.stats.symlinks,
    unreadableEntries: manifest.stats.unreadableEntries,
    unprotectedPaths,
    byReason: manifest.stats.byReason,
  }
}
