import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachInspectBrowser,
  CdpClient,
  serializeEvaluate,
} from '../lib/applications/inspect-cdp.mjs';

class FakeCdpSocket {
  constructor() {
    this.handlers = {};
    this.targets = [{
      targetId: 't1',
      type: 'page',
      url: 'https://cmu.joinhandshake.com/stu/jobs/1',
      title: 'SWE',
    }];
    this.sessions = new Map();
  }

  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
  }

  send(raw) {
    const msg = JSON.parse(raw);
    queueMicrotask(() => this.reply(msg));
  }

  close() {
    for (const fn of this.handlers.close || []) fn();
  }

  emit(data) {
    for (const fn of this.handlers.message || []) fn(data);
  }

  reply(msg) {
    const { id, method, params = {}, sessionId } = msg;
    let result = {};
    if (method === 'Target.getBrowserContexts') result = { browserContextIds: [''] };
    else if (method === 'Target.getTargets') result = { targetInfos: this.targets };
    else if (method === 'Target.attachToTarget') {
      const session = `s-${params.targetId}`;
      this.sessions.set(session, params.targetId);
      result = { sessionId: session };
    } else if (method === 'Target.createTarget') {
      const targetId = `new-${this.targets.length + 1}`;
      this.targets.push({ targetId, type: 'page', url: params.url || 'about:blank' });
      const session = `s-${targetId}`;
      this.sessions.set(session, targetId);
      result = { targetId };
      this.emit(JSON.stringify({ id, result }));
      this.emit(JSON.stringify({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: session,
          targetInfo: { targetId, type: 'page', url: params.url || 'about:blank' },
          waitingForDebugger: false,
        },
      }));
      return;
    } else if (method === 'Page.navigate') {
      const targetId = this.sessions.get(sessionId);
      const target = this.targets.find(item => item.targetId === targetId);
      if (target) target.url = params.url;
      result = { frameId: 'f1', loaderId: 'l1' };
      this.emit(JSON.stringify({ id, result }));
      this.emit(JSON.stringify({
        method: 'Page.lifecycleEvent',
        sessionId,
        params: { name: 'DOMContentLoaded', frameId: 'f1' },
      }));
      return;
    } else if (method === 'Runtime.evaluate') {
      const href = /location\.href/.test(String(params.expression || ''));
      const targetId = this.sessions.get(sessionId);
      const target = this.targets.find(item => item.targetId === targetId);
      result = {
        result: {
          type: 'string',
          value: href ? (target?.url || 'about:blank') : 'ok',
        },
      };
    } else if (method === 'Target.closeTarget') result = { success: true };
    this.emit(JSON.stringify({ id, result }));
  }
}

test('serializeEvaluate wraps functions for Runtime.evaluate', () => {
  const source = serializeEvaluate((job) => job.title, { title: 'SWE' });
  assert.match(source, /Promise\.resolve/);
  assert.match(source, /SWE/);
});

test('inspect attach speaks Target/Page/Runtime and never Browser.getVersion', async () => {
  const socket = new FakeCdpSocket();
  const sent = [];
  const original = socket.send.bind(socket);
  socket.send = (raw) => {
    sent.push(JSON.parse(raw).method);
    return original(raw);
  };
  const client = new CdpClient(socket, { timeoutMs: 1000 });
  const attached = await attachInspectBrowser(client);
  assert.ok(!sent.includes('Browser.getVersion'));
  assert.ok(sent.includes('Target.getTargets'));
  assert.ok(sent.includes('Target.setAutoAttach'));
  assert.equal(attached.context.pages().length, 1);
  assert.match(attached.context.pages()[0].url(), /joinhandshake/);
  assert.equal(await attached.context.pages()[0].evaluate(() => 'x'), 'ok');
  const page = await attached.context.newPage();
  assert.equal(attached.context.pages().length, 2);
  await page.goto('https://cmu.joinhandshake.com/stu/postings');
  assert.equal(page.url(), 'https://cmu.joinhandshake.com/stu/postings');
});
