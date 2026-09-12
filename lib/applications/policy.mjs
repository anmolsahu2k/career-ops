import { REVIEW_BLOCKERS } from './contracts.mjs';
import { salaryQuestionKind } from './answers.mjs';

const ASSESSMENT = /assessment|take.?home|coding challenge|coding exercise|recorded video/i;
const AI_DISCLOSURE = /artificial intelligence|\bai[- ]?(?:use|tool|assistant|generated)\b|generative ai/i;
const OPTIONAL_MARKETING_CONSENT = /(?:marketing|talent\s*(?:community|network|pool)|future\s+(?:job|career|employment|opportunit)|future\s+opportunit|job\s*alerts?|newsletters?|promotional|recruit(?:ing|ment)\s+updates?|contact\s+me\s+(?:about|for)\s+(?:other|future)|keep\s+(?:me\s+)?informed)/i;
// A factual credential must be treated differently from the ordinary
// "I certify the information I provided is accurate" checkbox. The latter is
// a consent to the candidate's own already-filled form, not a new claim.
const CREDENTIAL = /professional (?:license|licen[cs]e|certif(?:y|ication))|security clearance|degree (?:requirement|earned)|hold (?:a |an )?(?:license|licen[cs]e|certif)|certif(?:ication|ied) (?:in|as|for)|licensed (?:as|to)/i;
const ALWAYS_REVIEW = /assessment|take.?home|coding challenge|contact (?:a|the)|captcha|recaptcha|create (?:an )?account/i;
const SENSITIVE = /citizen|work authorization|authorized to work|sponsorship|visa|non[ -]?(?:compete|solicit)|gender|race|ethnicity|veteran|disability|religion|date of birth|relocat|availability/i;

export function fieldRisk(question = '') {
  const text = String(question);
  if (OPTIONAL_MARKETING_CONSENT.test(text)) return 'OPTIONAL_CONSENT';
  const salaryKind = salaryQuestionKind(text);
  if (salaryKind) return salaryKind === 'CURRENT_COMPENSATION' ? 'CURRENT_COMPENSATION' : 'SALARY';
  if (AI_DISCLOSURE.test(text)) return 'AI_DISCLOSURE';
  if (CREDENTIAL.test(text)) return 'CREDENTIAL';
  if (ALWAYS_REVIEW.test(text)) return 'REVIEW';
  if (SENSITIVE.test(text)) return 'DETERMINISTIC_ONLY';
  return 'LOW';
}

export function submissionGate({ page = {}, fields = [], resume = null, generated = [], certificationHashes = [] } = {}) {
  const blockers = [];
  const add = (code, question = '') => blockers.push({ code, question });
  if (page.login) add('LOGIN_REQUIRED');
  if (page.mfa) add('MFA_REQUIRED');
  if (page.captcha) add('CAPTCHA');
  if (page.accountCreation) add('ACCOUNT_CREATION');
  if (!page.certified) add('UNSUPPORTED_PORTAL');
  if (!page.exactReviewPage) add('UNSUPPORTED_PORTAL');
  if (!resume?.hash || resume.expected_hash !== resume.hash) add('RESUME_MISMATCH');
  for (const field of fields) {
    if (field.required && (!field.value || field.validation_error)) add('VALIDATION_ERROR', field.question);
    // The extension descriptor captures control shape, but policy categories
    // are derived again from the question text so an older extension cannot
    // collapse an AI disclosure, salary, or credential into generic REVIEW.
    const classified = fieldRisk(field.question);
    const risk = classified === 'LOW' ? (field.risk || classified) : classified;
    if (risk === 'REVIEW') {
      const q = String(field.question || '');
      const code = ASSESSMENT.test(q) ? 'ASSESSMENT' : 'SENSITIVE_QUESTION';
      add(code, q);
    }
    // Optional future-contact and marketing consent is deliberately never
    // selected by the runner. A pre-existing value may be a human choice, but
    // it cannot be silently submitted as an automated opt-in.
    if (risk === 'OPTIONAL_CONSENT' && field.value) add('OPTIONAL_CONSENT', field.question);
    // A numeric salary answer is consequential. It may be used only after a
    // deterministic salary source/constraint check has marked this exact
    // field valid. A model-generated number never satisfies this flag.
    if (risk === 'SALARY' && (field.salary_validated !== true || !/^(?:local|hosted)-salary-preference$/.test(field.provenance || ''))) add('SALARY_QUESTION', field.question);
    // Current compensation is intentionally never supplied by the runner. A
    // required control stays blank and is already a validation blocker; a
    // value the candidate entered themselves is preserved rather than changed.
    // If any custom prose was generated, an AI-use disclosure cannot be
    // answered "No" automatically. For a fully deterministic application,
    // an exact approved stored answer remains eligible.
    if (risk === 'AI_DISCLOSURE' && generated.length > 0) add('AI_PROHIBITION', field.question);
    if (risk === 'CREDENTIAL' && (!field.certification_hash || !certificationHashes.includes(field.certification_hash))) {
      add('CERTIFICATION_CHANGED', field.question);
    }
    // Voluntary EEO fields may be deliberately left blank.  Requiring an
    // answer here would turn declining an optional disclosure into a fake
    // "needs review" condition.  If one is populated, however, it must be an
    // approved deterministic value; required sensitive fields are already
    // caught above when blank.
    if (risk === 'DETERMINISTIC_ONLY' && (field.required || field.value) && field.provenance !== 'deterministic') add('SENSITIVE_QUESTION', field.question);
    if (field.certification_hash && !certificationHashes.includes(field.certification_hash)) add('CERTIFICATION_CHANGED', field.question);
  }
  // A local prose canary is useful for a candidate to review, but it is not a
  // claim validator. Its self-reported flag can never grant submit authority.
  for (const answer of generated) {
    if (!answer.claims_validated || answer.provenance === 'local-generated-canary') {
      add('VALIDATION_ERROR', answer.question);
    }
  }
  return { permitted: blockers.length === 0, blockers: blockers.filter(x => REVIEW_BLOCKERS.includes(x.code)) };
}
