/** A cache refresh must retry the same conversation/model; never switch provider. */
export function warmFailure(failures: number, now: number): { failures: number; retryAt: number; stop: boolean } {
  const count = failures + 1
  return { failures: count, retryAt: now + 20_000, stop: count >= 3 }
}
