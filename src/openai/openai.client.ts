import 'dotenv/config';
import OpenAI from 'openai';

let client: OpenAI | undefined;

export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getOpenAiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OpenAI provider is not configured');
  }

  client ??= new OpenAI({ apiKey });
  return client;
}

// Preserve the existing client surface while deferring provider construction
// until a provider-backed operation actually reaches the call boundary.
export const openai = new Proxy({} as OpenAI, {
  get(_target, property) {
    const provider = getOpenAiClient();
    const value = Reflect.get(provider, property);
    return typeof value === 'function' ? value.bind(provider) : value;
  },
});
