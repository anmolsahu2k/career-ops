/**
 * Handshake search keywords from profile target roles or an explicit string.
 * Handshake treats the search box as one query, so never concatenate roles.
 */

export function cleanHandshakeKeyword(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\/|,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function handshakeKeywords(spec = {}, profile = {}) {
  if (String(spec.keywords || '').trim()) return cleanHandshakeKeyword(spec.keywords);
  const source = spec.keyword_source || 'target_roles';
  if (source === 'target_roles') {
    const roles = profile.target_roles?.primary || profile.candidate?.target_roles || [];
    const first = (Array.isArray(roles) ? roles : []).map(cleanHandshakeKeyword).find(Boolean) || '';
    return first;
  }
  return '';
}
