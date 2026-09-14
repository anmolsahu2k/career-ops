/**
 * career-ops-app.mjs — localhost Career-Ops web app (full funnel).
 * Binds 127.0.0.1 only. CSRF + same-origin. Mutations need writer host.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createApplyBoardHandler } from '../applications/board.mjs';
import { applicationQueuePreview } from '../applications/enqueue-summary.mjs';
import { applicationAttemptAnalytics } from '../applications/analytics.mjs';
import { diagnoseApplications } from '../applications/doctor.mjs';
import { runApplications } from '../applications/runner.mjs';
import { loadRuntimeConfig } from '../runtime/config.mjs';
import { sanitizePlaywrightBrowsersEnv } from '../runtime/playwright-browser.mjs';
import { assertWriterHost } from '../runtime/writer-authorization.mjs';
import { createJobRunner } from './jobs.mjs';
import { renderCareerOpsPage } from './page.mjs';
import { buildFunnelStatus, listTriagePreview, readReportMarkdown } from './status.mjs';

const DEFAULT_PORT = 8790;

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  };
}

function readJsonBody(req, limit = 64_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        rejectPromise(Object.assign(new Error('Body too large'), { code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch (error) {
        rejectPromise(Object.assign(new Error('Invalid JSON'), { code: 'BAD_JSON', cause: error }));
      }
    });
    req.on('error', rejectPromise);
  });
}

function json(res, status, value) {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(value)}\n`);
}

function writerMode(configPath, config, observedHost) {
  if (!configPath && !config) {
    return { writable: false, writerHost: null, observedHost, applicationsEnabled: false, config: null };
  }
  try {
    const selected = config || loadRuntimeConfig(configPath);
    assertWriterHost(selected, { currentHost: observedHost });
    return {
      writable: true,
      writerHost: selected.writer_host || null,
      observedHost,
      applicationsEnabled: selected.applications?.enabled === true,
      config: selected,
    };
  } catch {
    let selected = null;
    try { selected = config || (configPath ? loadRuntimeConfig(configPath) : null); } catch { selected = null; }
    return {
      writable: false,
      writerHost: selected?.writer_host || null,
      observedHost,
      applicationsEnabled: false,
      config: selected,
    };
  }
}

/**
 * Create the Career-Ops web app HTTP server (does not listen until .listen).
 */
export function createCareerOpsApp({
  target,
  repoRoot,
  configPath = null,
  config = null,
  port = DEFAULT_PORT,
  observedHost = hostname(),
} = {}) {
  sanitizePlaywrightBrowsersEnv();
  const absoluteTarget = resolve(target);
  const absoluteRoot = resolve(repoRoot);
  const csrfToken = randomBytes(24).toString('hex');
  const mode = writerMode(configPath, config, observedHost);
  const jobs = createJobRunner({
    target: absoluteTarget,
    repoRoot: absoluteRoot,
    configPath,
    config: mode.config,
    observedHost,
  });

  const applyBoard = createApplyBoardHandler(absoluteTarget, {
    allowActions: mode.writable && mode.applicationsEnabled,
    csrfToken,
    basePath: '/apply',
    onRetry: mode.writable && mode.applicationsEnabled && mode.config
      ? async key => {
        const live = writerMode(configPath, config, observedHost);
        if (!live.writable || !live.applicationsEnabled || !live.config) {
          throw Object.assign(new Error('applications.enabled must be true'), { code: 'APPLICATIONS_DISABLED' });
        }
        const selectedConfig = live.config;
        await runApplications(absoluteTarget, selectedConfig, {
          submit: true,
          max: 1,
          attemptKeys: [key],
        });
      }
      : null,
  });

  const sseClients = new Set();
  jobs.subscribe(message => {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  });

  function statusPayload() {
    const live = writerMode(configPath, config, observedHost);
    return buildFunnelStatus({
      target: absoluteTarget,
      repoRoot: absoluteRoot,
      writable: live.writable,
      writerHost: live.writerHost,
      observedHost: live.observedHost,
      applicationsEnabled: live.applicationsEnabled,
      currentJob: jobs.getCurrent(),
      config: live.config,
    });
  }

  function requireCsrf(req, body = {}) {
    const header = req.headers['x-csrf-token'];
    const token = header || body.csrf;
    if (token !== csrfToken) {
      const error = new Error('csrf denied');
      error.code = 'CSRF_DENIED';
      throw error;
    }
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = req.headers.host || '';
    return origin === `http://${host}` || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!sameOrigin(req)) {
        res.writeHead(403, securityHeaders());
        return res.end('cross-origin denied');
      }

      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const handledApply = await applyBoard.handle(req, res, { port });
      if (handledApply) return;

      if (req.method === 'GET' && url.pathname === '/') {
        const live = writerMode(configPath, config, observedHost);
        res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderCareerOpsPage({
          csrfToken,
          writable: live.writable,
          applicationsEnabled: live.applicationsEnabled,
        }));
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, statusPayload());
      }

      if (req.method === 'GET' && url.pathname === '/api/apply/preview') {
        return json(res, 200, applicationQueuePreview(absoluteTarget));
      }

      if (req.method === 'GET' && url.pathname === '/api/apply/analytics') {
        return json(res, 200, applicationAttemptAnalytics(absoluteTarget));
      }

      if (req.method === 'GET' && url.pathname === '/api/apply/doctor') {
        const live = writerMode(configPath, config, observedHost);
        if (!live.config) {
          return json(res, 400, {
            error: 'apply doctor requires --config when launching the web app',
            code: 'CONFIG_REQUIRED',
          });
        }
        return json(res, 200, diagnoseApplications(absoluteTarget, live.config));
      }

      if (req.method === 'GET' && url.pathname === '/api/triage') {
        return json(res, 200, listTriagePreview(absoluteTarget));
      }

      if (req.method === 'GET' && url.pathname === '/api/report') {
        const relativePath = url.searchParams.get('path') || '';
        const markdown = readReportMarkdown(absoluteTarget, relativePath);
        return json(res, 200, { path: relativePath, markdown });
      }

      if (req.method === 'GET' && url.pathname === '/api/jobs/current') {
        return json(res, 200, { job: jobs.getCurrent() });
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          ...securityHeaders(),
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ event: 'hello', job: jobs.getCurrent() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJsonBody(req);
        requireCsrf(req, body);
        const live = writerMode(configPath, config, observedHost);
        const action = String(body.action || '');
        const readOnlyOk = action === 'verify';
        if (!live.writable && !readOnlyOk) {
          return json(res, 403, { error: 'read-only mode: writer host / config required', code: 'READ_ONLY' });
        }
        if ((action === 'apply_run' || action === 'apply_row') && !live.applicationsEnabled) {
          return json(res, 403, { error: 'applications.enabled must be true', code: 'APPLICATIONS_DISABLED' });
        }
        const job = await jobs.start(action, body.args || {});
        return json(res, 202, { ok: true, job });
      }

      if (req.method === 'POST' && url.pathname === '/api/jobs/cancel') {
        const body = await readJsonBody(req);
        requireCsrf(req, body);
        return json(res, 200, { ok: true, job: jobs.cancel() });
      }

      if (req.method === 'POST' && url.pathname === '/api/queue/remove') {
        const body = await readJsonBody(req);
        requireCsrf(req, body);
        const live = writerMode(configPath, config, observedHost);
        if (!live.writable) return json(res, 403, { error: 'read-only mode', code: 'READ_ONLY' });
        const result = jobs.removeQueueUrls(body.urls || []);
        return json(res, 200, { ok: true, ...result });
      }

      res.writeHead(404, securityHeaders());
      res.end('not found');
    } catch (error) {
      const status = error.code === 'CSRF_DENIED' || error.code === 'READ_ONLY' ? 403
        : error.code === 'JOB_BUSY' ? 409
          : error.code === 'BAD_JSON' || error.code === 'BAD_REPORT_PATH' ? 400
            : error.code === 'REPORT_NOT_FOUND' ? 404
              : 500;
      json(res, status, { error: error.message, code: error.code || 'ERROR' });
    }
  });

  return {
    server,
    csrfToken,
    jobs,
    listen(listenPort = port) {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(listenPort, '127.0.0.1', () => {
          const address = server.address();
          const url = `http://127.0.0.1:${address.port}/`;
          resolveListen({ port: address.port, url });
        });
      });
    },
    close() {
      for (const client of sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      return new Promise((resolveClose, rejectClose) => {
        server.close(err => (err ? rejectClose(err) : resolveClose()));
      });
    },
  };
}

export async function serveCareerOpsApp(options = {}) {
  const app = createCareerOpsApp(options);
  const { url, port } = await app.listen(options.port ?? DEFAULT_PORT);
  process.stdout.write(`Career-Ops Web App: ${url}\n`);
  return { ...app, url, port };
}

export { DEFAULT_PORT };
