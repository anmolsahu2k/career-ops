/**
 * chrome-cdp.mjs — attach to already-running main Chrome.
 *
 * HTTP `--remote-debugging-port` still works for a non-default user-data-dir.
 * Chrome 136+ ignores that flag on the daily profile. Chrome 144+ instead
 * exposes a loopback WebSocket after the user enables Remote Debugging at
 * chrome://inspect/#remote-debugging and clicks Allow. Playwright's
 * connectOverCDP then hangs on Browser.getVersion, so live attach uses a
 * Target-first inspect client. That path reads only DevToolsActivePort (not
 * cookies or the rest of User Data), never copies the profile, never launches
 * Chrome, never closes foreign tabs, and never calls browser.close() on a CDP
 * session.
 */

import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { connectInspectChrome } from './inspect-cdp.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const DEVTOOLS_PORT_MAX_BYTES = 4096;

export const LIVE_CHROME_ATTACH_HELP = 'Keep Chrome in front. Enabling chrome://inspect/#remote-debugging is step one. When Handshake starts, Chrome shows a second Allow dialog for this session. Click Allow on that dialog.';

const execFileAsync = promisify(execFile);
const LIVE_CONNECT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/172.0.0.0 Safari/537.36',
};

export function assertLoopbackCdpUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch {
    throw Object.assign(new Error('applications.main_profile.cdp_url must be a loopback URL'), { code: 'CDP_URL_INVALID' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) {
    throw Object.assign(new Error('applications.main_profile.cdp_url must be a loopback URL'), { code: 'CDP_URL_INVALID' });
  }
  return url;
}

export function cdpJsonUrl(cdpUrl, path = '/json/version') {
  const url = assertLoopbackCdpUrl(cdpUrl);
  const base = `${url.protocol}//${url.host}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function handshakeTabHeuristic(tab = {}) {
  const href = String(tab.url || '');
  let host = '';
  try { host = new URL(href).hostname; } catch { host = ''; }
  const handshake = /(^|\.)joinhandshake\.com$/i.test(host);
  const login = /login|sign[-_]?in|sso|saml|auth/i.test(href) || /log\s*in/i.test(String(tab.title || ''));
  return { handshake, login, href };
}

export function defaultChromeUserDataDir(channel = 'chrome') {
  const local = process.env.LOCALAPPDATA;
  const home = homedir();
  const id = String(channel || 'chrome').toLowerCase();
  if (process.platform === 'win32' && local) {
    if (id === 'msedge' || id === 'edge') return join(local, 'Microsoft', 'Edge', 'User Data');
    if (id === 'chromium') return join(local, 'Chromium', 'User Data');
    return join(local, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    if (id === 'msedge' || id === 'edge') return join(home, 'Library', 'Application Support', 'Microsoft Edge');
    if (id === 'chromium') return join(home, 'Library', 'Application Support', 'Chromium');
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (id === 'msedge' || id === 'edge') return join(home, '.config', 'microsoft-edge');
  if (id === 'chromium') return join(home, '.config', 'chromium');
  return join(home, '.config', 'google-chrome');
}

export function resolveMainProfileUserDataDir(main = {}) {
  const explicit = String(main.user_data_dir || '').trim();
  if (explicit) return explicit;
  return defaultChromeUserDataDir(main.browser_channel || 'chrome');
}

export function parseDevToolsActivePort(content) {
  const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const wsPath = lines[1] || '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw Object.assign(new Error('DevToolsActivePort is invalid'), { code: 'CDP_LIVE_PORT_INVALID' });
  }
  if (!wsPath.startsWith('/devtools/')) {
    throw Object.assign(new Error('DevToolsActivePort path is invalid'), { code: 'CDP_LIVE_PORT_INVALID' });
  }
  return { port, path: wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
}

export function liveConnectEndpoints(live) {
  if (!live) return [];
  const urls = [];
  // The DevToolsActivePort UUID path is the socket Chrome 144 completes after
  // Allow. The short /devtools/browser path often stays in CONNECTING.
  if (live.wsUrl) urls.push(live.wsUrl);
  if (Number.isInteger(live.port) && live.port > 0) {
    const short = `ws://127.0.0.1:${live.port}/devtools/browser`;
    if (!urls.includes(short)) urls.push(short);
  }
  return urls;
}

export async function focusChromeWindow() {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      `(New-Object -ComObject WScript.Shell).AppActivate('Google Chrome') | Out-Null`,
    ], { timeout: 4000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function readLiveCdpEndpoint(userDataDir) {
  if (!userDataDir || !isAbsolute(userDataDir)) return null;
  const file = join(userDataDir, DEVTOOLS_PORT_FILE);
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > DEVTOOLS_PORT_MAX_BYTES) return null;
    return parseDevToolsActivePort(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'CDP_LIVE_PORT_INVALID') throw error;
    return null;
  }
}

function liveProbeFromDir(userDataDir) {
  if (!userDataDir) return null;
  const live = readLiveCdpEndpoint(userDataDir);
  if (!live) return null;
  return {
    ok: true,
    cdp_ok: true,
    logged_in: false,
    handshake_tab_count: 0,
    attach: 'live',
    wsUrl: live.wsUrl,
    user_data_dir: userDataDir,
    detail: 'Live Chrome inspect endpoint found. Click Allow if Chrome shows a debugging prompt.',
  };
}

/** HTTP-only CDP probe, then Chrome 144+ live inspect via DevToolsActivePort. */
export async function probeCdp(cdpUrl, { fetchImpl = fetch, timeoutMs = 1500, userDataDir = null } = {}) {
  assertLoopbackCdpUrl(cdpUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const versionRes = await fetchImpl(cdpJsonUrl(cdpUrl, '/json/version'), { signal: controller.signal });
    if (!versionRes.ok) {
      return liveProbeFromDir(userDataDir) || {
        ok: false, cdp_ok: false, logged_in: false, attach: 'http',
        detail: `CDP /json/version HTTP ${versionRes.status}. ${LIVE_CHROME_ATTACH_HELP}`,
      };
    }
    const version = await versionRes.json().catch(() => ({}));
    let tabs = [];
    try {
      const listRes = await fetchImpl(cdpJsonUrl(cdpUrl, '/json/list'), { signal: controller.signal });
      if (listRes.ok) {
        const parsed = await listRes.json();
        tabs = Array.isArray(parsed) ? parsed : [];
      }
    } catch { /* version succeeding is enough to call CDP live */ }
    const handshakeTabs = tabs.filter(tab => handshakeTabHeuristic(tab).handshake);
    const loggedIn = handshakeTabs.some(tab => !handshakeTabHeuristic(tab).login);
    const loginOnly = handshakeTabs.length > 0 && handshakeTabs.every(tab => handshakeTabHeuristic(tab).login);
    return {
      ok: true,
      cdp_ok: true,
      logged_in: loggedIn,
      handshake_tab_count: handshakeTabs.length,
      attach: 'http',
      browser: version.Browser || version['User-Agent'] || '',
      webSocketDebuggerUrl: version.webSocketDebuggerUrl || '',
      detail: loginOnly
        ? 'CDP live; Handshake tab looks like a login wall'
        : loggedIn
          ? `CDP live; ${handshakeTabs.length} Handshake tab(s)`
          : handshakeTabs.length
            ? 'CDP live; Handshake login not confirmed'
            : 'CDP live; no Handshake tab open',
    };
  } catch (error) {
    return liveProbeFromDir(userDataDir) || {
      ok: false,
      cdp_ok: false,
      logged_in: false,
      attach: 'http',
      detail: `CDP unreachable: ${String(error.message || error).slice(0, 120)}. ${LIVE_CHROME_ATTACH_HELP}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function connectMainProfile(config, {
  chromiumImpl = chromium,
  inspectConnect = connectInspectChrome,
  onProgress = null,
  focusWindow = chromiumImpl === chromium,
} = {}) {
  const main = config?.applications?.main_profile;
  if (main?.enabled !== true) {
    throw Object.assign(new Error('applications.main_profile.enabled must be true'), { code: 'MAIN_PROFILE_DISABLED' });
  }
  assertLoopbackCdpUrl(main.cdp_url);
  const userDataDir = resolveMainProfileUserDataDir(main);
  const live = readLiveCdpEndpoint(userDataDir);
  const probe = live
    ? liveProbeFromDir(userDataDir)
    : await probeCdp(main.cdp_url, { userDataDir, timeoutMs: 800 });
  if (!probe?.cdp_ok) {
    throw Object.assign(new Error(LIVE_CHROME_ATTACH_HELP), { code: 'CDP_UNREACHABLE' });
  }
  const endpoints = probe.attach === 'live'
    ? liveConnectEndpoints(live)
    : [main.cdp_url];
  if (probe.attach === 'live') {
    onProgress?.({
      stage: 'handshake',
      phase: 'allow',
      result: 'Bring Chrome to the front and click Allow if a dialog appears. The inspect toggle is not enough.',
    });
    if (focusWindow) await focusChromeWindow();
  }
  const useInspect = probe.attach === 'live' && chromiumImpl === chromium;
  if (useInspect) {
    try {
      const attached = await inspectConnect(endpoints, {
        headers: LIVE_CONNECT_HEADERS,
        timeoutMs: 90000,
        onProgress,
      });
      const context = attached.context;
      if (!context) {
        throw Object.assign(new Error('CDP Chrome has no default context'), { code: 'CDP_NO_CONTEXT' });
      }
      return {
        browser: attached.browser,
        context,
        ownedPages: new Set(),
        cdp_url: main.cdp_url,
        attach: 'live',
        user_data_dir: userDataDir,
        disconnect: attached.disconnect,
      };
    } catch (error) {
      throw Object.assign(
        new Error(`${LIVE_CHROME_ATTACH_HELP} (${String(error?.message || error).slice(0, 220)})`),
        { code: 'CDP_CONNECT_FAILED' },
      );
    }
  }
  let browser;
  let lastError;
  const timeout = probe.attach === 'live' ? 45000 : 20000;
  for (const endpoint of endpoints) {
    onProgress?.({ stage: 'handshake', phase: 'attach', result: endpoint });
    try {
      browser = await chromiumImpl.connectOverCDP(endpoint, {
        timeout,
        headers: probe.attach === 'live' ? LIVE_CONNECT_HEADERS : undefined,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!browser) {
    throw Object.assign(
      new Error(`${LIVE_CHROME_ATTACH_HELP} (${String(lastError?.message || lastError).slice(0, 220)})`),
      { code: 'CDP_CONNECT_FAILED' },
    );
  }
  const context = browser.contexts()[0];
  if (!context) {
    throw Object.assign(new Error('CDP Chrome has no default context'), { code: 'CDP_NO_CONTEXT' });
  }
  return {
    browser,
    context,
    ownedPages: new Set(),
    cdp_url: main.cdp_url,
    attach: probe.attach || 'http',
    user_data_dir: userDataDir,
  };
}

export async function openOwnedTab(session, url = 'about:blank') {
  if (!session?.context) throw new Error('openOwnedTab requires a CDP session context');
  const page = await session.context.newPage();
  session.ownedPages?.add(page);
  page.once('close', () => session.ownedPages?.delete(page));
  if (url && url !== 'about:blank') {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  return page;
}

export async function closeOwnedTabs(session) {
  const pages = [...(session?.ownedPages || [])];
  for (const page of pages) {
    if (!page.isClosed()) await page.close().catch(() => {});
    session.ownedPages?.delete(page);
  }
}

/** Disconnect the inspect/Playwright client without quitting the user's Chrome. */
export async function releaseMainProfile(session) {
  await closeOwnedTabs(session);
  try { session?.disconnect?.(); } catch { /* Chrome stays open */ }
}

export function isOwnedTabPolicy(policy) {
  return policy === 'owned';
}

const CDP_CACHE_TTL_MS = 5000;
const cdpProbeCache = new Map();

/** Short-ttl probe for UI polling so a down CDP does not stall every refresh. */
export async function probeCdpCached(cdpUrl, opts = {}) {
  const key = `${String(cdpUrl || '')}::${String(opts.userDataDir || '')}`;
  const ttl = Number.isFinite(Number(opts.cacheTtlMs)) ? Number(opts.cacheTtlMs) : CDP_CACHE_TTL_MS;
  const hit = cdpProbeCache.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await probeCdp(cdpUrl, opts);
  cdpProbeCache.set(key, { at: Date.now(), value });
  return value;
}
