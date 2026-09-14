/**
 * Deferred cleanup surface: explicitly excluded by the user's P3 scope decision.
 */
export function notImplemented(command: string): void {
  console.error(
    `NOT_IMPLEMENTED: agentcommit ${command} is disabled in P3. ` +
      `Safe global cleanup requires separate authorization; no state was deleted.`,
  )
  process.exitCode = 2
}
