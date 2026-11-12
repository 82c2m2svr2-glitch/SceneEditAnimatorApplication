import { create } from 'zustand';
import { newId } from '../core/ids';

/**
 * The assistant's memory: what the user thought of its work, and the lessons drawn from that.
 *
 * A language model cannot retrain itself inside the app. What it can do is keep notes: every
 * rating and comment is recorded here, the assistant writes short lessons after reviewing its own
 * work, and those lessons are handed back to it at the start of every later conversation. The
 * memory lives on this computer only and can be read, edited and cleared by the user.
 */

export type Rating = 'good' | 'meh' | 'bad';

export interface Lesson {
  id: string;
  text: string;
  /** Short subject such as "walk cycles", "camera" or "lip-sync". */
  topic: string;
  createdAt: number;
  /** Who wrote it: the assistant after feedback, the assistant on its own, or the user by hand. */
  source: 'feedback' | 'self' | 'user';
}

export interface FeedbackEntry {
  id: string;
  at: number;
  rating: Rating;
  comment: string;
  /** What the user had asked for. */
  request: string;
  /** How the assistant described what it made. */
  result: string;
}

interface MemoryState {
  enabled: boolean;
  lessons: Lesson[];
  feedback: FeedbackEntry[];
}

const KEY = 'dreamforge.memory.v1';
const MAX_LESSONS = 80;
const MAX_FEEDBACK = 200;

function load(): MemoryState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && Array.isArray(raw.lessons) && Array.isArray(raw.feedback)) return { enabled: raw.enabled !== false, lessons: raw.lessons, feedback: raw.feedback };
  } catch {}
  return { enabled: true, lessons: [], feedback: [] };
}

export const useMemory = create<MemoryState>(() => load());

function save(patch: Partial<MemoryState>): void {
  useMemory.setState(patch);
  try {
    const { enabled, lessons, feedback } = useMemory.getState();
    localStorage.setItem(KEY, JSON.stringify({ enabled, lessons, feedback }));
  } catch {}
}

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Stores a lesson. A lesson that says the same as an existing one replaces it instead of piling up. */
export function addLesson(text: string, topic = 'general', source: Lesson['source'] = 'self'): Lesson | null {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 400);
  if (clean.length < 8) return null;
  const lesson: Lesson = { id: newId('les'), text: clean, topic: topic.trim().slice(0, 40) || 'general', createdAt: Date.now(), source };
  const rest = useMemory.getState().lessons.filter((l) => normal(l.text) !== normal(clean));
  save({ lessons: [...rest, lesson].slice(-MAX_LESSONS) });
  return lesson;
}

export function removeLesson(id: string): void {
  save({ lessons: useMemory.getState().lessons.filter((l) => l.id !== id) });
}

export function recordFeedback(rating: Rating, comment: string, request: string, result: string): FeedbackEntry {
  const entry: FeedbackEntry = { id: newId('fb'), at: Date.now(), rating, comment: comment.trim().slice(0, 600), request: request.slice(0, 600), result: result.slice(0, 600) };
  save({ feedback: [...useMemory.getState().feedback, entry].slice(-MAX_FEEDBACK) });
  return entry;
}

export function setMemoryEnabled(enabled: boolean): void {
  save({ enabled });
}

export function clearMemory(): void {
  save({ lessons: [], feedback: [] });
}

/** The part of the assistant's instructions that carries what it has learned from this user. */
export function memoryPrompt(state: MemoryState = useMemory.getState()): string {
  if (!state.enabled) return '';
  const lines: string[] = [];
  if (state.lessons.length) {
    lines.push('Lessons you saved from earlier work with this user. Follow them; they outrank your defaults:');
    for (const l of state.lessons.slice(-40)) lines.push(`- [${l.topic}] ${l.text}`);
  }
  const recent = state.feedback.slice(-6);
  if (recent.length) {
    lines.push('', 'The most recent ratings of your work (oldest first):');
    for (const f of recent) lines.push(`- ${f.rating.toUpperCase()}: asked for "${f.request.slice(0, 140)}"${f.comment ? `; the user said "${f.comment.slice(0, 200)}"` : ''}`);
  }
  if (!lines.length) return '';
  return `\n\nWhat you remember\n${lines.join('\n')}`;
}
