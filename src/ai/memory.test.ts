import { beforeEach, describe, expect, it } from 'vitest';
import { addLesson, clearMemory, memoryPrompt, recordFeedback, removeLesson, setMemoryEnabled, useMemory } from './memory';

describe('assistant memory', () => {
  beforeEach(() => {
    clearMemory();
    setMemoryEnabled(true);
  });

  it('keeps lessons, replacing one that says the same thing', () => {
    expect(addLesson('Hold key poses for at least six frames.', 'timing')).not.toBeNull();
    addLesson('hold key poses for at least six frames', 'pacing');
    addLesson('Keep the camera still during dialogue.', 'camera');
    expect(useMemory.getState().lessons.map((l) => l.topic)).toEqual(['pacing', 'camera']);
    expect(addLesson('ok')).toBeNull();
    removeLesson(useMemory.getState().lessons[0].id);
    expect(useMemory.getState().lessons).toHaveLength(1);
  });

  it('never grows without bound', () => {
    for (let i = 0; i < 120; i++) addLesson(`Lesson number ${i} about animation craft.`);
    expect(useMemory.getState().lessons).toHaveLength(80);
    expect(useMemory.getState().lessons.at(-1)!.text).toContain('119');
  });

  it('turns lessons and recent ratings into instructions, and nothing when empty or switched off', () => {
    expect(memoryPrompt()).toBe('');
    addLesson('Use snappy timing.', 'timing');
    recordFeedback('meh', 'too floaty', 'make her jump', 'She jumps.');
    const prompt = memoryPrompt();
    expect(prompt).toContain('[timing] Use snappy timing.');
    expect(prompt).toContain('MEH: asked for "make her jump"; the user said "too floaty"');
    setMemoryEnabled(false);
    expect(memoryPrompt()).toBe('');
  });
});
