import { qualifyModel } from './qualification.mjs';
import { verifyCommitReceipt } from './transaction.mjs';
import { record, sha256 } from './util.mjs';

const REQUIRED_ARTIFACTS = ['decision', 'report', 'tracker'];

export function certifyCanary({ qualificationBundle, receipts, target, minimumReceipts = 3 }) {
  if (qualificationBundle?.schema !== 'QualificationEvidenceBundleV1'
      || qualificationBundle.schema_version !== 1
      || qualificationBundle.qualification?.lifecycle_state !== 'shadow'
      || qualificationBundle.qualification?.checks?.shadow_passed !== true) {
    throw new Error('Canary certification requires a shadow-qualified QualificationEvidenceBundleV1');
  }
  if (!Number.isInteger(minimumReceipts) || minimumReceipts < 1) {
    throw new Error('minimumReceipts must be a positive integer');
  }
  if (!Array.isArray(receipts)) throw new Error('Canary receipts must be an array');

  const receiptChecks = receipts.map(receipt => {
    const snapshot = receipt?.provider_provenance?.provider_snapshot || {};
    const artifactNames = new Set((receipt?.artifact_manifest || []).map(item => item.name));
    return {
      transaction_id: receipt?.transaction_id || null,
      task_id: receipt?.task_id || null,
      receipt_hash: receipt?.receipt_hash || null,
      host_id: receipt?.writer_identity?.host_id || null,
      valid_receipt: verifyCommitReceipt({ receipt, target }),
      provider_match: snapshot.provider === qualificationBundle.provider_id,
      model_snapshot_match: snapshot.model_snapshot === qualificationBundle.model_snapshot,
      no_capability_degradation: receipt?.provider_provenance?.capability_degradation === false,
      attempts_bounded: Number(receipt?.provider_provenance?.attempts || 0) >= 1
        && Number(receipt?.provider_provenance?.attempts || 0) <= 2,
      complete_artifacts: REQUIRED_ARTIFACTS.every(name => artifactNames.has(name)),
      writer_identity_present: Boolean(receipt?.writer_identity?.host_id
        && receipt?.writer_identity?.writer_id
        && receipt?.writer_identity?.lock_generation),
    };
  });
  const hosts = new Set(receiptChecks.map(item => item.host_id).filter(Boolean));
  const transactionIds = receiptChecks.map(item => item.transaction_id).filter(Boolean);
  const taskIds = receiptChecks.map(item => item.task_id).filter(Boolean);
  const checks = {
    minimum_receipts: receipts.length >= minimumReceipts,
    receipts_valid: receiptChecks.every(item => item.valid_receipt),
    provider_identity: receiptChecks.every(item => item.provider_match && item.model_snapshot_match),
    no_capability_degradation: receiptChecks.every(item => item.no_capability_degradation),
    attempts_bounded: receiptChecks.every(item => item.attempts_bounded),
    complete_artifacts: receiptChecks.every(item => item.complete_artifacts),
    writer_identity_present: receiptChecks.every(item => item.writer_identity_present),
    single_writer_host: hosts.size === 1,
    unique_transactions: new Set(transactionIds).size === receipts.length,
    unique_tasks: new Set(taskIds).size === receipts.length,
  };
  const passed = Object.values(checks).every(Boolean);
  const qualification = qualifyModel({
    ...qualificationBundle.metrics,
    shadow_passed: true,
    canary_passed: passed,
    lifecycle_state: passed ? 'canary' : 'shadow',
  });
  return record('CanaryCertificationV1', {
    provider_id: qualificationBundle.provider_id,
    model_snapshot: qualificationBundle.model_snapshot,
    qualification_bundle_digest: sha256(qualificationBundle),
    target_digest: sha256(String(target)),
    minimum_receipts: minimumReceipts,
    receipt_count: receipts.length,
    receipt_checks: receiptChecks,
    checks,
    passed,
    qualification,
  });
}
