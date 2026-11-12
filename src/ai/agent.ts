import { create } from 'zustand';
import { settings } from '../state/settings';
import { doc } from '../state/store';
import { memoryPrompt, recordFeedback, type Rating } from './memory';
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
  /** What the user last asked for, and whether that result still awaits a rating. */
  lastRequest: string;
  awaitingFeedback: boolean;
  set: (patch: Partial<ChatState>) => void;
}

export const useChat = create<ChatState>((set) => ({ items: [], busy: false, lastTurnSteps: 0, lastRequest: '', awaitingFeedback: false, set: (patch) => set(patch) }));

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
- speak lip-syncs a line of dialogue from its text; lip_sync_audio does it from a sound clip on the timeline.
- Every built-in action plays correctly in all five views, so pick the view the shot needs and apply the action.
- The skeleton has 27 bones, including chest, clavicle.L/R (shrugs), fingers and thumb (hands), toes, and hair. Use them: fingers and toes make a pose look alive.
- 3D: add_character with style "3d" makes the same character as a 3D body that is drawn cel-shaded, so it still looks 2D. It is posed through the same bones; set_joint_3d additionally turns any joint in depth (for example head y to look left and right). add_3d_shape adds solids, and 3D model layers have rotX (tilt), rotY (turn) and rotZ (roll), all keyable.
- generate_asset draws a background, prop, scenery piece, effect or texture with the user's OpenAI image key (it costs them money: use it when art is asked for or clearly needed, not for things simple shapes do well). trace_image turns a picture into vector shapes; image_to_3d puffs a cut-out picture into a 3D object.

Directing an animation
When the user asks for an animation, a scene or a shot, you are the director and the animator. Work in this order:
1. Plan briefly in your head: the beats of the action, how long each takes, where the camera is, and which view each character is in.
2. Stage it: background and props at sensible depths, characters placed where the action needs them.
3. Block the main poses and movement first (actions, travel, turns), then add the detail: anticipation before a move, overlap and settle after it, blinks, head turns, hands and fingers, lip-sync, a camera move if it helps the shot.
4. Review like an audience would: call look at four or more frames spread across the shot, including the middle of fast moves. Look for sliding feet, stiff or symmetrical poses, things popping, dead time, bad staging and clipping. Fix what you find and look again.
5. Report in a few plain sentences what the shot is, then ask the user one specific question about how to improve it.
Good animation has clear poses, varied timing (not everything on even beats), arcs instead of straight lines, weight (things ease in and out, heavy things move slower), and something always alive (a blink, a breath).

Learning from the user
- When the user rates your work or tells you what is wrong, take it seriously: study the result with look, say what you now see is weak, fix it, and check again.
- After acting on feedback, call remember with one or two short lessons. A good lesson is general and reusable ("This user wants snappier timing: hold key poses longer and move between them in 4 to 6 frames"), not a description of this one scene. Also remember stated preferences (style, pacing, how characters should move) whenever the user tells you one.
- Never claim you retrained or changed permanently. What you have is your saved lessons, which you are given at the start of every conversation.

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
    // Lessons from earlier sessions travel with the instructions, so they apply from the first message.
    const system = SYSTEM_PROMPT + memoryPrompt();
    session = provider === 'openai' ? openaiSession(key, model, system) : anthropicSession(key, model, system);
    sessionKey = sig;
  }
  return session;
}

export function resetChat(): void {
  stopAssistant();
  session = null;
  sessionKey = '';
  useChat.setState({ items: [], busy: false, lastTurnSteps: 0, lastRequest: '', awaitingFeedback: false });
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

// A full shot (stage, animate, review, polish) takes many tool calls.
const MAX_STEPS = 200;

/**
 * Sends a user message and runs the assistant until it finishes its turn. `shown` is what appears
 * in the conversation when the message itself carries instructions the user did not type.
 */
export async function sendToAssistant(text: string, shown = text): Promise<void> {
  if (useChat.getState().busy) return;
  push({ kind: 'user', id: nextId++, text: shown });
  if (shown === text) useChat.setState({ lastRequest: text });
  let s: Session;
  try {
    s = ensureSession();
  } catch (err) {
    push({ kind: 'error', id: nextId++, text: err instanceof Error ? err.message : String(err) });
    return;
  }
  abort = new AbortController();
  const undoBefore = doc.undoStack.length;
  useChat.setState({ busy: true, lastTurnSteps: 0, awaitingFeedback: false });
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
      // Work that changed the project is worth a rating.
      awaitingFeedback: doc.undoStack.length > undoBefore,
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

/** What the assistant last said about its own work. */
function lastReply(): string {
  const items = useChat.getState().items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'assistant' && it.text.trim()) return it.text;
  }
  return '';
}

const REVIEW = `Review it as a demanding animation director would:
1. Call look at five or more frames spread across the shot, including the middle of every fast move.
2. Say honestly, in two or three sentences, what is weak. Consider timing and spacing, anticipation and follow-through, arcs, weight, stiff or mirrored poses, sliding feet, staging, dead time, lip-sync and the camera.
3. Fix those things with your tools.
4. Look again to confirm the fixes read well.
5. Call remember with one or two short, general lessons that will make your next animation better for this user.
6. Finish by saying what you changed, then ask one specific question about what to improve next.`;

/**
 * Records the user's rating of the last result. A rating below "good" sends the assistant back to
 * study its own work, repair it and save what it learned.
 */
export async function giveFeedback(rating: Rating, comment = ''): Promise<void> {
  const chat = useChat.getState();
  if (chat.busy) return;
  recordFeedback(rating, comment, chat.lastRequest, lastReply());
  useChat.setState({ awaitingFeedback: false });
  const said = comment.trim();
  if (rating === 'good') {
    if (!said) {
      push({ kind: 'note', id: nextId++, text: 'Rated good. Saved to memory.' });
      return;
    }
    return sendToAssistant(
      `The user rated your last result GOOD and said: "${said}". Do not change the scene. Call remember with one short, general lesson about what this user likes, then acknowledge in one sentence.`,
      `Rated good: ${said}`,
    );
  }
  const verdict = rating === 'meh' ? 'MEH: acceptable but not good enough' : 'BAD: it does not work';
  return sendToAssistant(
    `The user rated your last result ${verdict}.${said ? ` Their comment: "${said}".` : ' They gave no details, so finding the problems is your job.'}\n\n${REVIEW}`,
    `Rated ${rating}${said ? `: ${said}` : ''}`,
  );
}

/** Sends the assistant back over its last result without waiting for the user to complain. */
export function polish(): Promise<void> {
  return sendToAssistant(`Before the user rates it, improve your last result yourself.\n\n${REVIEW}`, 'Polish it: review your own work and improve it');
}
