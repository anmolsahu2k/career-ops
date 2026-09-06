import { record } from '../util.mjs';

function apiAllowed(config) {
  return config.enabled === true && (config.local_only === true || config.api_billing_enabled === true);
}

export class HttpProvider {
  constructor(config) {
    this.config = config;
  }

  snapshot() {
    return {
      provider: this.config.provider_id,
      model_vendor: this.config.model_vendor,
      model_family: this.config.model_family,
      model_snapshot: this.config.model_snapshot,
      capability_class: this.config.capability_class,
      execution_surface: this.config.execution_surface || 'api',
      resource_pool: this.config.resource_pool,
    };
  }

  async complete(request, { attempt = 1, repair = null } = {}) {
    if (!apiAllowed(this.config)) throw new Error('API provider is disabled; enable both provider and API billing explicitly');
    const key = process.env[this.config.api_key_env] || (this.config.local_only ? 'local-only' : null);
    if (!key) throw new Error(`Missing API credential environment variable: ${this.config.api_key_env}`);
    const started = Date.now();
    const prompt = JSON.stringify(repair ? { ...request, repair } : request);
    let url;
    let headers = { 'content-type': 'application/json' };
    let body;
    if (this.config.api_style === 'anthropic_messages') {
      url = `${this.config.base_url.replace(/\/$/, '')}/v1/messages`;
      headers = { ...headers, 'x-api-key': key, 'anthropic-version': this.config.api_version || '2023-06-01' };
      body = { model: this.config.model_snapshot, max_tokens: this.config.max_output_tokens || 6000, messages: [{ role: 'user', content: prompt }] };
    } else if (this.config.api_style === 'gemini_generate_content') {
      url = `${this.config.base_url.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(this.config.model_snapshot)}:generateContent?key=${encodeURIComponent(key)}`;
      body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } };
    } else {
      url = `${this.config.base_url.replace(/\/$/, '')}/chat/completions`;
      headers = { ...headers, authorization: `Bearer ${key}` };
      body = { model: this.config.model_snapshot, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout_ms || 120_000);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const payload = await response.json();
    const output = this.config.api_style === 'anthropic_messages'
      ? payload.content?.map(item => item.text || '').join('')
      : this.config.api_style === 'gemini_generate_content'
        ? payload.candidates?.[0]?.content?.parts?.map(item => item.text || '').join('')
        : payload.choices?.[0]?.message?.content;
    return record('RawProviderResultV1', {
      task_id: request.task.task_id,
      provider_snapshot: this.snapshot(),
      response: output || '',
      usage: payload.usageMetadata || payload.usage || {},
      latency_ms: Date.now() - started,
      attempts: attempt,
      capability_degradation: false,
    });
  }
}
