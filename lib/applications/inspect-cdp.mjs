/**
 * Chrome 144+ inspect attach. Playwright connectOverCDP waits on
 * Browser.getVersion after the WebSocket opens; inspect never answers that
 * method, so Handshake hung at "ws connected". This client speaks Target /
 * Page / Runtime only, then exposes a small Playwright-like page/context.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PAGE_TYPES = new Set(['page', 'webview']);

export function serializeEvaluate(pageFunction, arg) {
  if (typeof pageFunction === 'string') {
    return arg === undefined ? pageFunction : `(async () => { ${pageFunction} })()`;
  }
  const source = String(pageFunction);
  if (arg === undefined) return `Promise.resolve((${source})())`;
  return `Promise.resolve((${source})(${JSON.stringify(arg)}))`;
}

export function hasTextSpec(hasText) {
  if (!hasText) return { source: '', flags: '' };
  if (hasText instanceof RegExp) return { source: hasText.source, flags: hasText.flags };
  const escaped = String(hasText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { source: escaped, flags: 'i' };
}

function loadWs() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../node_modules/playwright-core/lib/utilsBundle.js'),
    join(here, '../../../playwright-core/lib/utilsBundle.js'),
  ];
  for (const file of candidates) {
    try {
      const bundle = require(file);
      if (typeof bundle.ws === 'function') return bundle.ws;
    } catch { /* next */ }
  }
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  throw new Error('WebSocket is not available for Chrome inspect attach');
}

function bind(socket, event, fn) {
  if (typeof socket.on === 'function') socket.on(event, fn);
  else socket.addEventListener(event, fn);
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && typeof data.data !== 'undefined' && data.data !== data) {
    return messageText(data.data);
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (data && typeof data.text === 'function') return data.text();
  return String(data ?? '');
}

export async function openInspectSocket(url, { headers = {}, timeoutMs = 45000 } = {}) {
  const WS = loadWs();
  const socket = new WS(url, { headers, handshakeTimeout: timeoutMs });
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      reject(error instanceof Error ? error : new Error(String(error?.message || error)));
    };
    const timer = setTimeout(() => fail(new Error(`inspect websocket timed out after ${timeoutMs}ms`)), timeoutMs);
    bind(socket, 'open', () => { clearTimeout(timer); resolve(); });
    bind(socket, 'error', fail);
  });
  return socket;
}

export class CdpClient {
  constructor(socket, { timeoutMs = 12000 } = {}) {
    this._socket = socket;
    this._timeoutMs = timeoutMs;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._closed = false;
    bind(socket, 'message', (data) => {
      Promise.resolve(messageText(data)).then((text) => this._onMessage(text)).catch(() => {});
    });
    bind(socket, 'close', () => this._rejectAll(new Error('inspect websocket closed')));
    bind(socket, 'error', (error) => this._rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  on(method, fn) {
    const list = this._listeners.get(method) || [];
    list.push(fn);
    this._listeners.set(method, list);
    return this;
  }

  off(method, fn) {
    const list = this._listeners.get(method) || [];
    this._listeners.set(method, list.filter(item => item !== fn));
    return this;
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = this._timeoutMs) {
    if (this._closed) return Promise.reject(new Error('inspect websocket closed'));
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._socket.send(JSON.stringify(payload));
    });
  }

  close() {
    this._closed = true;
    this._rejectAll(new Error('inspect websocket closed'));
    try { this._socket.close(); } catch { /* already closed */ }
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result || {});
      return;
    }
    if (!msg.method) return;
    for (const fn of this._listeners.get(msg.method) || []) fn(msg.params || {}, msg.sessionId);
  }

  _rejectAll(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }
}

function createLocator(page, selector, filter = {}) {
  const spec = hasTextSpec(filter.hasText);
  const index = Number.isInteger(filter.index) ? filter.index : null;
  const locator = {
    filter(next = {}) {
      return createLocator(page, selector, { ...filter, ...next, index: null });
    },
    first() {
      return createLocator(page, selector, { ...filter, index: 0, singular: true });
    },
    nth(value) {
      return createLocator(page, selector, { ...filter, index: value, singular: true });
    },
    async count() {
      const matches = await queryMatches(page, selector, spec);
      if (filter.singular) return matches.length > (index || 0) ? 1 : 0;
      return matches.length;
    },
    async innerText() {
      const matches = await queryMatches(page, selector, spec);
      const hit = matches[index || 0];
      return hit ? hit.text : '';
    },
    async click(options = {}) {
      await page.evaluate(clickMatch, { selector, ...spec, index: index || 0, timeout: options.timeout || 4000 });
    },
    async fill(value) {
      await page.evaluate(fillMatch, { selector, ...spec, index: index || 0, value: String(value ?? '') });
    },
    async press(key) {
      await page.evaluate(pressMatch, { selector, ...spec, index: index || 0, key: String(key || 'Enter') });
    },
  };
  return locator;
}

function queryMatches(page, selector, spec) {
  return page.evaluate(({ selector: sel, source, flags }) => {
    const re = source ? new RegExp(source, flags) : null;
    return [...document.querySelectorAll(sel)].map((el, i) => ({
      i,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
    })).filter(item => !re || re.test(item.text));
  }, { selector, source: spec.source, flags: spec.flags });
}

function clickMatch({ selector, source, flags, index }) {
  const re = source ? new RegExp(source, flags) : null;
  const els = [...document.querySelectorAll(selector)].filter((el) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return !re || re.test(text);
  });
  const el = els[index];
  if (!el) throw new Error('locator click: no match');
  el.click();
}

function fillMatch({ selector, source, flags, index, value }) {
  const re = source ? new RegExp(source, flags) : null;
  const els = [...document.querySelectorAll(selector)].filter((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    return !re || re.test(text);
  });
  const el = els[index];
  if (!el) throw new Error('locator fill: no match');
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressMatch({ selector, source, flags, index, key }) {
  const re = source ? new RegExp(source, flags) : null;
  const els = [...document.querySelectorAll(selector)].filter((el) => {
    const text = (el.innerText || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    return !re || re.test(text);
  });
  const el = els[index] || document.activeElement;
  if (!el) throw new Error('locator press: no match');
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  if (key === 'Enter' && typeof el.form?.requestSubmit === 'function') el.form.requestSubmit();
}

class InspectPage {
  constructor(context, info, sessionId) {
    this._context = context;
    this._client = context._client;
    this._targetId = info.targetId;
    this._sessionId = sessionId;
    this._url = info.url || 'about:blank';
    this._closed = false;
    this._closeListeners = [];
  }

  url() { return this._url; }
  isClosed() { return this._closed; }
  context() { return this._context; }
  locator(selector) { return createLocator(this, selector); }
  frames() { return []; }
  mainFrame() { return this; }
  on() { return this; }
  off() { return this; }
  once(event, fn) {
    if (event === 'close') this._closeListeners.push(fn);
    return this;
  }

  async evaluate(pageFunction, arg) {
    await this._client.send('Runtime.runIfWaitingForDebugger', {}, this._sessionId).catch(() => {});
    const expression = serializeEvaluate(pageFunction, arg);
    const reply = await this._client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, this._sessionId, 30000);
    if (reply.exceptionDetails) {
      const detail = reply.exceptionDetails.exception?.description
        || reply.exceptionDetails.text
        || 'Runtime.evaluate failed';
      throw new Error(detail);
    }
    return reply.result?.value;
  }

  async goto(url, { timeout = 60000 } = {}) {
    await this._ensureDomains();
    const settled = this._waitLifecycle(timeout);
    const navigated = await this._client.send('Page.navigate', { url }, this._sessionId, timeout);
    if (navigated?.errorText) throw new Error(navigated.errorText);
    await settled;
    this._url = await this.evaluate(() => location.href).catch(() => url);
    return { status() { return 200; } };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    await this._client.send('Target.closeTarget', { targetId: this._targetId }).catch(() => {});
    this._emitClose();
  }

  async bringToFront() {
    await this._client.send('Target.activateTarget', { targetId: this._targetId }).catch(() => {});
  }

  async trustedClick(x, y) {
    await this.bringToFront();
    const point = { x: Number(x), y: Number(y), button: 'left', clickCount: 1 };
    const send = (params) => this._client.send('Input.dispatchMouseEvent', params, this._sessionId, 4000);
    await send({ type: 'mouseMoved', x: point.x, y: point.y });
    await send({ ...point, type: 'mousePressed' });
    await send({ ...point, type: 'mouseReleased' });
  }

  async screenshot({ path } = {}) {
    const { data } = await this._client.send('Page.captureScreenshot', { format: 'png' }, this._sessionId, 15000);
    if (path && data) writeFileSync(path, Buffer.from(data, 'base64'));
    return data || '';
  }

  async setInputFiles(selector, filePath) {
    const files = (Array.isArray(filePath) ? filePath : [filePath]).map(item => String(item || '')).filter(Boolean);
    if (!files.length) throw new Error('setInputFiles requires a file path');
    await this._client.send('DOM.enable', {}, this._sessionId);
    const doc = await this._client.send('DOM.getDocument', { depth: 0, pierce: true }, this._sessionId);
    const found = await this._client.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    }, this._sessionId);
    if (!found?.nodeId) throw new Error(`file input not found: ${selector}`);
    await this._client.send('DOM.setFileInputFiles', { files, nodeId: found.nodeId }, this._sessionId);
  }

  async addStyleTag() { return null; }
  async waitForLoadState() { return this._waitLifecycle(4000); }
  async title() { return this.evaluate(() => document.title).catch(() => ''); }
  async content() { return this.evaluate(() => document.documentElement?.outerHTML || '').catch(() => ''); }

  markClosed() {
    if (this._closed) return;
    this._closed = true;
    this._emitClose();
  }

  async _ready() {
    await this._ensureDomains();
  }

  async _ensureDomains() {
    if (this._domains) return;
    await this._client.send('Page.enable', {}, this._sessionId);
    await this._client.send('Runtime.enable', {}, this._sessionId);
    await this._client.send('Page.setLifecycleEventsEnabled', { enabled: true }, this._sessionId).catch(() => {});
    this._domains = true;
  }

  _waitLifecycle(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._client.off('Page.lifecycleEvent', onEvent);
        resolve();
      }, Math.min(timeoutMs, 2000));
      const onEvent = (params, sessionId) => {
        if (sessionId !== this._sessionId) return;
        if (!['DOMContentLoaded', 'load', 'networkAlmostIdle'].includes(params.name)) return;
        clearTimeout(timer);
        this._client.off('Page.lifecycleEvent', onEvent);
        resolve();
      };
      this._client.on('Page.lifecycleEvent', onEvent);
    });
  }

  _emitClose() {
    for (const fn of this._closeListeners.splice(0)) {
      try { fn(); } catch { /* listener errors are ignored */ }
    }
  }
}

class InspectContext {
  constructor(client) {
    this._client = client;
    this._pages = new Map();
    this._bySession = new Map();
    this._adopting = new Map();
    this._listeners = new Map();
    client.on('Target.attachedToTarget', (params) => {
      const info = params.targetInfo || {};
      if (!PAGE_TYPES.has(info.type)) {
        if (params.waitingForDebugger && params.sessionId) {
          client.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
        }
        return;
      }
      this.adoptTarget({ ...info, sessionId: params.sessionId }).catch(() => {});
      if (params.waitingForDebugger && params.sessionId) {
        client.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      }
    });
    client.on('Target.detachedFromTarget', (params) => {
      const page = params.targetId
        ? this._pages.get(params.targetId)
        : this._bySession.get(params.sessionId);
      page?.markClosed();
      if (params.targetId) this._pages.delete(params.targetId);
      if (params.sessionId) this._bySession.delete(params.sessionId);
    });
    client.on('Target.targetInfoChanged', (params) => {
      const info = params.targetInfo || {};
      const page = this._pages.get(info.targetId);
      if (page && info.url) page._url = info.url;
    });
    client.on('Page.frameNavigated', (params, sessionId) => {
      const page = this._bySession.get(sessionId);
      if (page && params.frame && !params.frame.parentId && params.frame.url) {
        page._url = params.frame.url;
      }
    });
  }

  on(event, fn) {
    const list = this._listeners.get(event) || [];
    list.push(fn);
    this._listeners.set(event, list);
    return this;
  }

  off(event, fn) {
    const list = this._listeners.get(event) || [];
    this._listeners.set(event, list.filter(item => item !== fn));
    return this;
  }

  emit(event, value) {
    for (const fn of this._listeners.get(event) || []) fn(value);
  }

  waitForEvent(event, options = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), options.timeout ?? 30000);
      const fn = (value) => {
        clearTimeout(timer);
        this.off(event, fn);
        resolve(value);
      };
      this.on(event, fn);
    });
  }

  pages() {
    return [...this._pages.values()].filter(page => !page.isClosed());
  }

  serviceWorkers() { return []; }
  browser() {
    return { contexts: () => [this], close: async () => this._client.close() };
  }

  async newPage() {
    const created = await this._client.send('Target.createTarget', { url: 'about:blank' });
    return this.waitForPage(created.targetId);
  }

  async waitForPage(targetId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = this._pages.get(targetId);
      if (page?._domains) return page;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const { sessionId } = await this._client.send('Target.attachToTarget', { targetId, flatten: true });
    return this.adoptTarget({ targetId, type: 'page', url: 'about:blank', sessionId });
  }

  async adoptTarget(info) {
    if (!info?.targetId || !PAGE_TYPES.has(info.type || 'page')) return null;
    const inflight = this._adopting.get(info.targetId);
    if (inflight) return inflight;
    const work = this._adoptTarget(info);
    this._adopting.set(info.targetId, work);
    try { return await work; }
    finally { this._adopting.delete(info.targetId); }
  }

  async _adoptTarget(info) {
    const existing = this._pages.get(info.targetId);
    if (existing) {
      if (info.url) existing._url = info.url;
      if (info.sessionId) {
        existing._sessionId = info.sessionId;
        this._bySession.set(info.sessionId, existing);
      }
      return existing;
    }
    let sessionId = info.sessionId;
    if (!sessionId) {
      try {
        const attached = await this._client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        sessionId = attached.sessionId;
      } catch {
        return this._pages.get(info.targetId) || null;
      }
    }
    const page = new InspectPage(this, info, sessionId);
    this._pages.set(info.targetId, page);
    this._bySession.set(sessionId, page);
    await page._ready();
    this.emit('page', page);
    return page;
  }
}

export async function attachInspectBrowser(client) {
  const context = new InspectContext(client);
  await client.send('Target.setDiscoverTargets', { discover: true });
  await client.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await new Promise(resolve => setTimeout(resolve, 75));
  const listed = await client.send('Target.getTargets', {});
  for (const info of listed.targetInfos || []) {
    if (PAGE_TYPES.has(info.type) && !context._pages.has(info.targetId)) {
      await context.adoptTarget(info);
    }
  }
  return {
    browser: context.browser(),
    context,
    client,
    disconnect: () => client.close(),
  };
}

export async function connectInspectChrome(endpoints, {
  headers = {},
  timeoutMs = 45000,
  protocolTimeoutMs = 12000,
  openSocket = openInspectSocket,
  onProgress = null,
} = {}) {
  const urls = [...new Set((Array.isArray(endpoints) ? endpoints : [endpoints]).filter(Boolean))];
  if (!urls.length) throw new Error('No inspect websocket endpoints');
  let lastError;
  for (const url of urls) {
    onProgress?.({ stage: 'handshake', phase: 'attach', result: url });
    let socket;
    try {
      socket = await openSocket(url, { headers, timeoutMs });
      const client = new CdpClient(socket, { timeoutMs: protocolTimeoutMs });
      return await attachInspectBrowser(client);
    } catch (error) {
      lastError = error;
      try { socket?.close(); } catch { /* next endpoint */ }
    }
  }
  throw lastError || new Error('inspect attach failed');
}

export { createLocator as createInspectLocator };
