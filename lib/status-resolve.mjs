// lib/status-resolve.mjs — which Status survives a re-evaluation.
//
// merge-tracker.mjs used to always keep the existing row's Status on an update,
// writing the new score beside the old status. That is right for a row the user
// has acted on, but wrong when the score moves enough to invalidate the earlier
// judgement: on 2026-07-31 Palantir "Software Engineer, New Grad" was re-scored
// 2.3 -> 4.2 and stayed `Discarded`, so an apply-tier role became invisible in
// the apply queue.

/**
 * Statuses that record something that happened in the real world. A
 * re-evaluation is a change of opinion and must never erase one of these:
 * an application really was submitted, a recruiter really did reply.
 */
export const PROGRESS_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected']);

/** Pre-apply statuses: our own assessment, safe to revise. */
export const ASSESSMENT_STATUSES = new Set(['Evaluated', 'Discarded', 'Purged', 'Rejected-at-eval', 'SKIP']);

/** Score at or above which a role belongs in the apply queue. */
export const APPLY_TIER = 4.0;

/**
 * Decide the Status for an updated row.
 *
 * Rules, in order:
 *  1. A progress status always wins. Facts outrank re-scores.
 *  2. Otherwise the new status is adopted only if the re-score crossed the
 *     apply-tier boundary in either direction. That is the operationally
 *     meaningful definition of "material": it changes whether the row belongs
 *     in the apply queue. A 3.0 -> 3.8 move does not, so the old status stands.
 *  3. Unknown or unparseable scores never count as a crossing.
 *
 * @returns {{status: string, changed: boolean, reason: string}}
 */
export function resolveStatus(oldStatus, newStatus, oldScore, newScore) {
  const keep = (reason) => ({ status: oldStatus, changed: false, reason });

  if (PROGRESS_STATUSES.has(oldStatus)) return keep(`${oldStatus} records a real-world action`);
  if (!newStatus || newStatus === oldStatus) return keep('new status matches existing');
  if (!ASSESSMENT_STATUSES.has(oldStatus)) return keep(`${oldStatus} is not a revisable assessment`);
  if (!Number.isFinite(oldScore) || !Number.isFinite(newScore)) return keep('score not comparable');

  const wasApplyTier = oldScore >= APPLY_TIER;
  const isApplyTier = newScore >= APPLY_TIER;
  if (wasApplyTier === isApplyTier) {
    return keep(`re-score ${oldScore} to ${newScore} did not cross the ${APPLY_TIER} apply-tier line`);
  }
  return {
    status: newStatus,
    changed: true,
    reason: `re-score ${oldScore} to ${newScore} crossed the ${APPLY_TIER} apply-tier line`,
  };
}
