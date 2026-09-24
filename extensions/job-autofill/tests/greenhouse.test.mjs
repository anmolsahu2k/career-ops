import test from 'node:test';
import assert from 'node:assert/strict';

import greenhouse, { educationPath, uploadSlotLabel } from '../content/adapters/greenhouse.js';
import {
  REQUIRED_COMBOBOX_SNAPSHOT_LIMIT,
  attachRequiredComboboxOptions,
  shouldSnapshotRequiredCombobox,
} from '../content/filler.js';

// A taken-down posting redirects to the board's job list, whose only controls
// are its search box and filter dropdowns.
test('the job list is not an application form', () => {
  assert.equal(greenhouse.skipPage('https://job-boards.greenhouse.io/simplisafe?error=true'), true);
  assert.equal(greenhouse.skipPage('https://job-boards.greenhouse.io/stubhubinc'), true);
  assert.equal(greenhouse.skipPage('https://boards.greenhouse.io/cloudflare'), true);
});

test('real postings and embedded forms are still filled', () => {
  const live = [
    'https://job-boards.greenhouse.io/simplisafe/jobs/8049515',
    'https://boards.greenhouse.io/robinhood/jobs/7975529?gh_jid=7975529',
    'https://job-boards.greenhouse.io/celonis/jobs/7725788003',
    // The embed a company careers page puts in an iframe: no /jobs/{id} at all.
    'https://job-boards.greenhouse.io/embed/job_app?for=uareai&jr_id=6a5288909fbdab22fe13bf86',
    'https://boards.greenhouse.io/embed/job_app?token=4036519009',
  ];
  for (const url of live) assert.equal(greenhouse.skipPage(url), false, url);
});

test('does not claim look-alike domains as Greenhouse', () => {
  assert.equal(greenhouse.matches('https://notgreenhouse.io/acme/jobs/1'), false);
  assert.equal(greenhouse.matches('https://notgrnh.se/acme/jobs/1'), false);
  assert.equal(greenhouse.matches('https://job-boards.greenhouse.io/acme/jobs/1'), true);
  assert.equal(greenhouse.matches('https://grnh.se/opaque-short-link'), true);
});

test('education blocks route to their own profile entry', () => {
  assert.equal(educationPath('school--0'), 'education[0].school');
  assert.equal(educationPath('start-year--1'), 'education[1].startYear');
  assert.equal(educationPath('first_name'), null);
});

test('modern Greenhouse upload labels come from upload-label-{id}, not Attach', () => {
  // job-boards.greenhouse.io embed forms (Databricks etc.) put the picker verb
  // in a visually-hidden label[for=resume] while the slot name is a sibling.
  const doc = {
    getElementById(id) {
      if (id === 'upload-label-resume') return { textContent: 'Resume/CV*' };
      if (id === 'upload-label-cover_letter') return { textContent: 'Cover Letter' };
      return null;
    },
  };
  const resume = {
    tagName: 'INPUT',
    getAttribute: name => (name === 'type' ? 'file' : name === 'id' ? 'resume' : null),
    closest: () => null,
  };
  const cover = {
    tagName: 'INPUT',
    getAttribute: name => (name === 'type' ? 'file' : name === 'id' ? 'cover_letter' : null),
    closest: () => null,
  };
  assert.equal(uploadSlotLabel(resume, doc), 'Resume/CV*');
  assert.equal(uploadSlotLabel(cover, doc), 'Cover Letter');
  assert.equal(uploadSlotLabel({ tagName: 'INPUT', getAttribute: () => 'text' }, doc), '');
});

test('only required Greenhouse comboboxes with no options are inspect-snapshotted', () => {
  const requiredEmpty = { required: true, kind: 'combobox-input', options: [] };
  const optionalEmpty = { required: false, kind: 'combobox-input', options: [] };
  const requiredSelect = { required: true, kind: 'select', options: [] };
  const alreadyHasOptions = { required: true, kind: 'combobox-input', options: [{ text: 'Yes' }] };
  assert.equal(greenhouse.needsInspectOptionSnapshot(requiredEmpty), true);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, requiredEmpty), true);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, optionalEmpty), false);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, requiredSelect), false);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, alreadyHasOptions), false);
  assert.equal(shouldSnapshotRequiredCombobox({ id: 'ashby', needsInspectOptionSnapshot: greenhouse.needsInspectOptionSnapshot }, requiredEmpty), false);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, { ...requiredEmpty, control: {} }, () => 'No'), false);
  assert.equal(shouldSnapshotRequiredCombobox(greenhouse, { ...requiredEmpty, control: {} }, () => ''), true);
});

test('inspect snapshot attaches options to required comboboxes and skips optional ones', async () => {
  const opened = [];
  const fields = [
    { rawLabel: 'Previously worked here?', required: true, kind: 'combobox-input', options: [] },
    { rawLabel: 'How did you hear?', required: false, kind: 'combobox-input', options: [] },
    { rawLabel: 'Country', required: true, kind: 'combobox-input', options: [] },
  ];
  await attachRequiredComboboxOptions(fields, greenhouse, async field => {
    opened.push(field.rawLabel);
    return [{ text: 'No', value: 'No' }];
  });
  assert.deepEqual(opened, ['Previously worked here?', 'Country']);
  assert.deepEqual(fields[0].options, [{ text: 'No', value: 'No' }]);
  assert.deepEqual(fields[1].options, []);
  assert.equal(fields[2].options.length, 1);
});

test('inspect snapshot stops after the required-combobox cap', async () => {
  const opened = [];
  const fields = Array.from({ length: REQUIRED_COMBOBOX_SNAPSHOT_LIMIT + 3 }, (_, index) => ({
    rawLabel: `Q${index}`,
    required: true,
    kind: 'combobox-input',
    options: [],
  }));
  await attachRequiredComboboxOptions(fields, greenhouse, async field => {
    opened.push(field.rawLabel);
    return [{ text: 'Yes' }];
  });
  assert.equal(opened.length, REQUIRED_COMBOBOX_SNAPSHOT_LIMIT);
  assert.equal(fields[REQUIRED_COMBOBOX_SNAPSHOT_LIMIT].options.length, 0);
});

test('inspect snapshot skips a Greenhouse combobox that already shows a value', async () => {
  const opened = [];
  const control = {
    tagName: 'INPUT',
    value: '',
    closest() {
      return {
        querySelector(sel) {
          return String(sel).includes('single-value') ? { textContent: 'No' } : null;
        },
        getAttribute() { return null; },
      };
    },
  };
  const fields = [
    { rawLabel: 'Currently employed at a member site?', required: true, kind: 'combobox-input', options: [], control },
    { rawLabel: 'Country', required: true, kind: 'combobox-input', options: [] },
  ];
  await attachRequiredComboboxOptions(fields, greenhouse, async field => {
    opened.push(field.rawLabel);
    return [{ text: 'Yes', value: 'Yes' }];
  });
  assert.deepEqual(opened, ['Country']);
  assert.deepEqual(fields[0].options, []);
  assert.deepEqual(fields[1].options, [{ text: 'Yes', value: 'Yes' }]);
});

