import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { record } from './util.mjs';

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function instructionMetrics(repoRoot) {
  const surfaceFiles = {
    codex: ['AGENTS.md', 'CAREER_OPS.md', '.agents/skills/career-ops/SKILL.md'],
    antigravity: ['CAREER_OPS.md'],
    claude: ['CLAUDE.md', 'CAREER_OPS.md', '.claude/skills/career-ops/SKILL.md'],
    generic: ['CAREER_OPS.md'],
  };
  const textFor = file => {
    const path = join(repoRoot, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  const surfaces = Object.fromEntries(Object.entries(surfaceFiles).map(([name, files]) => {
    const text = files.map(textFor).join('\n');
    return [name, { files, characters: text.length, words: (text.match(/\S+/g) || []).length, estimated_tokens: Math.ceil(text.length / 4) }];
  }));
  const maximumBase = Math.max(...Object.values(surfaces).map(item => item.characters));
  const workflows = {
    offer: ['modes/_shared.md', 'modes/offer.md'],
    scan: ['modes/scan.md'],
    batch: ['modes/_shared.md', 'modes/batch.md'],
    apply: ['modes/_shared.md', 'modes/apply.md'],
  };
  const workflow_estimates = Object.fromEntries(Object.entries(workflows).map(([name, modeFiles]) => {
    const modeCharacters = modeFiles.reduce((total, file) => {
      const path = join(repoRoot, file);
      return total + (existsSync(path) ? readFileSync(path, 'utf8').length : 0);
    }, 0);
    return [name, { mode_files: modeFiles, maximum_surface_estimated_tokens: Math.ceil((maximumBase + modeCharacters) / 4) }];
  }));
  return { surfaces, maximum_base_estimated_tokens: Math.ceil(maximumBase / 4), workflow_estimates };
}

function worktreeMetrics(repoRoot) {
  try {
    const lines = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 })
      .split('\n').filter(Boolean);
    return {
      changed_entries: lines.length,
      untracked_entries: lines.filter(line => line.startsWith('??')).length,
      tracked_changes: lines.filter(line => !line.startsWith('??')).length,
    };
  } catch {
    return { changed_entries: null, untracked_entries: null, tracked_changes: null };
  }
}

function receiptMetrics(target) {
  const dir = join(target, '.career-ops-runtime', 'receipts');
  if (!existsSync(dir)) return { sample_count: 0, median_input_tokens: null, median_latency_ms: null };
  const receipts = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { receipts.push(JSON.parse(readFileSync(join(dir, name), 'utf8'))); } catch { /* ignore invalid files in baseline only */ }
  }
  return {
    sample_count: receipts.length,
    median_input_tokens: median(receipts.map(item => Number(item.provider_provenance?.usage?.input_tokens)).filter(Number.isFinite)),
    median_latency_ms: median(receipts.map(item => Number(item.provider_provenance?.latency_ms)).filter(Number.isFinite)),
  };
}

function dataInventory(target) {
  const roots = ['data', 'reports', 'batch'].map(name => join(target, name));
  let fileCount = 0;
  let totalBytes = 0;
  const visit = path => {
    if (!existsSync(path)) return;
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) { fileCount++; totalBytes += info.size; return; }
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  roots.forEach(visit);
  return { file_count: fileCount, total_bytes: totalBytes, contents_collected: false };
}

export function captureBaseline({ repoRoot, target, now = new Date() }) {
  return record('RuntimeBaselineV1', {
    captured_at: now.toISOString(),
    worktree: worktreeMetrics(repoRoot),
    data_inventory: dataInventory(target),
    static_instructions: instructionMetrics(repoRoot),
    provider_receipts: receiptMetrics(target),
    acceptance_targets: {
      maximum_static_instruction_tokens: 10_000,
      target_static_instruction_tokens: [6_000, 8_000],
      minimum_paid_input_reduction_ratio: 0.40,
      minimum_provider_completion_ratio: 0.95,
    },
  });
}

export function compareBaselines(before, after) {
  const oldTokens = before.provider_receipts?.median_input_tokens;
  const newTokens = after.provider_receipts?.median_input_tokens;
  const reduction = Number.isFinite(oldTokens) && oldTokens > 0 && Number.isFinite(newTokens)
    ? (oldTokens - newTokens) / oldTokens
    : null;
  return record('RuntimeBaselineComparisonV1', {
    before_captured_at: before.captured_at,
    after_captured_at: after.captured_at,
    paid_input_reduction_ratio: reduction,
    meets_paid_input_target: reduction === null ? null : reduction >= 0.40,
    static_instruction_tokens: after.static_instructions?.maximum_base_estimated_tokens,
    maximum_workflow_instruction_tokens: Math.max(...Object.values(after.static_instructions?.workflow_estimates || {}).map(item => item.maximum_surface_estimated_tokens), 0),
    meets_static_instruction_ceiling: Math.max(
      Number(after.static_instructions?.maximum_base_estimated_tokens),
      ...Object.values(after.static_instructions?.workflow_estimates || {}).map(item => Number(item.maximum_surface_estimated_tokens)),
    ) <= 10_000,
  });
}
