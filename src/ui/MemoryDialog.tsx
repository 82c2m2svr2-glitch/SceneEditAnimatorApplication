import { Brain, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { addLesson, clearMemory, removeLesson, setMemoryEnabled, useMemory } from '../ai/memory';
import { useUI } from '../state/ui';
import { Dialog } from './widgets';

const RATING = { good: 'Good', meh: 'Meh', bad: 'Bad' };

/** Everything the assistant has learned from this user: readable, editable and erasable. */
export function MemoryDialog() {
  const set = useUI((s) => s.set);
  const memory = useMemory();
  const [text, setText] = useState('');
  const close = () => set({ dialog: null });
  const add = () => {
    if (addLesson(text, 'preference', 'user')) setText('');
  };
  return (
    <Dialog
      wide
      title={<><Brain size={17} /> Assistant memory</>}
      onClose={close}
      footer={
        <>
          <label className="hint" style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={memory.enabled} onChange={(e) => setMemoryEnabled(e.target.checked)} /> Use memory (lessons are given to the assistant at the start of each conversation)
          </label>
          <button className="btn" disabled={!memory.lessons.length && !memory.feedback.length} onClick={() => confirm('Erase every lesson and rating? This cannot be undone.') && clearMemory()}><Trash2 size={13} /> Erase all</button>
          <button className="btn primary" onClick={close}>Done</button>
        </>
      }
    >
      <div className="hint">
        The assistant cannot retrain itself, so it keeps notes instead. Your ratings are recorded here, it writes a lesson each time it acts on feedback, and
        those lessons guide its later work. Everything stays on this computer. A new conversation picks up lessons added since the current one began.
      </div>
      <div className="memory-add">
        <input type="text" value={text} placeholder='Teach it something yourself, for example "I like snappy, exaggerated motion"' onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
        <button className="btn" disabled={text.trim().length < 8} onClick={add}><Plus size={13} /> Add</button>
      </div>
      <b>Lessons ({memory.lessons.length})</b>
      {memory.lessons.length === 0 && <div className="empty">No lessons yet. Rate the assistant's work in the chat panel and it will start learning what you like.</div>}
      <div className="memory-list">
        {[...memory.lessons].reverse().map((l) => (
          <div key={l.id} className="memory-item">
            <span className="chip">{l.topic}</span>
            <span style={{ flex: 1 }}>{l.text}</span>
            <small className="hint">{l.source === 'user' ? 'you' : 'assistant'}, {new Date(l.createdAt).toLocaleDateString()}</small>
            <button className="icon-btn sm" title="Forget this lesson" onClick={() => removeLesson(l.id)}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
      <b>Your ratings ({memory.feedback.length})</b>
      <div className="memory-list">
        {[...memory.feedback].reverse().slice(0, 40).map((f) => (
          <div key={f.id} className="memory-item">
            <span className={`chip rate-${f.rating}`}>{RATING[f.rating]}</span>
            <span style={{ flex: 1 }}>{f.request || '(no request recorded)'}{f.comment && <><br /><i>"{f.comment}"</i></>}</span>
            <small className="hint">{new Date(f.at).toLocaleDateString()}</small>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
