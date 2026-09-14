import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { persistencePaths } from '../runtime/transaction.mjs';
import { listAttempts } from './store.mjs';
import { ATS_MATURITY } from './ats.mjs';
import { record } from '../runtime/util.mjs';

function readEvents(target) {
  const path = join(persistencePaths(target).runtimeDir, 'applications', 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** Funnel analytics over attempt state + the append-only event log. */
export function applicationAttemptAnalytics(target) {
  const attempts = listAttempts(target);
  const events = readEvents(target);
  const by_state = {};
  const by_ats = {};
  const blockers = {};
  for (const attempt of attempts) {
    by_state[attempt.state] = (by_state[attempt.state] || 0) + 1;
    by_ats[attempt.ats || 'unknown'] = (by_ats[attempt.ats || 'unknown'] || 0) + 1;
    for (const blocker of attempt.blockers || []) {
      const code = blocker?.code || 'UNKNOWN';
      blockers[code] = (blockers[code] || 0) + 1;
    }
  }
  const event_types = {};
  for (const event of events) {
    const type = event.type || event.schema || 'UNKNOWN';
    event_types[type] = (event_types[type] || 0) + 1;
  }
  const submitted = by_state.SUBMITTED || 0;
  const ready = by_state.READY_TO_SUBMIT || 0;
  const queued = by_state.QUEUED || 0;
  const review = by_state.NEEDS_REVIEW || 0;
  const conversion = {
    queued_to_ready: queued + ready + submitted > 0
      ? Number(((ready + submitted) / (queued + ready + submitted + review || 1)).toFixed(3))
      : 0,
    ready_to_submitted: ready + submitted > 0
      ? Number((submitted / (ready + submitted)).toFixed(3))
      : 0,
  };
  return record('ApplicationAttemptAnalyticsV1', {
    attempt_count: attempts.length,
    event_count: events.length,
    by_state,
    by_ats,
    top_blockers: Object.entries(blockers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([code, count]) => ({ code, count })),
    event_types,
    conversion,
    ats_maturity: ATS_MATURITY,
  });
}
