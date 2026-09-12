#!/usr/bin/env node
/**
 * outreach-post-lead.mjs — Capture a LinkedIn hiring post as a draftable lead.
 *
 * Find a post via linkedin-hiring-searches.mjs, then record the poster here.
 * Post-sourced leads are the warmest kind: the poster is a named human who
 * explicitly asked to be contacted, so outreach-draft.mjs opens by referencing
 * their post ("Saw your post about the X opening") instead of a cold pitch.
 *
 * Stored SEPARATELY in data/outreach-post-leads.json, NOT in
 * data/outreach-leads.json — outreach-leads.mjs regenerates that file from the
 * tracker on every run and would wipe anything captured here.
 * outreach-draft.mjs reads both files.
 *
 * This tool never sends anything (drafts-only; you send). Zero-token.
 *
 * Usage:
 *   node outreach-post-lead.mjs --company "Acme" --role "Software Engineer, New Grad" \
 *     --name "Jane Doe" --profile https://www.linkedin.com/in/janedoe/ \
 *     --post https://www.linkedin.com/posts/janedoe_hiring-activity-123
 *
 *   [--to jane@acme.com]   known email (else LinkedIn is the channel)
 *   [--hook "..."]         one-line "why this company" for the email body
 *   [--list]               show captured post leads
 *   [--dry-run]            preview, no write
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const POST_LEADS_PATH = join(P.dataDir, 'outreach-post-leads.json');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i !== -1 ? args[i + 1] : null;
};

function loadLeads() {
  if (!existsSync(POST_LEADS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(POST_LEADS_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error(`Error: ${POST_LEADS_PATH} is not valid JSON. Fix or delete it.`);
    process.exit(1);
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function assertLinkedInUrl(url, flag) {
  if (!url) return;
  let p;
  try { p = new URL(url); } catch { console.error(`Error: ${flag} is not a valid URL: ${url}`); process.exit(1); }
  if (p.protocol !== 'https:' || !/(^|\.)linkedin\.com$/.test(p.hostname)) {
    console.error(`Error: ${flag} must be an https linkedin.com URL, got: ${url}`);
    process.exit(1);
  }
}

function main() {
  const leads = loadLeads();

  if (has('--list')) {
    if (!leads.length) { console.log('No post leads captured yet.'); return; }
    for (const l of leads) {
      console.log(`${l.id}\n  ${l.company} | ${l.role}\n  ${l.contact_name || '(no name)'} ${l.linkedin_profile || ''}\n  post: ${l.post_url}`);
    }
    return;
  }

  const company = opt('--company');
  const role = opt('--role');
  const post = opt('--post');
  const name = opt('--name');
  const profile = opt('--profile');
  const to = opt('--to');
  const hook = opt('--hook');

  if (!company || !role || !post) {
    console.error('Usage: node outreach-post-lead.mjs --company "X" --role "Y" --post <url> [--name "N"] [--profile <url>] [--to <email>] [--hook "..."]');
    process.exit(1);
  }
  assertLinkedInUrl(post, '--post');
  assertLinkedInUrl(profile, '--profile');
  if (!name || !profile) {
    console.warn('Warning: no --name/--profile. The draft will fall back to a {name} placeholder and a people-search URL.');
  }

  // One post per id; a second post for the same company gets a numeric suffix
  // rather than silently replacing the first.
  let id = `post-${slug(company)}`;
  const sameUrl = leads.find((l) => l.post_url === post);
  if (!sameUrl) {
    let n = 2;
    while (leads.some((l) => l.id === id)) id = `post-${slug(company)}-${n++}`;
  } else {
    id = sameUrl.id; // re-capturing the same post updates it in place
  }

  const lead = {
    id,
    source: 'linkedin-post',
    company,
    role,
    post_url: post,
    to: to || null,
    all_guesses: [],
    contact_name: name || null,
    linkedin_profile: profile || null,
    ...(hook ? { hook } : {}),
    captured_at: new Date().toISOString(),
  };

  const next = leads.filter((l) => l.id !== id).concat(lead);
  console.log(`${sameUrl ? 'Updated' : 'Captured'} ${id}: ${company} | ${role}`);
  console.log(`  contact: ${name || '(none)'} ${profile || ''}`);
  console.log(`  post:    ${post}`);
  if (has('--dry-run')) { console.log('(dry run — not written)'); return; }
  writeFileSync(POST_LEADS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${POST_LEADS_PATH} (${next.length} post lead${next.length === 1 ? '' : 's'})`);
  console.log('Next: node outreach-draft.mjs');
}

main();
