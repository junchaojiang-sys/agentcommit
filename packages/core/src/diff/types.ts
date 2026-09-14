import type { FileRecordType } from '../snapshot/types.js'

export const ChangeKinds = {
  /** Absent pre, present post. */
  Created: 'created',
  /** Present pre and post and comparable, and they differ. */
  Modified: 'modified',
  /** Present pre, absent post. */
  Deleted: 'deleted',
  /** Same content hash / link target, mode or other in-scope metadata differs. */
  MetadataOnly: 'metadata-only',
  /** Entry kind changed between pre and post (e.g. file -> symlink). */
  TypeChanged: 'type-changed',
} as const

export type ChangeKind = (typeof ChangeKinds)[keyof typeof ChangeKinds]

/** One side of a compared path, taken from a manifest FileRecord. */
export interface ChangeSide {
  type: FileRecordType
  /** SHA-256 of content (regular files only). */
  hash?: string
  /** Link target (links only). */
  symlinkTarget?: string
  size: number
  /** False when the side was not protectable (oversized/inaccessible/...). */
  protected: boolean
}

export const ChangeAssessments = {
  /** Fully comparable; a read-only restore action can be planned. */
  Ready: 'ready',
  /** A protection capability gap (e.g. post side oversized/inaccessible). */
  CapabilityGap: 'capability-gap',
  /** Restore policy pending a product decision (mode restore is OQ-07, approved and implemented). */
  RequiresDecision: 'requires-decision',
} as const

export type ChangeAssessment = (typeof ChangeAssessments)[keyof typeof ChangeAssessments]

/** One compared workspace path (unchanged paths are only counted, not listed). */
export interface Change {
  path: string
  kind: ChangeKind
  pre?: ChangeSide
  post?: ChangeSide
  assessment: ChangeAssessment
  /** Human-readable detail, e.g. 'post-unprotected', 'mode-only (OQ-07 pending)'. */
  note?: string
}

/** Deterministic Pre/Post comparison result (schema v1). */
export interface ChangeSet {
  schemaVersion: 1
  preManifestRef: string
  postManifestRef: string
  /** Changed paths, sorted by path (code-unit order). */
  entries: Change[]
  /** Paths present on both sides with no in-scope difference. */
  unchangedCount: number
}
