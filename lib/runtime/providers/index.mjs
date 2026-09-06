import { CommandProvider } from './command.mjs';
import { HttpProvider } from './http.mjs';

export function createProvider(id, config, globalConfig = {}) {
  const resolved = { ...config, provider_id: id, api_billing_enabled: globalConfig.api_billing === true };
  if (resolved.type === 'command' || resolved.type === 'codex_cli' || resolved.type === 'antigravity_cli') {
    return new CommandProvider(resolved);
  }
  if (['openai_compatible', 'gemini_api', 'anthropic_api'].includes(resolved.type)) {
    const apiStyle = resolved.api_style || (resolved.type === 'gemini_api'
      ? 'gemini_generate_content'
      : resolved.type === 'anthropic_api' ? 'anthropic_messages' : 'openai_chat');
    return new HttpProvider({ ...resolved, api_style: apiStyle });
  }
  throw new Error(`Unsupported provider adapter type: ${resolved.type}`);
}
