import { create } from 'zustand';
import { settings } from '../state/settings';
import { doc } from '../state/store';
import { AssistantError, anthropicSession, openaiSession, type Session, type ToolCall, type ToolResult } from './providers';
import { getTool, isToolOutput, validate } from './registry';
import { registerAllTools } from './tools';

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | { kind: 'tool'; id: number; name: string; summary: string; result: string; ok: boolean; image?: string }
  | { kind: 'plan'; id: number; steps: string[]; state: 'waiting' | 'approved' | 'declined' }
  | { kind: 'error'; id: number; text: string }
  | { kind: 'note'; id: number; text: string };

interface ChatState {
  items: ChatItem[];
  busy: boolean;
  /** Undo steps created by the assistant during the last request, for "Undo all". */
  lastTurnSteps: number;
  set: (patch: Partial<ChatState>) => void;
}

export const useChat = create<ChatState>((set) => ({ items: [], busy: false, lastTurnSteps: 0, set: (patch) => set(patch) }));

let nextId = 1;
let session: Session | null = null;
let sessionKey = '';
let abort: AbortController | null = null;
let approval: ((ok: boolean) => void) | null = null;

const push = (item: ChatItem) => useChat.setState({ items: [...useChat.getState().items, item] });
const patchItem = (id: number, patch: Partial<ChatItem>) =>
  useChat.setState({ items: useChat.getState().items.map((it) => (it.id === id ? ({ ...it, ...patch } as ChatItem) : it)) });

export const SYSTEM_PROMPT = `You are the built-in assistant of DreamForge, a 2D animation and scene-editing studio. You operate the application directly through tools: everything you do appears live in the user's editor and each change is one undo step.

How the app works
- A project has scenes. Each scene has a stage (width x height pixels, origin top-left, y grows downward), a length in frames, layers, and a camera. Time is in frames; seconds = frames / fps.
- Layers are drawn back to front. Layer kinds: shape, text, image, group, character, drawing, particles. Every layer has x, y, rotation (degrees, clockwise), scaleX, scaleY, opacity (0..1), depth and zOrder.
- depth is multiplane distance from the camera: 0 is the main plane, positive is further away (backgrounds), negative is closer (foreground). When the camera moves or dollies, layers at different depths slide at different speeds.
- Animation is keyframes on properties, with an ease from each key to the next. Use set_keyframes to write a whole motion at once.
- Characters are rigged puppets with five views (front, threeQuarter, side, backThreeQuarter, back). Side-type views face screen-right by default; set facing "left" to mirror. Bone keyframes are OFFSETS from the rest pose, so 0 always means "rest". Rotation is clockwise-positive on screen: in a view facing right, a negative rotation swings a hanging arm or leg forward.
- Prefer the action library (apply_action) for walking, running, idling, blinking, waving and jumping. Walk and run move the limbs in place, so also key the character's x to travel (about 4 to 6 pixels per frame for a walk at normal size, 10 to 14 for a run). Use side or threeQuarter view for walking across the screen.
- speak lip-syncs a line of dialogue from its text.

How to work
- Call get_scene first so you know the stage size, frame rate and what exists. Refer to layers by the names it returns.
- Do the work with tools instead of describing what the user could do. Build complete results: if asked for a scene, create the background, place and pose the characters, and animate it.
- Compose within the stage. Feet belong on the ground you drew. Keep important things away from the edges.
- After building or animating something visual, call look at one or two frames to check it, and fix what is wrong.
- Extend the scene length (set_scene) when an animation needs more frames.
- Finish with one or two plain sentences saying what you made. Do not list every tool call.
- If a request is ambiguous in a way that changes the result substantially, ask one short question before acting; otherwise choose sensible defaults and proceed.`;

function ensureSession(): Session {
  const s = settings();
  const provider = s.assistantProvider;
  const key = provider === 'openai' ? s.openaiKey : s.anthropicKey;
  const model = provider === 'openai' ? s.openaiModel : s.anthropicModel;
  if (!key) throw new AssistantError(`Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings to use the assistant.`);
  const sig = `${provider}|${model}|${key}`;
  if (!session || sessionKey !== sig) {
    registerAllTools();
    session = provider === 'openai' ? openaiSession(key, model, SYSTEM_PROMPT) : anthropicSession(key, model, SYSTEM_PROMPT);
    sessionKey = sig;
  }
  return session;
}

export function resetChat(): void {
  stopAssistant();
  session = null;
  sessionKey = '';
  useChat.setState({ items: [], busy: false, lastTurnSteps: 0 });
}

export function stopAssistant(): void {
  abort?.abort();
  approval?.(false);
}

/** Answers the pending ask-first approval. */
export function answerPlan(ok: boolean): void {
  approval?.(ok);
}

function summarize(call: ToolCall): string {
  const tool = getTool(call.name);
  try {
    return tool?.summarize?.(call.args) ?? call.name.replace(/_/g, ' ');
  } catch {
    return call.name.replace(/_/g, ' ');
  }
}

async function runCall(call: ToolCall): Promise<ToolResult> {
  const tool = getTool(call.name);
  const fail = (content: string): ToolResult => ({ id: call.id, name: call.name, content, isError: true });
  if (!tool) return fail(`Unknown tool "${call.name}".`);
  if (call.argsError) return fail(`${call.argsError} Send the call again with complete arguments.`);
  const invalid = validate(tool.parameters, call.args ?? {});
  if (invalid) return fail(`Invalid arguments: ${invalid}`);
  if (!doc.project) return fail('No project is open.');
  const before = doc.source;
  doc.source = 'ai';
  try {
    const out = await tool.run(call.args ?? {});
    if (isToolOutput(out)) return { id: call.id, name: call.name, content: JSON.stringify(out.result ?? null), isError: false, image: out.image };
    return { id: call.id, name: call.name, content: JSON.stringify(out ?? { ok: true }), isError: false };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    doc.source = before;
  }
}

const MAX_STEPS = 60;

/** Sends a user message and runs the assistant until it finishes its turn. */
export async function sendToAssistant(text: string): Promise<void> {
  if (useChat.getState().busy) return;
  push({ kind: 'user', id: nextId++, text });
  let s: Session;
  try {
    s = ensureSession();
  } catch (err) {
    push({ kind: 'error', id: nextId++, text: err instanceof Error ? err.message : String(err) });
    return;
  }
  abort = new AbortController();
  const undoBefore = doc.undoStack.length;
  useChat.setState({ busy: true, lastTurnSteps: 0 });
  s.addUser(text);
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const msgId = nextId++;
      let started = false;
      let acc = '';
      const res = await s.step((delta) => {
        acc += delta;
        if (!started) {
          started = true;
          push({ kind: 'assistant', id: msgId, text: acc, streaming: true });
        } else patchItem(msgId, { text: acc });
      }, abort.signal);
      if (started) patchItem(msgId, { text: res.text || acc, streaming: false });
      else if (res.text) push({ kind: 'assistant', id: msgId, text: res.text, streaming: false });

      if (res.stop === 'refusal') {
        push({ kind: 'note', id: nextId++, text: 'The model declined to continue with this request.' });
        break;
      }
      if (res.stop === 'max_tokens') {
        push({ kind: 'note', id: nextId++, text: 'The reply was cut off at the length limit.' });
        break;
      }
      if (res.stop === 'end' || res.toolCalls.length === 0) break;

      // Ask-first mode: show what is about to change and wait.
      const changing = res.toolCalls.filter((c) => getTool(c.name)?.mutates);
      let approved = true;
      if (settings().aiMode === 'ask' && changing.length) {
        const planId = nextId++;
        push({ kind: 'plan', id: planId, steps: changing.map(summarize), state: 'waiting' });
        approved = await new Promise<boolean>((resolve) => (approval = resolve));
        approval = null;
        patchItem(planId, { state: approved ? 'approved' : 'declined' });
        if (abort.signal.aborted) break;
      }

      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        const tool = getTool(call.name);
        let result: ToolResult;
        if (!approved && tool?.mutates) {
          result = { id: call.id, name: call.name, content: 'The user declined this change. Do not retry it; ask what they would like instead.', isError: true };
        } else {
          result = await runCall(call);
        }
        results.push(result);
        push({ kind: 'tool', id: nextId++, name: call.name, summary: summarize(call), result: result.content.slice(0, 400), ok: !result.isError, image: result.image });
        useChat.setState({ lastTurnSteps: Math.max(0, doc.undoStack.length - undoBefore) });
      }
      s.addToolResults(results);
      if (abort.signal.aborted) break;
      if (i === MAX_STEPS - 1) push({ kind: 'note', id: nextId++, text: 'Stopped after many steps. Say "continue" to keep going.' });
    }
  } catch (err) {
    const aborted = abort.signal.aborted || (err as Error)?.name === 'AbortError';
    if (aborted) {
      push({ kind: 'note', id: nextId++, text: 'Stopped.' });
      // The provider history may end mid-turn; start a fresh session next time.
      session = null;
    } else {
      push({ kind: 'error', id: nextId++, text: err instanceof AssistantError ? err.message : `Something went wrong talking to the assistant: ${err instanceof Error ? err.message : String(err)}` });
      session = null;
    }
  } finally {
    useChat.setState({
      busy: false,
      lastTurnSteps: Math.max(0, doc.undoStack.length - undoBefore),
      items: useChat.getState().items.map((it) => (it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it)),
    });
    abort = null;
  }
}

/** Undoes every change the assistant made during its last request. */
export function undoLastTurn(): void {
  const n = useChat.getState().lastTurnSteps;
  for (let i = 0; i < n; i++) doc.undo();
  useChat.setState({ lastTurnSteps: 0 });
}
