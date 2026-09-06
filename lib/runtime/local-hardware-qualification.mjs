import { hostname, platform } from 'node:os';
import { record, sha256 } from './util.mjs';

const COMPANIES = ['Northstar Labs', 'Cedar Systems', 'Blue Harbor', 'Atlas Works', 'Pinecone Data'];
const ROLES = ['Data Engineer', 'Backend Developer', 'ML Platform Engineer', 'QA Automation Engineer', 'Cloud Analyst'];
const LOCATIONS = ['Pittsburgh, PA', 'Austin, TX', 'Boston, MA', 'Chicago, IL', 'Denver, CO'];

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function buildExtractionCases(caseCount = 50) {
  if (!Number.isInteger(caseCount) || caseCount < 50 || caseCount > 200) {
    throw new Error('Local hardware qualification requires 50-200 cases');
  }
  return Array.from({ length: caseCount }, (_, index) => {
    const company = `${COMPANIES[index % COMPANIES.length]} ${String(Math.floor(index / COMPANIES.length) + 1).padStart(2, '0')}`;
    const role = ROLES[(index * 2) % ROLES.length];
    const location = LOCATIONS[(index * 3) % LOCATIONS.length];
    const remote = index % 3 === 0;
    return {
      id: `extract-${String(index + 1).padStart(3, '0')}`,
      text: `Posting record. Employer="${company}". Position="${role}". Work location="${location}". Work arrangement="${remote ? 'remote' : 'on-site'}". Reference code="IGNORE-${1000 + index}".`,
      expected: { company, role, location, remote },
    };
  });
}

function parseExtraction(response) {
  const value = typeof response === 'string' ? JSON.parse(response) : response;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response is not a JSON object');
  const keys = Object.keys(value).sort();
  const expectedKeys = ['company', 'location', 'remote', 'role'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error('response keys do not match the extraction schema');
  if (typeof value.company !== 'string' || typeof value.role !== 'string'
      || typeof value.location !== 'string' || typeof value.remote !== 'boolean') {
    throw new Error('response values do not match the extraction schema');
  }
  return value;
}

function exactMatch(actual, expected) {
  return actual.company === expected.company
    && actual.role === expected.role
    && actual.location === expected.location
    && actual.remote === expected.remote;
}

function localStatusUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Local hardware qualification requires a loopback provider');
  }
  return `${url.origin}/api/ps`;
}

export async function runLocalHardwareQualification({
  provider,
  providerId,
  providerConfig,
  caseCount = 50,
  fetchImpl = fetch,
  now = new Date(),
  onProgress = null,
}) {
  if (providerConfig.local_only !== true || providerConfig.model_vendor !== 'local') {
    throw new Error('Hardware qualification is restricted to local-only providers');
  }
  if (providerConfig.capability_class !== 'EXTRACTION' || providerConfig.risk_ceiling !== 'LOW') {
    throw new Error('Local hardware qualification requires EXTRACTION capability and LOW risk ceiling');
  }
  const cases = buildExtractionCases(caseCount);
  const instruction = [
    'Extract fields from the posting record.',
    'Return only one JSON object with exactly these keys: company, role, location, remote.',
    'Copy quoted company, role, and location strings exactly. remote must be true only when work arrangement is remote.',
    'Ignore the reference code.',
  ].join(' ');
  const results = [];

  for (const item of cases) {
    const request = {
      instruction,
      task: { task_id: `local-hardware-${item.id}`, task_class: 'field_extraction' },
      evidence: [{ content: item.text }],
    };
    try {
      const raw = await provider.complete(request);
      const actual = parseExtraction(raw.response);
      results.push({
        case_id: item.id,
        completed: true,
        schema_success: true,
        exact_match: exactMatch(actual, item.expected),
        latency_ms: raw.latency_ms,
        input_tokens: Number(raw.usage?.prompt_tokens ?? raw.usage?.input_tokens ?? 0),
        output_tokens: Number(raw.usage?.completion_tokens ?? raw.usage?.output_tokens ?? 0),
        response_digest: sha256(actual),
      });
    } catch (error) {
      results.push({
        case_id: item.id,
        completed: false,
        schema_success: false,
        exact_match: false,
        error: String(error.message || error).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').slice(0, 300),
      });
    }
    onProgress?.({ completed: results.length, total: cases.length });
  }

  const statusResponse = await fetchImpl(localStatusUrl(providerConfig.base_url));
  if (!statusResponse.ok) throw new Error(`Local provider status HTTP ${statusResponse.status}`);
  const status = await statusResponse.json();
  const resident = (status.models || []).find(model => (
    model.model === providerConfig.model_snapshot || model.name === providerConfig.model_snapshot
  ));
  const latencies = results.filter(item => item.completed).map(item => Number(item.latency_ms || 0));
  const completedCount = results.filter(item => item.completed).length;
  const schemaCount = results.filter(item => item.schema_success).length;
  const exactCount = results.filter(item => item.exact_match).length;
  const size = Number(resident?.size || 0);
  const sizeVram = Number(resident?.size_vram || 0);
  const gpuResidencyRatio = size > 0 ? sizeVram / size : 0;
  const checks = {
    loopback_only: true,
    minimum_sample: cases.length >= 50,
    completion_rate: completedCount / cases.length >= 0.99,
    schema_success: schemaCount / cases.length >= 0.99,
    exact_match: exactCount / cases.length >= 0.95,
    model_resident: Boolean(resident),
    gpu_residency: gpuResidencyRatio >= 0.95,
    capability_ceiling: providerConfig.capability_class === 'EXTRACTION' && providerConfig.risk_ceiling === 'LOW',
  };
  return record('LocalHardwareQualificationV1', {
    observed_at: now.toISOString(),
    host_id: hostname(),
    platform: platform(),
    provider_id: providerId,
    model_snapshot: providerConfig.model_snapshot,
    model_digest: resident?.digest || null,
    capability_class: 'EXTRACTION',
    risk_ceiling: 'LOW',
    endpoint: new URL(providerConfig.base_url).origin,
    sample_count: cases.length,
    metrics: {
      completed_count: completedCount,
      schema_success_count: schemaCount,
      exact_match_count: exactCount,
      completion_rate: completedCount / cases.length,
      schema_success_rate: schemaCount / cases.length,
      exact_match_rate: exactCount / cases.length,
      median_latency_ms: percentile(latencies, 0.5),
      p95_latency_ms: percentile(latencies, 0.95),
      total_input_tokens: results.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
      total_output_tokens: results.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
      model_size_bytes: size,
      gpu_resident_bytes: sizeVram,
      gpu_residency_ratio: gpuResidencyRatio,
      context_length: Number(resident?.context_length || 0),
    },
    checks,
    qualified: Object.values(checks).every(Boolean),
    routing_authorized: false,
    results,
  });
}
