import test from 'node:test';
import assert from 'node:assert/strict';
import linkedin from '../content/adapters/linkedin.js';

test('LinkedIn adapter is restricted to signed-in job-view pages', () => {
  assert.ok(linkedin.matches('https://www.linkedin.com/jobs/view/4425382174'));
  assert.ok(linkedin.matches('https://linkedin.com/jobs/view/4425382174'));
  assert.ok(!linkedin.matches('https://example.com/jobs/view/4425382174'));
  assert.equal(linkedin.skipPage('https://www.linkedin.com/jobs/view/4425382174'), false);
  assert.equal(linkedin.skipPage('https://www.linkedin.com/jobs/search/?keywords=engineer'), true);
  assert.equal(linkedin.skipPage('https://www.linkedin.com/feed/'), true);
});

test('LinkedIn canonical fields are limited to stable candidate identity controls', () => {
  assert.equal(linkedin.canonicalAttr({ getAttribute: key => key === 'name' ? 'firstName' : null }), 'name.first');
  assert.equal(linkedin.canonicalAttr({ getAttribute: key => key === 'name' ? 'phoneNumber' : null }), 'phone.raw');
  assert.equal(linkedin.canonicalAttr({ getAttribute: () => 'untrustedField' }), null);
});

test('LinkedIn scopes work to the Easy Apply dialog and abstains when it is closed', () => {
  const modal = { id: 'easy-apply' };
  const root = { querySelector: selector => selector.includes('jobs-easy-apply-modal') ? modal : null };
  assert.equal(linkedin.formRoot(root), modal);
  assert.equal(linkedin.formRoot({ querySelector: () => null }), null);
});
