import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { allTakenNumbers } from '../report-numbers.mjs';
import { DEFAULT_TRANSACTION_TIMING, TRACKER_HEADER } from './constants.mjs';
import { assertPolicyDecision, assertTaskEnvelope } from './contracts.mjs';
import { normalizeEvaluation } from './normalize.mjs';
import { decide, verifyPolicyDecision } from './policy-engine.mjs';
import { renderEvaluationReport, renderTrackerRow } from './renderer.mjs';
import { sanitizePresentation } from './sanitizer.mjs';
import { canonicalJson, deepFreeze, isoNow, newId, record, sha256, slugify } from './util.mjs';

const JOURNAL_STATES = Object.freeze([
  'PREPARED',
  'STAGED',
  'DECISION_COMMITTED',
  'REPORT_COMMITTED',
  'TRACKER_COMMITTED',
  'RECEIPT_COMMITTED',
  'COMPLETED',
  'ABORTED',
  'RECOVERY_REQUIRED',
]);

export class TransactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.details = details;
  }
}

export function persistencePaths(target) {
  const absoluteTarget = resolve(target);
  return {
    target: absoluteTarget,
    dataDir: join(absoluteTarget, 'data'),
    appsFile: join(absoluteTarget, 'data', 'applications.md'),
    reportsDir: join(absoluteTarget, 'reports'),
    batchRoot: join(absoluteTarget, 'batch'),
    runtimeDir: join(absoluteTarget, '.career-ops-runtime'),
    lockFile: join(absoluteTarget, '.career-ops-runtime', 'writer-lock.json'),
    lockArchiveDir: join(absoluteTarget, '.career-ops-runtime', 'lock-history'),
    journalsDir: join(absoluteTarget, '.career-ops-runtime', 'transactions'),
    stagingDir: join(absoluteTarget, '.career-ops-runtime', 'staging'),
    decisionsDir: join(absoluteTarget, '.career-ops-runtime', 'decisions'),
    receiptsDir: join(absoluteTarget, '.career-ops-runtime', 'receipts'),
  };
}

function ensureRuntimeDirectories(paths) {
  if (existsSync(paths.target) && lstatSync(paths.target).isSymbolicLink()) {
    throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink data root: ${paths.target}`);
  }
  if (existsSync(paths.batchRoot) && lstatSync(paths.batchRoot).isSymbolicLink()) {
    throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink batch root: ${paths.batchRoot}`);
  }
  for (const dir of [
    paths.dataDir, paths.reportsDir, paths.runtimeDir, paths.lockArchiveDir,
    paths.journalsDir, paths.stagingDir, paths.decisionsDir, paths.receiptsDir,
  ]) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink runtime directory: ${dir}`);
    }
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function currentProcessStartIdentity(pid = process.pid) {
  try {
    if (platform() === 'linux') {
      const statText = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `linux:${statText.split(' ')[21]}`;
    }
    if (platform() === 'win32') {
      const value = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf8', timeout: 2_000 }).trim();
      return `windows:${value}`;
    }
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000,
    }).trim();
    return value ? `posix:${value}` : null;
  } catch {
    return null;
  }
}

export function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return { alive: true, process_start_identity: currentProcessStartIdentity(pid) };
  } catch (error) {
    if (error.code === 'EPERM') return { alive: true, process_start_identity: currentProcessStartIdentity(pid) };
    return { alive: false, process_start_identity: null };
  }
}

function sameIdentity(owner, probe) {
  if (!probe.alive) return false;
  if (!owner.process_start_identity || !probe.process_start_identity) return true;
  return owner.process_start_identity === probe.process_start_identity;
}

async function exclusiveCreate(path, value) {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8'); } finally { await handle.close(); }
}

export async function acquireWriterLock(paths, {
  timing = DEFAULT_TRANSACTION_TIMING,
  hostId = hostname(),
  writerId = newId('writer'),
  processId = process.pid,
  processStartIdentity = currentProcessStartIdentity(processId),
  processProbe = defaultProcessProbe,
  now = Date.now(),
} = {}) {
  ensureRuntimeDirectories(paths);
  const owner = record('WriterLeaseV1', {
    transaction_id: null,
    writer_id: writerId,
    process_id: processId,
    process_start_identity: processStartIdentity || `unknown:${processId}:${now}`,
    host_id: hostId,
    started_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString(),
    lock_generation: `${now}-${writerId}`,
    journal_state: 'IDLE',
  });

  try {
    await exclusiveCreate(paths.lockFile, owner);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = readJson(paths.lockFile); } catch {
      throw new TransactionError('LOCK_CORRUPT', 'Writer lock exists but cannot be validated');
    }
    if (existing.host_id !== hostId) {
      throw new TransactionError('DIFFERENT_HOST_LOCK', 'A different host owns the writer lock', { owner: existing });
    }
    const ageMs = now - Date.parse(existing.heartbeat_at);
    const probe = processProbe(existing.process_id);
    const liveIdentity = sameIdentity(existing, probe);
    if (ageMs <= timing.lease_ms) {
      throw new TransactionError('WRITER_BUSY', 'The writer lease heartbeat is still fresh', { owner: existing });
    }
    if (liveIdentity) {
      throw new TransactionError('WRITER_UNRESPONSIVE', 'The lease expired but its recorded process is still alive', { owner: existing });
    }
    const archived = join(paths.lockArchiveDir, `${existing.lock_generation || Date.now()}.stale.json`);
    await rename(paths.lockFile, archived);
    try {
      await exclusiveCreate(paths.lockFile, owner);
    } catch (createError) {
      throw new TransactionError('LOCK_RACE', `Another writer acquired the lock during recovery: ${createError.message}`);
    }
  }

  let stopped = false;
  let attachedJournal = null;
  let attachedJournalPath = null;
  const heartbeat = setInterval(() => {
    if (stopped) return;
    try {
      const observed = readJson(paths.lockFile);
      if (observed.lock_generation !== owner.lock_generation) {
        stopped = true;
        return;
      }
      owner.heartbeat_at = isoNow();
      atomicWriteJson(paths.lockFile, owner);
      if (attachedJournal && attachedJournalPath) {
        attachedJournal.heartbeat_at = owner.heartbeat_at;
        writeJournal(attachedJournalPath, attachedJournal);
      }
    } catch {
      stopped = true;
    }
  }, timing.heartbeat_ms);
  heartbeat.unref?.();

  return {
    owner,
    attachJournal(path, journal) {
      attachedJournalPath = path;
      attachedJournal = journal;
    },
    update(transactionId, journalState) {
      const observed = readJson(paths.lockFile);
      if (observed.lock_generation !== owner.lock_generation) {
        throw new TransactionError('LOCK_LOST', 'Writer lock generation changed');
      }
      owner.transaction_id = transactionId;
      owner.journal_state = journalState;
      owner.heartbeat_at = isoNow();
      atomicWriteJson(paths.lockFile, owner);
    },
    async release() {
      stopped = true;
      clearInterval(heartbeat);
      let observed;
      try { observed = readJson(paths.lockFile); } catch { return; }
      if (observed.lock_generation !== owner.lock_generation) return;
      const released = { ...observed, schema: 'WriterLeaseHistoryV1', released_at: isoNow(), journal_state: 'RELEASED' };
      const archived = join(paths.lockArchiveDir, `${owner.lock_generation}.released.json`);
      atomicWriteJson(archived, released);
      await import('node:fs/promises').then(fs => fs.unlink(paths.lockFile));
    },
  };
}

function assertInsideRoot(root, path) {
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink root: ${root}`);
  }
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TransactionError('PATH_OUTSIDE_ROOT', `Path is outside the data root: ${path}`);
  }
  let cursor = root;
  for (const component of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink path component: ${cursor}`);
    }
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new TransactionError('SYMLINK_CROSSING', `Refusing symlink target: ${path}`);
  }
}

function reserveReportNumber(paths, transactionId) {
  const taken = allTakenNumbers({
    appsFile: paths.appsFile,
    reportsDir: paths.reportsDir,
    batchRoot: paths.batchRoot,
  });
  let candidate = Math.max(0, ...taken) + 1;
  for (let attempt = 0; attempt < 100; attempt++, candidate++) {
    const reservationPath = join(paths.reportsDir, `${String(candidate).padStart(3, '0')}-RESERVED.md`);
    const reservation = record('ReportNumberReservationV1', {
      report_number: candidate,
      transaction_id: transactionId,
      reserved_at: isoNow(),
      permanent: true,
    });
    try {
      writeFileSync(reservationPath, `${canonicalJson(reservation)}\n`, { flag: 'wx', mode: 0o600 });
      return { reportNumber: candidate, reservationPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new TransactionError('NUMBER_ALLOCATION_FAILED', 'Could not allocate a report number after 100 attempts');
}

function observedHash(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function artifact(name, stagingPath, finalPath, contents, expectedPriorHash) {
  return {
    name,
    staging_path: stagingPath,
    final_path: finalPath,
    expected_hash: sha256(contents),
    observed_hash: null,
    expected_prior_hash: expectedPriorHash,
    commit_state: 'PENDING',
  };
}

function writeJournal(path, journal) {
  journal.heartbeat_at = isoNow();
  journal.updated_at = isoNow();
  atomicWriteJson(path, journal);
}

function assertExpectedState(item) {
  const observed = observedHash(item.final_path);
  if (observed !== item.expected_prior_hash) {
    throw new TransactionError('EXPECTED_STATE_MISMATCH', `${item.name} changed since the commit plan was created`, {
      expected: item.expected_prior_hash,
      observed,
    });
  }
}

function commitArtifact(item, targetRoot) {
  assertInsideRoot(targetRoot, item.final_path);
  if (existsSync(item.final_path)) {
    const existingHash = observedHash(item.final_path);
    if (existingHash === item.expected_hash) {
      // Content-addressed policy decisions may already exist. Reports and the
      // tracker must still satisfy their prior-state contract; identical bytes
      // from an out-of-band writer do not prove transaction ownership.
      if (item.name !== 'decision' && item.expected_prior_hash !== existingHash) {
        throw new TransactionError('EXPECTED_STATE_MISMATCH', `${item.name} already exists outside this transaction`, {
          expected: item.expected_prior_hash,
          observed: existingHash,
        });
      }
      item.observed_hash = existingHash;
      item.commit_state = 'COMMITTED';
      return;
    }
  }
  assertExpectedState(item);
  mkdirSync(dirname(item.final_path), { recursive: true });
  assertInsideRoot(targetRoot, item.final_path);
  renameSync(item.staging_path, item.final_path);
  item.observed_hash = observedHash(item.final_path);
  if (item.observed_hash !== item.expected_hash) throw new TransactionError('ARTIFACT_HASH_MISMATCH', `${item.name} hash changed during commit`);
  item.commit_state = 'COMMITTED';
}

function receiptPathFor(paths, idempotencyKey) {
  return join(paths.receiptsDir, `${sha256(idempotencyKey)}.json`);
}

function taskSemanticDigest(task) {
  return sha256({
    task_class: task.task_class,
    risk: task.risk,
    minimum_capability_class: task.minimum_capability_class,
    required_capabilities: task.required_capabilities,
    subject: task.subject,
    evidence: task.evidence_manifest.map(item => ({ id: item.id, content_hash: item.content_hash })),
    context_hashes: task.context_hashes,
    idempotency_key: task.idempotency_key,
  });
}

function providerProvenance(rawResult) {
  if (!rawResult) return {
    provider_snapshot: { provider: 'manual', model_snapshot: 'manual-user-selected', execution_surface: 'manual' },
    usage: {}, latency_ms: 0, attempts: 1, capability_degradation: false,
  };
  const snapshot = rawResult.provider_snapshot || {};
  return {
    provider_snapshot: Object.fromEntries([
      'provider', 'model_vendor', 'model_family', 'model_snapshot',
      'capability_class', 'execution_surface', 'resource_pool',
    ].filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]])),
    usage: {
      input_tokens: Number(rawResult.usage?.input_tokens || rawResult.usage?.promptTokenCount || 0),
      output_tokens: Number(rawResult.usage?.output_tokens || rawResult.usage?.candidatesTokenCount || 0),
      total_tokens: Number(rawResult.usage?.total_tokens || rawResult.usage?.totalTokenCount || 0),
    },
    latency_ms: rawResult.latency_ms,
    attempts: rawResult.attempts,
    capability_degradation: rawResult.capability_degradation,
  };
}

export function buildCommitPlan({ paths, task, decision, presentation, transactionId, reportNumber, rawResult, normalized, writerIdentity = null }) {
  assertTaskEnvelope(task);
  assertPolicyDecision(decision);
  if (!decision.authorized_writes.length) throw new TransactionError('WRITE_NOT_AUTHORIZED', 'Policy decision authorizes no writes');
  const date = task.created_at.slice(0, 10);
  const number = String(reportNumber).padStart(3, '0');
  const companySlug = slugify(task.subject.company, 'company');
  const roleSlug = slugify(task.subject.role, 'role');
  const reportRelativePath = `reports/${companySlug}/${number}-${roleSlug}-${date}.md`;
  const reportPath = join(paths.target, ...reportRelativePath.split('/'));
  const trackerBefore = existsSync(paths.appsFile) ? readFileSync(paths.appsFile, 'utf8') : TRACKER_HEADER;
  const report = renderEvaluationReport({ task, decision, presentation, reportNumber });
  const trackerRow = renderTrackerRow({ task, decision, reportNumber, reportRelativePath, date });
  const tracker = `${trackerBefore.replace(/\s*$/, '\n')}${trackerRow}\n`;
  const stageDir = join(paths.stagingDir, transactionId);
  mkdirSync(stageDir, { recursive: true });
  const decisionText = `${canonicalJson(decision)}\n`;
  const reportText = report.endsWith('\n') ? report : `${report}\n`;
  const trackerText = tracker;
  const decisionPath = join(paths.decisionsDir, `${decision.decision_hash}.json`);
  const receiptPath = receiptPathFor(paths, task.idempotency_key);

  const planBody = record('CommitPlanV1', {
    transaction_id: transactionId,
    task_id: task.task_id,
    decision_hash: decision.decision_hash,
    report_identity: { report_number: reportNumber, company_slug: companySlug, role_slug: roleSlug, date },
    tracker_mutation: { operation: 'append', row_hash: sha256(trackerRow), evaluation_id: task.task_id },
    artifact_manifest: [
      artifact('decision', join(stageDir, 'decision.json'), decisionPath, decisionText, observedHash(decisionPath)),
      artifact('report', join(stageDir, 'report.md'), reportPath, reportText, null),
      artifact('tracker', join(stageDir, 'applications.md'), paths.appsFile, trackerText, existsSync(paths.appsFile) ? sha256(trackerBefore) : null),
    ],
    expected_prior_state: { tracker_hash: existsSync(paths.appsFile) ? sha256(trackerBefore) : null, report_absent: true },
  });
  const plan = deepFreeze({ ...planBody, plan_hash: sha256(planBody) });
  const progress = plan.artifact_manifest.map(item => ({ ...item }));

  const receipt = record('CommitReceiptV1', {
    transaction_id: transactionId,
    task_id: task.task_id,
    idempotency_key: task.idempotency_key,
    committed_at: null,
    provider_provenance: providerProvenance(rawResult),
    writer_identity: writerIdentity ? {
      writer_id: writerIdentity.writer_id,
      process_id: writerIdentity.process_id,
      process_start_identity: writerIdentity.process_start_identity,
      host_id: writerIdentity.host_id,
      lock_generation: writerIdentity.lock_generation,
    } : null,
    tracker_mutation: plan.tracker_mutation,
    digest_chain: {
      task: sha256(task),
      idempotency_basis: taskSemanticDigest(task),
      raw_response: rawResult ? sha256(rawResult.response) : null,
      normalized: normalized ? sha256(normalized) : null,
      policy_decision: decision.decision_hash,
      commit_plan: plan.plan_hash,
      artifacts: Object.fromEntries(plan.artifact_manifest.map(item => [item.name, item.expected_hash])),
    },
    report_identity: plan.report_identity,
    artifact_manifest: [],
  });
  const receiptText = () => `${canonicalJson(receipt)}\n`;
  return { plan, progress, receipt, receiptPath, receiptText, stageDir, contents: { decisionText, reportText, trackerText } };
}

function hashedRecord(value, hashField) {
  const { [hashField]: ignored, ...body } = value;
  return sha256(body);
}

export function verifyCommitPlan(plan) {
  return plan?.schema === 'CommitPlanV1'
    && plan.schema_version === 1
    && /^[a-f0-9]{64}$/.test(plan.plan_hash || '')
    && plan.plan_hash === hashedRecord(plan, 'plan_hash')
    && Array.isArray(plan.artifact_manifest);
}

function progressMatchesPlan(progress, plan) {
  if (!Array.isArray(progress) || progress.length !== plan.artifact_manifest.length) return false;
  return progress.every((item, index) => {
    const planned = plan.artifact_manifest[index];
    return ['name', 'staging_path', 'final_path', 'expected_hash', 'expected_prior_hash']
      .every(field => item[field] === planned[field]);
  });
}

export function verifyCommitReceipt({ receipt, target, task = null, normalized = null, decision = null, rawResponse = undefined, commitPlan = null }) {
  if (receipt?.schema !== 'CommitReceiptV1' || receipt.schema_version !== 1) return false;
  if (!/^[a-f0-9]{64}$/.test(receipt.receipt_hash || '') || receipt.receipt_hash !== hashedRecord(receipt, 'receipt_hash')) return false;
  if (!Array.isArray(receipt.artifact_manifest) || !receipt.digest_chain) return false;
  const paths = persistencePaths(target);
  for (const item of receipt.artifact_manifest) {
    const finalPath = join(paths.target, ...String(item.final_path).split('/'));
    try { assertInsideRoot(paths.target, finalPath); } catch { return false; }
    const actual = observedHash(finalPath);
    if (item.commit_state !== 'COMMITTED' || item.expected_hash !== item.observed_hash) return false;
    if (actual === item.expected_hash) continue;
    if (item.name !== 'tracker' || !receipt.tracker_mutation?.row_hash || !existsSync(finalPath)) return false;
    const matchingRows = readFileSync(finalPath, 'utf8').split(/\r?\n/)
      .filter(line => line && sha256(line) === receipt.tracker_mutation.row_hash);
    if (matchingRows.length !== 1) return false;
  }
  if (task) {
    if (receipt.idempotency_key !== task.idempotency_key) return false;
    const exactTask = receipt.task_id === task.task_id && receipt.digest_chain.task === sha256(task);
    if (!exactTask && receipt.digest_chain.idempotency_basis !== taskSemanticDigest(task)) return false;
  }
  if (normalized && receipt.digest_chain.normalized !== sha256(normalized)) return false;
  if (decision && receipt.digest_chain.policy_decision !== decision.decision_hash) return false;
  if (rawResponse !== undefined && receipt.digest_chain.raw_response !== sha256(rawResponse)) return false;
  if (commitPlan) {
    if (!verifyCommitPlan(commitPlan)) return false;
    if (receipt.digest_chain.commit_plan !== commitPlan.plan_hash) return false;
  }
  return true;
}

export async function commitEvaluation({ target, task, decision, presentation, rawResult = null, normalized = null, hooks = {} }) {
  const paths = persistencePaths(target);
  ensureRuntimeDirectories(paths);
  assertTaskEnvelope(task);
  const existingReceipt = receiptPathFor(paths, task.idempotency_key);
  if (existsSync(existingReceipt)) {
    const receipt = readJson(existingReceipt);
    if (!verifyCommitReceipt({ receipt, target, task })) {
      throw new TransactionError('RECEIPT_INVALID', 'Existing idempotency receipt or its artifacts failed verification');
    }
    return receipt;
  }
  if (!rawResult || !normalized) throw new TransactionError('VALIDATED_CHAIN_REQUIRED', 'Commit requires the raw result and normalized evaluation from the validation pipeline');
  const verifiedNormalized = normalizeEvaluation(task, rawResult, { now: decision.decided_at });
  if (sha256(verifiedNormalized) !== sha256(normalized)) throw new TransactionError('NORMALIZED_RESULT_MISMATCH', 'Normalized evaluation changed after validation');
  const verifiedDecision = decide(task, verifiedNormalized, { now: decision.decided_at });
  if (!verifyPolicyDecision(decision) || verifiedDecision.decision_hash !== decision.decision_hash) {
    throw new TransactionError('POLICY_DECISION_MISMATCH', 'Policy decision does not match deterministic recomputation');
  }
  const safePresentation = sanitizePresentation(verifiedNormalized.presentation_content, verifiedDecision);
  const lock = await acquireWriterLock(paths, hooks.lock || {});
  try {
    if (existsSync(existingReceipt)) {
      const receipt = readJson(existingReceipt);
      if (!verifyCommitReceipt({ receipt, target, task })) {
        throw new TransactionError('RECEIPT_INVALID', 'Existing idempotency receipt or its artifacts failed verification');
      }
      return receipt;
    }
    const transactionId = newId('tx');
    lock.update(transactionId, 'PREPARED');
    const { reportNumber, reservationPath } = reserveReportNumber(paths, transactionId);
    const built = buildCommitPlan({
      paths, task, decision, presentation: safePresentation, transactionId, reportNumber,
      rawResult, normalized, writerIdentity: lock.owner,
    });
    const journalPath = join(paths.journalsDir, `${transactionId}.json`);
    const journal = record('TransactionJournalV1', {
      transaction_id: transactionId,
      task_id: task.task_id,
      owner_identity: { ...lock.owner, transaction_id: transactionId },
      heartbeat_at: isoNow(),
      journal_state: 'PREPARED',
      reservation_path: reservationPath,
      artifact_progress: built.progress,
      tracker_progress: 'PENDING',
      commit_plan: built.plan,
      receipt_draft: built.receipt,
      receipt_path: built.receiptPath,
      updated_at: isoNow(),
    });
    writeJournal(journalPath, journal);
    lock.attachJournal(journalPath, journal);
    hooks.afterState?.('PREPARED', journal);

    for (const item of built.progress) {
      assertInsideRoot(paths.target, item.final_path);
      assertInsideRoot(paths.runtimeDir, item.staging_path);
    }
    for (const [name, text] of Object.entries(built.contents)) {
      const artifactName = name.replace(/Text$/, '');
      const item = built.progress.find(entry => entry.name === artifactName);
      writeFileSync(item.staging_path, text, { flag: 'wx', mode: 0o600 });
      if (observedHash(item.staging_path) !== item.expected_hash) throw new TransactionError('STAGING_HASH_MISMATCH', `${item.name} staging hash mismatch`);
      item.commit_state = 'STAGED';
    }
    journal.journal_state = 'STAGED';
    writeJournal(journalPath, journal);
    lock.update(transactionId, 'STAGED');
    hooks.afterState?.('STAGED', journal);

    for (const item of built.progress) {
      commitArtifact(item, paths.target);
      journal.journal_state = `${item.name.toUpperCase()}_COMMITTED`;
      if (item.name === 'tracker') journal.tracker_progress = 'COMMITTED';
      writeJournal(journalPath, journal);
      lock.update(transactionId, journal.journal_state);
      hooks.afterState?.(journal.journal_state, journal);
    }

    built.receipt.committed_at = isoNow();
    built.receipt.artifact_manifest = built.progress.map(item => ({
      name: item.name,
      final_path: relative(paths.target, item.final_path),
      expected_hash: item.expected_hash,
      observed_hash: item.observed_hash,
      commit_state: item.commit_state,
    }));
    built.receipt.receipt_hash = hashedRecord(built.receipt, 'receipt_hash');
    const receiptStage = join(built.stageDir, 'receipt.json');
    const finalReceiptText = built.receiptText();
    writeFileSync(receiptStage, finalReceiptText, { flag: 'wx', mode: 0o600 });
    if (observedHash(built.receiptPath) === null) {
      renameSync(receiptStage, built.receiptPath);
    } else if (observedHash(built.receiptPath) !== sha256(finalReceiptText)) {
      throw new TransactionError('RECEIPT_CONFLICT', 'A different receipt already occupies the idempotency path');
    }
    if (observedHash(built.receiptPath) !== sha256(finalReceiptText)) throw new TransactionError('RECEIPT_HASH_MISMATCH', 'Receipt hash mismatch');
    journal.journal_state = 'RECEIPT_COMMITTED';
    writeJournal(journalPath, journal);
    hooks.afterState?.('RECEIPT_COMMITTED', journal);

    journal.journal_state = 'COMPLETED';
    journal.heartbeat_at = isoNow();
    writeJournal(journalPath, journal);
    lock.update(transactionId, 'COMPLETED');
    hooks.afterState?.('COMPLETED', journal);
    return built.receipt;
  } catch (error) {
    throw error;
  } finally {
    await lock.release();
  }
}

function completeRecoverableArtifact(item, paths) {
  assertInsideRoot(paths.target, item.final_path);
  assertInsideRoot(paths.runtimeDir, item.staging_path);
  const finalHash = observedHash(item.final_path);
  if (finalHash === item.expected_hash) {
    item.observed_hash = finalHash;
    item.commit_state = 'COMMITTED';
    return true;
  }
  if (!existsSync(item.staging_path)) return false;
  if (finalHash !== item.expected_prior_hash) return false;
  mkdirSync(dirname(item.final_path), { recursive: true });
  renameSync(item.staging_path, item.final_path);
  item.observed_hash = observedHash(item.final_path);
  item.commit_state = item.observed_hash === item.expected_hash ? 'COMMITTED' : 'MISMATCH';
  return item.commit_state === 'COMMITTED';
}

export async function recoverTransactions({
  target,
  lockOptions = {},
  journalProcessProbe = defaultProcessProbe,
  timing = DEFAULT_TRANSACTION_TIMING,
  now = Date.now(),
}) {
  const paths = persistencePaths(target);
  ensureRuntimeDirectories(paths);
  const lock = await acquireWriterLock(paths, lockOptions);
  const results = [];
  try {
    const files = (await import('node:fs/promises')).readdir(paths.journalsDir);
    for (const name of await files) {
      if (!name.endsWith('.json')) continue;
      const path = join(paths.journalsDir, name);
      const journal = readJson(path);
      if (journal.journal_state === 'COMPLETED' || journal.journal_state === 'ABORTED') continue;
      if (journal.schema !== 'TransactionJournalV1' || journal.schema_version !== 1
        || name !== `${journal.transaction_id}.json`
        || !verifyCommitPlan(journal.commit_plan)
        || journal.commit_plan.transaction_id !== journal.transaction_id
        || journal.commit_plan.task_id !== journal.task_id
        || journal.receipt_draft?.transaction_id !== journal.transaction_id
        || journal.receipt_draft?.task_id !== journal.task_id
        || journal.owner_identity?.transaction_id !== journal.transaction_id
        || !progressMatchesPlan(journal.artifact_progress, journal.commit_plan)) {
        journal.journal_state = 'RECOVERY_REQUIRED';
        writeJournal(path, journal);
        results.push({ transaction_id: journal.transaction_id, result: 'JOURNAL_INTEGRITY_FAILED' });
        continue;
      }
      if (journal.owner_identity.host_id !== lock.owner.host_id) {
        results.push({ transaction_id: journal.transaction_id, result: 'DIFFERENT_HOST_JOURNAL' });
        continue;
      }
      const journalAgeMs = now - Date.parse(journal.heartbeat_at);
      if (!Number.isFinite(journalAgeMs) || journalAgeMs <= timing.lease_ms) {
        results.push({ transaction_id: journal.transaction_id, result: 'JOURNAL_LEASE_FRESH' });
        continue;
      }
      const originalProbe = journalProcessProbe(journal.owner_identity.process_id);
      if (sameIdentity(journal.owner_identity, originalProbe)) {
        results.push({ transaction_id: journal.transaction_id, result: 'WRITER_UNRESPONSIVE' });
        continue;
      }
      lock.update(journal.transaction_id, 'RECOVERING');
      const hasAnyArtifact = journal.artifact_progress.some(item =>
        existsSync(item.staging_path) || observedHash(item.final_path) === item.expected_hash);
      if (journal.journal_state === 'PREPARED' && !hasAnyArtifact) {
        journal.journal_state = 'ABORTED';
        journal.tracker_progress = 'NOT_STARTED';
        writeJournal(path, journal);
        results.push({ transaction_id: journal.transaction_id, result: 'ROLLED_BACK' });
        continue;
      }
      let complete = true;
      for (const item of journal.artifact_progress) {
        if (!completeRecoverableArtifact(item, paths)) {
          complete = false;
          break;
        }
      }
      if (complete && !existsSync(journal.receipt_path) && journal.receipt_draft) {
        const receipt = { ...journal.receipt_draft };
        receipt.committed_at = isoNow();
        receipt.artifact_manifest = journal.artifact_progress.map(item => ({
          name: item.name,
          final_path: relative(paths.target, item.final_path),
          expected_hash: item.expected_hash,
          observed_hash: item.observed_hash,
          commit_state: item.commit_state,
        }));
        receipt.receipt_hash = hashedRecord(receipt, 'receipt_hash');
        atomicWriteJson(journal.receipt_path, receipt);
        const written = readJson(journal.receipt_path);
        if (!verifyCommitReceipt({ receipt: written, target, commitPlan: journal.commit_plan })) {
          throw new TransactionError('RECEIPT_HASH_MISMATCH', 'Recovered receipt failed verification');
        }
      }
      const storedReceiptValid = complete && existsSync(journal.receipt_path)
        && verifyCommitReceipt({ receipt: readJson(journal.receipt_path), target, commitPlan: journal.commit_plan });
      if (storedReceiptValid) {
        journal.journal_state = 'COMPLETED';
        journal.tracker_progress = 'COMMITTED';
        results.push({ transaction_id: journal.transaction_id, result: 'RECOVERED' });
      } else {
        journal.journal_state = 'RECOVERY_REQUIRED';
        results.push({ transaction_id: journal.transaction_id, result: 'MANUAL_RECOVERY_REQUIRED' });
      }
      writeJournal(path, journal);
    }
    return results;
  } finally {
    await lock.release();
  }
}
