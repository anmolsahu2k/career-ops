import { atsFor } from './ats.mjs';
import { scoreOf, diagnoseTrackerRows } from './eligibility.mjs';
import { listAttempts } from './store.mjs';
import { record } from '../runtime/util.mjs';

/**
 * Operator-facing enqueue preview: true eligibles, near-misses (e.g. missing
 * APPLY token), and existing attempt states grouped by blocker.
 */
export function applicationQueuePreview(target) {
  const diagnosed = diagnoseTrackerRows(target);
  const eligible = diagnosed.filter(item => item.eligible);
  const near_misses = diagnosed.filter(item => item.near_miss);
  const blocked = diagnosed.filter(item => !item.eligible && !item.near_miss);
  const attempts = listAttempts(target);
  const by_blocker = {};
  for (const item of [...near_misses, ...blocked]) {
    const code = item.blocker || 'UNKNOWN';
    by_blocker[code] = (by_blocker[code] || 0) + 1;
  }
  for (const attempt of attempts) {
    const code = `EXISTING_${attempt.state}`;
    by_blocker[code] = (by_blocker[code] || 0) + 1;
  }
  const lines = [
    `Eligible to enqueue: ${eligible.length}`,
    `Near-miss (fix Notes / URL): ${near_misses.length}`,
    `Other ineligible: ${blocked.length}`,
    `Existing attempts: ${attempts.length}`,
  ];
  if (Object.keys(by_blocker).length) {
    lines.push('Blocker histogram:');
    for (const [code, count] of Object.entries(by_blocker).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${code}: ${count}`);
    }
  }
  for (const item of near_misses.slice(0, 15)) {
    lines.push(
      `  #${item.row.num} ${item.row.company} — ${item.blocker}`
      + (item.canonical_url ? ` (${atsFor(item.canonical_url)})` : '')
      + (Number.isFinite(scoreOf(item.row.score)) ? ` score=${scoreOf(item.row.score)}` : ''),
    );
  }
  for (const item of eligible.slice(0, 15)) {
    lines.push(`  #${item.row.num} READY ${item.row.company} → ${item.canonical_url}`);
  }
  return record('ApplicationEnqueuePreviewV1', {
    eligible_count: eligible.length,
    eligible: eligible.map(item => ({
      tracker_number: item.row.num,
      company: item.row.company,
      role: item.row.role,
      score: item.row.score,
      canonical_url: item.canonical_url,
      ats: item.canonical_url ? atsFor(item.canonical_url) : null,
      resume_hint: /\bsubmit\s+mle\s+resume\b/i.test(item.row.notes || '') ? 'mle'
        : /\bsubmit\s+sde\s+resume\b/i.test(item.row.notes || '') ? 'sde' : null,
    })),
    near_misses: near_misses.map(item => ({
      tracker_number: item.row.num,
      company: item.row.company,
      role: item.row.role,
      score: item.row.score,
      blocker: item.blocker,
      detail: item.detail || '',
      canonical_url: item.canonical_url || null,
    })),
    blocked: blocked.map(item => ({
      tracker_number: item.row.num,
      blocker: item.blocker,
      detail: item.detail || '',
    })),
    by_blocker,
    human_summary: lines.join('\n'),
  });
}
