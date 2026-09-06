import { TRI_STATES } from './constants.mjs';

const SIGNALS = Object.freeze({
  sponsorship_compatible: {
    YES: [
      /\b(?:will|can|may) sponsor (?:employment|work|visa)/i,
      /\bvisa sponsorship (?:is )?(?:available|provided|supported)\b/i,
      /\bopen to international candidates\b/i,
    ],
    NO: [
      /\b(?:employment |work |visa )?sponsorship (?:is |will be )?(?:not available|not offered|not provided|not supported)\b/i,
      /\bauthori[sz](?:ation|ed) to work\b.{0,80}\bwithout (?:current or future )?(?:visa )?sponsorship\b/i,
      /\bwithout sponsorship now or in the future\b/i,
      /\bwill not sponsor\b/i,
      /\bnot eligible for (?:visa )?sponsorship\b/i,
    ],
  },
  citizenship_restricted: {
    YES: [
      /\bU\.?S\.? citizens? only\b/i,
      /\bmust be (?:a )?U\.?S\.? citizens?\b/i,
      /\bactive (?:U\.?S\.? )?(?:(?:top )?secret|TS\/SCI)?\s*security clearance (?:is )?required\b/i,
      /\brequires? (?:an? )?active (?:U\.?S\.? )?(?:(?:top )?secret|TS\/SCI)?\s*security clearance\b/i,
      /\bactive (?:U\.?S\.? )?(?:(?:top )?secret|TS\/SCI)?\s*security clearance to be considered\b/i,
      /\bgreen card holders? or U\.?S\.? citizens? only\b/i,
    ],
    NO: [
      /\bno citizenship requirement\b/i,
      /\bcitizenship is not required\b/i,
    ],
  },
});

function resolveSignals(text, definitions) {
  const yes = definitions.YES.some(pattern => pattern.test(text));
  const no = definitions.NO.some(pattern => pattern.test(text));
  if (yes === no) return 'UNKNOWN';
  return yes ? 'YES' : 'NO';
}

export function deriveHardGateFields(evidence, { requiredSourceTypes = [] } = {}) {
  const text = String(evidence.content || '').normalize('NFKC');
  const fields = {
    sponsorship_compatible: resolveSignals(text, SIGNALS.sponsorship_compatible),
    citizenship_restricted: resolveSignals(text, SIGNALS.citizenship_restricted),
  };
  if (TRI_STATES.includes(evidence.liveness_state)) fields.posting_live = evidence.liveness_state;
  if (evidence.country && Array.isArray(evidence.allowed_countries)) {
    fields.geography_eligible = evidence.allowed_countries
      .map(value => String(value).toUpperCase())
      .includes(String(evidence.country).toUpperCase()) ? 'YES' : 'NO';
  }
  if (requiredSourceTypes.length) {
    fields.required_evidence_complete = requiredSourceTypes.includes(evidence.source_type) ? 'YES' : 'UNKNOWN';
  }
  return fields;
}

export function mergeOracleFields(asserted = {}, derived = {}) {
  const output = { ...asserted };
  for (const [gate, value] of Object.entries(derived)) {
    if (!TRI_STATES.includes(value) || value === 'UNKNOWN') continue;
    if (TRI_STATES.includes(output[gate]) && output[gate] !== 'UNKNOWN' && output[gate] !== value) output[gate] = 'UNKNOWN';
    else output[gate] = value;
  }
  return output;
}
