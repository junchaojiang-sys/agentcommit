import type { Change, ChangeSet, ChangeSide } from './types.js'
import { ChangeAssessments, ChangeKinds } from './types.js'
import type { FileRecord, Manifest } from '../snapshot/types.js'

function toSide(record: FileRecord): ChangeSide {
  return {
    type: record.type,
    hash: record.hash,
    symlinkTarget: record.symlinkTarget,
    size: record.size,
    protected: record.protected,
  }
}

/**
 * Deterministic Pre/Post comparison (P2-A). Both manifests must belong to the
 * same workspace, session and frozen policy — callers enforce the binding.
 * Output is sorted by path (code-unit order); identical inputs give identical
 * ChangeSets. No rename inference, no merging, no content interpretation.
 */
export function compareManifests(pre: Manifest, post: Manifest): ChangeSet {
  const preByPath = new Map(pre.files.map((f) => [f.path, f]))
  const postByPath = new Map(post.files.map((f) => [f.path, f]))
  const paths = new Set<string>([...preByPath.keys(), ...postByPath.keys()])
  const entries: Change[] = []
  let unchangedCount = 0

  for (const path of [...paths].sort()) {
    const preRec = preByPath.get(path)
    const postRec = postByPath.get(path)

    if (preRec && !postRec) {
      // A path that vanished from the scan: only a clean absence (Post saw the
      // tree and the entry is gone) is a deletion. An unprotected/failed post
      // observation is a capability gap, never a deletion.
      entries.push({
        path,
        kind: ChangeKinds.Deleted,
        pre: toSide(preRec),
        assessment: preRec.protected
          ? ChangeAssessments.Ready
          : ChangeAssessments.CapabilityGap,
        note: preRec.protected ? undefined : 'pre-side-unprotected',
      })
      continue
    }
    if (!preRec && postRec) {
      entries.push({
        path,
        kind: ChangeKinds.Created,
        post: toSide(postRec),
        assessment: postRec.protected
          ? ChangeAssessments.Ready
          : ChangeAssessments.CapabilityGap,
        note: postRec.protected ? undefined : 'post-side-unprotected',
      })
      continue
    }
    if (preRec && postRec) {
      const a = toSide(preRec)
      const b = toSide(postRec)
      if (a.type !== b.type) {
        entries.push({
          path,
          kind: ChangeKinds.TypeChanged,
          pre: a,
          post: b,
          assessment: ChangeAssessments.CapabilityGap,
          note: 'type-changed — no safe automatic plan',
        })
        continue
      }
      if (a.type === 'file' && a.hash === b.hash) {
        // Content identical; rwx-bit metadata differences are OQ-07 (approved):
        // recognized AND restorable. Only regular-file rwx is in scope; other
        // metadata (ownership/xattrs/ADS/mtime) is out of scope.
        if ((preRec.mode ?? 0) !== (postRec.mode ?? 0)) {
          entries.push({
            path,
            kind: ChangeKinds.MetadataOnly,
            pre: a,
            post: b,
            assessment: ChangeAssessments.Ready,
            note: 'mode-only change',
          })
        } else {
          unchangedCount++
        }
        continue
      }
      if (a.type === 'file' && a.hash !== b.hash) {
        // Content modified. If either side lost protection (e.g. Post grew past
        // the cap or became inaccessible), we cannot safely compare Current
        // against Post later — capability gap, blocked from planning.
        const gap = !preRec.protected || !postRec.protected
        entries.push({
          path,
          kind: ChangeKinds.Modified,
          pre: a,
          post: b,
          assessment: gap ? ChangeAssessments.CapabilityGap : ChangeAssessments.Ready,
          note: gap ? 'post-side-unprotected-or-inaccessible' : undefined,
        })
        continue
      }
      if ((a.type === 'symlink' || a.type === 'junction') && a.symlinkTarget !== b.symlinkTarget) {
        entries.push({
          path,
          kind: ChangeKinds.Modified,
          pre: a,
          post: b,
          assessment: ChangeAssessments.Ready,
          note: 'link-target-changed',
        })
        continue
      }
      // Links with identical targets, unsupported types identical, etc.
      unchangedCount++
      continue
    }
  }

  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return {
    schemaVersion: 1,
    preManifestRef: pre.id,
    postManifestRef: post.id,
    entries,
    unchangedCount,
  }
}

export { ChangeKinds }
