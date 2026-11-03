// Minimal Anthropic Messages API client (fetch only, no SDK) with a hard deadline.
const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';

export const MODELS = {
  fast: process.env.ANTHROPIC_MODEL_FAST || 'claude-haiku-5-5',
  smart: process.env.ANTHROPIC_MODEL_SMART || 'claude-sonnet-5-5',
};

export class AIError extends Error {}

export async function messages(body, { apiKey, fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new AIError('ANTHROPIC_API_KEY is not set');
  let res;
  try {
    res = await fetchImpl(URL_MESSAGES, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AIError(e?.name === 'AbortError' ? 'AI request timed out' : 'AI request failed');
  }
  if (!res.ok) {
    // Never forward upstream bodies to the browser: they can echo request details.
    throw new AIError(`AI upstream error ${res.status}`);
  }
  return res.json();
}

export const textOf = (msg) => (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
