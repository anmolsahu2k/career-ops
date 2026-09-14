/**
 * Human-facing progress and summary for `career-ops evaluate`.
 * Machine JSON remains available via --json / non-TTY stdout / --out.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function color(enabled, code, text) {
  return enabled ? `${code}${text}${RESET}` : text;
}

export function progressBar(done, total, width = 20) {
  const safeTotal = Math.max(Number(total) || 0, 0);
  const safeDone = Math.min(Math.max(Number(done) || 0, 0), safeTotal || 0);
  if (!safeTotal) return `[${'·'.repeat(width)}]   0%`;
  const ratio = safeDone / safeTotal;
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(width - filled, 0))}`;
  return `[${bar}] ${String(Math.round(ratio * 100)).padStart(3)}%`;
}

/** Prefer host + short path so the progress line never wraps the terminal. */
export function shortTarget(url, max = 36) {
  try {
    const parsed = new URL(String(url || ''));
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/$/, '') : '';
    const compact = `${parsed.hostname}${path}`;
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max - 1)}…`;
  } catch {
    const text = String(url || '');
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  }
}

function stageLabel(stage) {
  if (stage === 'liveness') return 'Liveness';
  if (stage === 'evaluate') return 'Evaluate';
  return String(stage || 'Progress');
}

/**
 * Single-line progress suitable for \r redraws.
 * Never includes a raw URL long enough to wrap (that caused …pLiveness junk).
 */
export function formatEvaluateProgress(progress, {
  tty = false,
  columns = Number(process.stderr?.columns) || 80,
} = {}) {
  const stage = progress?.stage || 'progress';
  const done = Number(progress?.done ?? progress?.completed ?? 0);
  const total = Number(progress?.total ?? 0);
  const label = stageLabel(stage);
  const verdict = progress?.result ? ` ${progress.result}` : '';
  const detail = progress?.url
    ? shortTarget(progress.url, 32)
    : progress?.company
      ? String(progress.company).slice(0, 24)
      : '';
  // Keep the whole logical line under the terminal width so \r cannot leave
  // wrapped leftovers that look like "ashbyhq.com/pLiveness".
  const maxWidth = Math.max(40, Math.min(Number(columns) || 80, 100) - 1);
  const barWidth = Math.max(10, Math.min(20, maxWidth - 36));
  const bar = progressBar(done, total, barWidth);
  let body = `${label} ${bar} ${done}/${total || '?'}${verdict}`;
  if (detail) body = `${body}  ${detail}`;
  if (body.length > maxWidth) body = `${body.slice(0, maxWidth - 1)}…`;
  if (!tty) return body;
  // Erase the full current line, then rewrite from column 0.
  return `\x1b[2K\r${body}`;
}

function decisionLabel(decision, colorize) {
  const value = String(decision || '').toUpperCase();
  if (value === 'APPLY' || value === 'YES') return color(colorize, GREEN, value || 'APPLY');
  if (value === 'CONSIDER' || value === 'UNKNOWN') return color(colorize, YELLOW, value || 'CONSIDER');
  if (value === 'NO' || value === 'DO_NOT_APPLY' || value === 'REJECT') return color(colorize, RED, value || 'NO');
  return value || '—';
}

function statusLabel(status, colorize) {
  const value = String(status || '');
  if (value === 'COMMITTED') return color(colorize, GREEN, value);
  if (value === 'PLAN' || value === 'EMPTY') return color(colorize, CYAN, value);
  if (value === 'FETCH_FAILED' || value === 'FAILED') return color(colorize, RED, value);
  if (value === 'COMPLETED') return color(colorize, GREEN, value);
  return value;
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function reasonHistogram(items, limit = 8) {
  const counts = new Map();
  for (const item of items || []) {
    const reason = String(item?.reason || 'unknown').replace(/\s+/g, ' ').trim();
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

/**
 * Build a human-readable multi-line summary for EvaluateScanResultV1.
 */
export function formatEvaluateSummary(result, { colorize = false } = {}) {
  const lines = [];
  const status = result?.status || 'UNKNOWN';
  const liveness = result?.liveness || {};
  const candidates = Number(result?.candidate_count || 0);
  const files = Array.isArray(result?.files) ? result.files : [];

  lines.push(color(colorize, BOLD, 'Career-Ops evaluate'));
  lines.push(color(colorize, DIM, '─'.repeat(56)));
  lines.push(`Status:     ${statusLabel(status, colorize)}`);
  if (result?.provider_id) lines.push(`Provider:   ${result.provider_id}`);
  lines.push(`Mode:       ${result?.apply ? 'apply (writes reports + tracker)' : 'plan (prune + save eval queue)'}`);
  if (result?.source) {
    lines.push(`Source:     ${result.source === 'queue' ? 'eval queue only' : 'scan-results triage'}`);
  }
  lines.push(`Candidates: ${candidates}`);
  if (result?.queue_path) lines.push(`Queue file: ${result.queue_path}`);
  if (files.length) {
    lines.push(`Files:      ${files.length === 1 ? files[0] : `${files.length} scan-results TSV(s)`}`);
  }

  const gates = result?.gates || {};
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  lines.push('');
  lines.push(color(colorize, BOLD, 'Pre-filters'));
  lines.push(`  candidate record  ${gates.candidate_record
    ? color(colorize, GREEN, 'loaded (CV + profile sent as trusted evidence)')
    : color(colorize, RED, 'MISSING — fit scores are not anchored to your CV')}`);
  const byCode = new Map();
  for (const item of skipped) byCode.set(item.code, (byCode.get(item.code) || 0) + 1);
  const dropCount = code => byCode.get(code) || 0;
  if (gates.entry_level_only) {
    lines.push(`  level filter      ${color(colorize, GREEN, 'entry-level only')}  ${color(colorize, DIM, `(${dropCount('LEVEL_MISMATCH')} dropped)`)}`);
  } else {
    lines.push(`  level filter      ${color(colorize, DIM, 'off (--allow-senior or no profile level band)')}`);
  }
  lines.push(`  geography filter  ${gates.us_only
    ? `${color(colorize, GREEN, 'US-eligible only')}  ${color(colorize, DIM, `(${dropCount('GEOGRAPHY_INELIGIBLE')} dropped)`)}`
    : color(colorize, DIM, 'off (no geography constraint in profile)')}`);
  if (gates.max_age_days) lines.push(`  max posting age   ${gates.max_age_days} days`);
  if (gates.liveness_cache_hits) {
    lines.push(`  liveness cache    ${gates.liveness_cache_hits} reused ${color(colorize, DIM, '(use --refresh-liveness to re-probe)')}`);
  }

  lines.push('');
  lines.push(color(colorize, BOLD, 'Liveness gate'));
  lines.push(`  active     ${liveness.active ?? 0}`);
  lines.push(`  uncertain  ${liveness.uncertain ?? 0}  ${color(colorize, DIM, '(kept for eval, flagged in Notes)')}`);
  lines.push(`  expired    ${liveness.expired ?? 0}  ${color(colorize, DIM, '(dropped, not scored)')}`);

  if (skipped.length) {
    lines.push('');
    lines.push(color(colorize, BOLD, `Dropped before scoring (${skipped.length})`));
    for (const item of skipped.slice(0, 10)) {
      lines.push(`  ${truncate(`${item.company || '?'} — ${item.title || '?'}`, 60)}`);
      lines.push(color(colorize, DIM, `      ${truncate(item.reason || item.code || 'filtered', 76)}`));
    }
    if (skipped.length > 10) {
      lines.push(color(colorize, DIM, `  …and ${skipped.length - 10} more`));
    }
  }

  const expired = Array.isArray(result?.expired) ? result.expired : [];
  if (expired.length) {
    lines.push('');
    lines.push(color(colorize, BOLD, 'Top expired reasons'));
    for (const [reason, count] of reasonHistogram(expired)) {
      lines.push(`  ${String(count).padStart(4)}  ${truncate(reason, 72)}`);
    }
  }

  const uncertainItems = Array.isArray(result?.uncertain)
    ? result.uncertain
    : Array.isArray(result?.queue)
      ? result.queue.filter(item => item.liveness === 'uncertain').map(item => ({
        reason: item.reason || 'content present but no visible apply control found',
      }))
      : [];
  if ((liveness.uncertain ?? 0) > 0 && uncertainItems.length) {
    lines.push('');
    lines.push(color(colorize, BOLD, 'Top uncertain reasons'));
    for (const [reason, count] of reasonHistogram(uncertainItems)) {
      lines.push(`  ${String(count).padStart(4)}  ${truncate(reason, 72)}`);
    }
  }

  if (status === 'PLAN') {
    const queue = Array.isArray(result?.queue) ? result.queue : [];
    lines.push('');
    lines.push(color(colorize, BOLD, `Eval queue (${queue.length})`));
    if (!queue.length) {
      lines.push(color(colorize, DIM, '  (empty — nothing left to score)'));
    } else {
      const preview = queue.slice(0, 15);
      for (const [index, item] of preview.entries()) {
        const live = item.liveness === 'uncertain'
          ? color(colorize, YELLOW, 'uncertain')
          : color(colorize, GREEN, item.liveness || 'active');
        lines.push(`  ${String(index + 1).padStart(2)}. ${item.company || '?'} — ${item.title || '?'}`);
        lines.push(`      ${live}${item.source ? `  SRC:${item.source}` : ''}`);
        if (item.url) lines.push(color(colorize, DIM, `      ${item.url}`));
      }
      if (queue.length > preview.length) {
        lines.push(color(colorize, DIM, `  …and ${queue.length - preview.length} more`));
      }
    }
    lines.push('');
    if (Number(result?.pruned) > 0 || (Array.isArray(result?.triage_updates) && result.triage_updates.length)) {
      const pruned = Number(result.pruned || 0);
      lines.push(color(colorize, GREEN, `Triage updated: pruned ${pruned} rejected row(s) from scan-results.`));
    }
    if (result?.queue_path) {
      const queueLen = Array.isArray(result?.queue) ? result.queue.length : 0;
      lines.push(color(colorize, GREEN, `Eval queue saved (${queueLen}): ${result.queue_path}`));
      lines.push(color(colorize, DIM, 'Score only that queue with: npm run evaluate:judge'));
    }
    lines.push(color(colorize, YELLOW, 'No A–G reports written.'));
    lines.push('Next: npm run evaluate:judge  (or evaluate:sweep / evaluate:overflow)');
  }

  if (status === 'EMPTY') {
    lines.push('');
    lines.push('No scan-results TSV rows found under the selected data root.');
    lines.push(color(colorize, DIM, 'Run npm run scan / scan:all first, or pass --file <scan-results-….tsv>.'));
  }

  if (status === 'COMPLETED') {
    const results = Array.isArray(result?.results) ? result.results : [];
    const committed = Number(result?.committed ?? results.filter(item => item.status === 'COMMITTED').length);
    const failed = Number(result?.failed ?? results.filter(item => item.status !== 'COMMITTED').length);
    lines.push('');
    lines.push(color(colorize, BOLD, 'Results'));
    lines.push(`  committed  ${color(colorize, GREEN, String(committed))}`);
    lines.push(`  failed     ${failed ? color(colorize, RED, String(failed)) : '0'}`);

    if (results.length) {
      lines.push('');
      lines.push(color(colorize, BOLD, 'Jobs'));
      for (const [index, item] of results.entries()) {
        const n = String(index + 1).padStart(2, '0');
        const score = item.score === null || item.score === undefined
          ? 'n/a'
          : `${Number(item.score).toFixed(1)}/5`;
        const decision = item.status === 'COMMITTED'
          ? decisionLabel(item.decision, colorize)
          : statusLabel(item.status, colorize);
        const report = item.report_number
          ? `#${item.report_number}${item.report_path ? `  ${item.report_path}` : ''}`
          : '';
        lines.push(`${n}. ${item.company || '?'} — ${item.title || '?'}`);
        lines.push(`    ${decision}   score ${score}${report ? `   ${report}` : ''}`);
        if (item.location) lines.push(`    location  ${item.location}`);
        if (item.source || item.liveness) {
          lines.push(`    source    ${item.source || '?'}   liveness ${item.liveness || '?'}`);
        }
        if (item.url) lines.push(`    url       ${item.url}`);
        if (Number.isFinite(item.age_days)) {
          const scorable = item.scorable === false
            ? color(colorize, YELLOW, '   evidence too thin to score')
            : '';
          lines.push(`    age       ${item.age_days}d${item.evidence_method ? `   via ${item.evidence_method}` : ''}${scorable}`);
        }
        if (item.status !== 'COMMITTED' && (item.error || item.code)) {
          lines.push(color(colorize, RED, `    error     ${truncate(item.error || item.code, 100)}`));
        }
        if (Array.isArray(item.policy_reasons) && item.policy_reasons.length) {
          lines.push(color(colorize, DIM, `    policy    ${item.policy_reasons.join(', ')}`));
        }
        if (index < results.length - 1) lines.push('');
      }
    }

    if (expired.length) {
      lines.push('');
      lines.push(color(colorize, DIM, `Expired dropped: ${expired.length}`));
    }
    if (Array.isArray(result?.triage_updates) && result.triage_updates.length) {
      lines.push(color(colorize, DIM, `Triage files updated: ${result.triage_updates.length}`));
    }
    if (result?.failure_ledger?.path) {
      lines.push(color(colorize, DIM, `Failures saved to ${result.failure_ledger.path} (re-run with --file to retry)`));
    }
    if (result?.provider_override?.forced) {
      lines.push(color(colorize, YELLOW, `Provider gates overridden: ${result.provider_override.gaps.join(', ')}`));
    }
  }

  lines.push('');
  lines.push(color(colorize, DIM, 'Tip: pass --json for the full machine object, or --out plan.json to save it.'));
  return `${lines.join('\n')}\n`;
}

export function shouldUseHumanEvaluateOutput({ flags = {}, stdoutIsTTY = false } = {}) {
  if (flags.json === true) return false;
  if (flags.human === true) return true;
  if (flags.out) return true;
  return Boolean(stdoutIsTTY);
}
