import Anthropic from '@anthropic-ai/sdk';
import type { ProviderId } from '../state/settings';
import { listTools } from './registry';

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Set when the arguments were not valid JSON. */
  argsError?: string;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stop: 'end' | 'tools' | 'refusal' | 'max_tokens';
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
  /** JPEG data URL returned by the `look` tool. */
  image?: string;
}

/** One assistant conversation with a provider. Each provider keeps its own native history. */
export interface Session {
  provider: ProviderId;
  model: string;
  addUser(text: string): void;
  /** Runs one model turn, streaming text through `onText`. */
  step(onText: (delta: string) => void, signal: AbortSignal): Promise<StepResult>;
  addToolResults(results: ToolResult[]): void;
}

/** An error whose message is safe and useful to show to the user as-is. */
export class AssistantError extends Error {}

const splitDataUrl = (url: string) => {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  return { mime: m?.[1] ?? 'image/jpeg', data: m?.[2] ?? '' };
};

// ---------------------------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------------------------

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

export function anthropicSession(apiKey: string, model: string, system: string): Session {
  // The key is the user's own, entered in Settings and kept on their machine; the browser talks
  // to the API directly because there is no DreamForge server to proxy through.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const defs = listTools();
  const tools: Anthropic.Beta.BetaTool[] = defs.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
    // Tools and system prompt never change during a session: cache them as one prefix.
    ...(i === defs.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
  const useFallback = FALLBACK_MODELS.includes(model);

  return {
    provider: 'anthropic',
    model,
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    addToolResults(results) {
      messages.push({
        role: 'user',
        content: results.map((r): Anthropic.Beta.BetaToolResultBlockParam => {
          const blocks: Anthropic.Beta.BetaToolResultBlockParam['content'] = [{ type: 'text', text: r.content }];
          if (r.image) {
            const { data } = splitDataUrl(r.image);
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
          }
          return { type: 'tool_result', tool_use_id: r.id, is_error: r.isError, content: blocks };
        }),
      });
    },
    async step(onText, signal) {
      let jsonRetries = 0;
      for (;;) {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 64000,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            tools,
            messages,
            thinking: { type: 'adaptive' },
            ...(useFallback ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const } : {}),
          },
          { signal },
        );
        stream.on('text', onText);
        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
        } catch (err) {
          if (err instanceof Anthropic.APIUserAbortError) throw err;
          if (err instanceof Anthropic.AuthenticationError) throw new AssistantError('The Anthropic API key was rejected. Check it in Settings.');
          if (err instanceof Anthropic.PermissionDeniedError) throw new AssistantError(`This Anthropic key cannot use ${model}. Pick another model in Settings.`);
          if (err instanceof Anthropic.NotFoundError) throw new AssistantError(`Anthropic does not recognise the model "${model}". Check the model name in Settings.`);
          if (err instanceof Anthropic.RateLimitError) throw new AssistantError('Anthropic rate limit reached. Wait a moment and try again.');
          if (err instanceof Anthropic.APIConnectionError) throw new AssistantError('Could not reach the Anthropic API. Check your internet connection.');
          if (err instanceof Anthropic.APIError) throw new AssistantError(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
          // Not an API error: a tool input that could not be parsed. Re-issue the turn a couple of times.
          if (jsonRetries++ >= 2) throw err;
          continue;
        }
        // History must carry the content unchanged (thinking and fallback blocks included).
        messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (message.stop_reason === 'pause_turn') continue;
        const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
        if (message.stop_reason === 'refusal') return { text, toolCalls: [], stop: 'refusal' };
        const toolCalls = message.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input }));
        // An input cut off at the token limit can still parse as a partial object: never run it.
        if (message.stop_reason === 'max_tokens') return { text, toolCalls: toolCalls.map((c) => ({ ...c, argsError: 'The call was cut off before its arguments were complete.' })), stop: toolCalls.length ? 'tools' : 'max_tokens' };
        return { text, toolCalls, stop: toolCalls.length ? 'tools' : 'end' };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// OpenAI (ChatGPT)
// ---------------------------------------------------------------------------------------------

type OAContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
interface OAMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OAContent | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function openaiError(res: Response): Promise<AssistantError> {
  let detail = '';
  try {
    detail = (await res.json())?.error?.message ?? '';
  } catch {}
  if (res.status === 401) return new AssistantError('The OpenAI API key was rejected. Check it in Settings.');
  if (res.status === 429) return new AssistantError(`OpenAI rate limit or quota reached. ${detail}`.trim());
  if (res.status === 404) return new AssistantError(`OpenAI does not recognise that model. ${detail} Check the model name in Settings.`.trim());
  return new AssistantError(`OpenAI API error ${res.status}. ${detail}`.trim());
}

export function openaiSession(apiKey: string, model: string, system: string): Session {
  const messages: OAMessage[] = [{ role: 'system', content: system }];
  const tools = listTools().map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

  return {
    provider: 'openai',
    model,
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    addToolResults(results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      // Tool messages cannot carry images, so pictures follow as a user message.
      const images = results.filter((r) => r.image);
      if (images.length) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'Picture(s) returned by the look tool:' }, ...images.map((r) => ({ type: 'image_url' as const, image_url: { url: r.image! } }))],
        });
      }
    },
    async step(onText, signal) {
      let res: Response;
      try {
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools, stream: true }),
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        throw new AssistantError('Could not reach the OpenAI API. Check your internet connection.');
      }
      if (!res.ok || !res.body) throw await openaiError(res);

      let text = '';
      let finish = '';
      const calls: { id: string; name: string; args: string }[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            onText(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
      const made = calls.filter(Boolean);
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(made.length ? { tool_calls: made.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) } : {}),
      });
      if (finish === 'content_filter') return { text, toolCalls: [], stop: 'refusal' };
      const toolCalls: ToolCall[] = made.map((c) => {
        try {
          return { id: c.id, name: c.name, args: JSON.parse(c.args || '{}') };
        } catch {
          return { id: c.id, name: c.name, args: {}, argsError: 'The arguments were not valid JSON.' };
        }
      });
      if (finish === 'length') return { text, toolCalls: toolCalls.map((c) => ({ ...c, argsError: 'The call was cut off before its arguments were complete.' })), stop: toolCalls.length ? 'tools' : 'max_tokens' };
      return { text, toolCalls, stop: toolCalls.length ? 'tools' : 'end' };
    },
  };
}

/** Lists model ids available to an OpenAI key (for the Settings dropdowns). */
export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await openaiError(res);
  const data = (await res.json()) as { data: { id: string }[] };
  return data.data.map((m) => m.id).sort();
}

/** Lists Claude model ids available to an Anthropic key. */
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const out: string[] = [];
  try {
    for await (const m of client.models.list()) out.push(m.id);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AssistantError('The Anthropic API key was rejected.');
    if (err instanceof Anthropic.APIError) throw new AssistantError(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
  return out;
}
