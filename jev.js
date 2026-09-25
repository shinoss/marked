// TypeSafe's Jev model (https://docs.typesafe.ai/api.md) answers typed questions
// about some text with calibrated probabilities. Marked calls it directly with
// the user's own API key, and only when the user turns a Jev feature on.
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_ORIGINS = ['https://api.typesafe.ai/*'];
export const JEV_MODEL = 'jev-latest';
// TypeSafe's published prices (September 2026). Output is free.
export const JEV_PRICE_PER_MILLION_INPUT_TOKENS = 0.042;
export const JEV_PRICE_PER_MILLION_OUTPUT_TOKENS = 0;
export const JEV_SETTINGS_KEY = 'markedJev';
export const JEV_USAGE_KEY = 'markedJevUsage';

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}
const MESSAGES = {
  401: 'TypeSafe rejected the API key. Check it in Settings.',
  403: 'This TypeSafe API key is not allowed to use Jev. Check it in Settings.',
  422: 'TypeSafe could not process the request.',
  429: 'TypeSafe is limiting requests right now. Try again in a moment.',
  529: 'TypeSafe is overloaded right now. Try again in a moment.'
};
const aborted = () => new DOMException('The search was replaced by a newer one.', 'AbortError');
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(aborted()); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(aborted()); }, { once: true });
});

// One System One request: { state, questions } in, { model, answers, usage } out.
// Rate limits and overload are retried with backoff; onUsage sees every reply.
// preview (temporary) logs the request without sending it and answers nothing.
export async function askJev({ apiKey, state, questions, signal, onUsage, preview = false, fetchImpl = globalThis.fetch, retries = 2, retryDelay = 500 }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const body = { model: JEV_MODEL, state, questions };
  for (let attempt = 0; ; attempt++) {
    // Every request as sent, retries included. The key is cut to its last four
    // characters so the console is safe to screenshot or share.
    const label = preview ? ' (preview, not sent)' : attempt ? ` (retry ${attempt})` : '';
    console.log(`Jev request${label}: POST ${JEV_ENDPOINT}`, { headers: { ...headers, Authorization: apiKey ? `Bearer …${String(apiKey).slice(-4)}` : 'Bearer <your API key>' }, body });
    if (preview) return { answers: {} };
    let response;
    try {
      response = await fetchImpl(JEV_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new JevError('Marked could not reach TypeSafe. Check your connection.', 0);
    }
    if (response.ok) {
      const data = await response.json();
      if (data?.usage) onUsage?.(data.usage);
      return data;
    }
    if ((response.status === 429 || response.status === 529) && attempt < retries) {
      const after = Number(response.headers?.get?.('retry-after'));
      await wait(after > 0 ? Math.min(after, 10) * 1000 : retryDelay * 2 ** attempt, signal);
      continue;
    }
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message ?? body?.message ?? (typeof body?.detail === 'string' ? body.detail : '');
    } catch {}
    throw new JevError(MESSAGES[response.status] || `TypeSafe returned an error (${response.status})${detail ? `: ${detail}` : ''}.`, response.status);
  }
}

// What Marked has spent on Jev, kept as token counts; the cost is derived.
export const jevCost = (inputTokens, outputTokens = 0) =>
  ((Number(inputTokens) || 0) * JEV_PRICE_PER_MILLION_INPUT_TOKENS + (Number(outputTokens) || 0) * JEV_PRICE_PER_MILLION_OUTPUT_TOKENS) / 1e6;
// Input tokens for a request before it is sent. TypeSafe doesn't publish its
// tokenizer, so this counts about four characters of English per token and one
// per character of other scripts, plus the ~250 tokens every request carries.
// It lands within a few percent of the usage in TypeSafe's documented examples.
export function estimateJevTokens({ state, questions }) {
  let ascii = 0, other = 0;
  for (const char of JSON.stringify({ state, questions })) {
    if (char.charCodeAt(0) < 128) ascii++; else other++;
  }
  return 250 + Math.ceil(ascii / 4) + other;
}
// Searches cost fractions of a cent, so small amounts keep significant digits.
export function formatCost(dollars) {
  if (!dollars) return '$0.00';
  const digits = dollars >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: dollars >= 0.01 ? 3 : 2 };
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...digits }).format(dollars);
}
// Adds replies' usage to the running total. Tabs share it through a lock.
export function recordJevUsage(storage, usage, locks = navigator.locks) {
  return locks.request('marked-jev-usage', async () => {
    const saved = (await storage.get(JEV_USAGE_KEY))[JEV_USAGE_KEY] || { calls: 0, inputTokens: 0, outputTokens: 0, since: Date.now() };
    const total = {
      ...saved,
      calls: saved.calls + (usage.calls ?? 1),
      inputTokens: saved.inputTokens + (Number(usage.input_tokens ?? usage.inputTokens) || 0),
      outputTokens: saved.outputTokens + (Number(usage.output_tokens ?? usage.outputTokens) || 0)
    };
    await storage.set({ [JEV_USAGE_KEY]: total });
    return total;
  });
}
