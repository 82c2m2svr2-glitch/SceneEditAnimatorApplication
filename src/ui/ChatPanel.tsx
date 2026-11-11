import { Bot, Check, CircleAlert, Loader2, RotateCcw, Send, Square, Trash2, Undo2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { answerPlan, resetChat, sendToAssistant, stopAssistant, undoLastTurn, useChat } from '../ai/agent';
import { useSettings } from '../state/settings';
import { useUI } from '../state/ui';

const SUGGESTIONS = [
  'Build a park scene: sky, sun, hills, a tree and a path',
  'Make the character walk in from the left, stop in the middle and wave',
  'Add a slow camera push-in on the character over the whole scene',
  'Make it snow, and add a second character who says "Hello there!"',
];

export function ChatPanel() {
  const items = useChat((s) => s.items);
  const busy = useChat((s) => s.busy);
  const steps = useChat((s) => s.lastTurnSteps);
  const provider = useSettings((s) => s.assistantProvider);
  const mode = useSettings((s) => s.aiMode);
  const update = useSettings((s) => s.update);
  const hasKey = useSettings((s) => (s.assistantProvider === 'openai' ? !!s.openaiKey : !!s.anthropicKey));
  const model = useSettings((s) => (s.assistantProvider === 'openai' ? s.openaiModel : s.anthropicModel));
  const set = useUI((s) => s.set);
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items]);

  const send = (t = text) => {
    const msg = t.trim();
    if (!msg || busy) return;
    setText('');
    void sendToAssistant(msg);
  };

  return (
    <div className="chat">
      <div className="panel-head">
        <Bot size={13} /> <span style={{ flex: 1 }}>Assistant</span>
        <div className="seg" title="Auto: the assistant changes the project directly (every change can be undone). Ask first: it shows what it wants to change and waits for you.">
          <button className={mode === 'auto' ? 'on' : ''} onClick={() => update({ aiMode: 'auto' })}>Auto</button>
          <button className={mode === 'ask' ? 'on' : ''} onClick={() => update({ aiMode: 'ask' })}>Ask first</button>
        </div>
        <button className="icon-btn sm" title="Clear conversation" onClick={resetChat}><Trash2 size={12} /></button>
        <button className="icon-btn sm" title="Hide assistant" onClick={() => set({ showChat: false })}><X size={13} /></button>
      </div>
      <div className="chat-log" ref={logRef}>
        {items.length === 0 && (
          <>
            <div className="hint" style={{ fontSize: 12 }}>
              Ask for anything you could do by hand: build scenes, pose and animate characters, move the camera, add effects. The assistant works inside this project and you can undo whatever it does.
            </div>
            {!hasKey && (
              <div className="note warn">
                Add your {provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key to use the assistant.{' '}
                <button className="btn" style={{ marginTop: 6 }} onClick={() => set({ dialog: 'settings' })}>Open Settings</button>
              </div>
            )}
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn ghost" style={{ height: 'auto', padding: '6px 8px', whiteSpace: 'normal', textAlign: 'left', justifyContent: 'flex-start', border: '1px solid var(--line)' }} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case 'user': return <div key={it.id} className="msg user">{it.text}</div>;
            case 'assistant': return <div key={it.id} className="msg ai">{it.text}{it.streaming && ' ▍'}</div>;
            case 'error': return <div key={it.id} className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {it.text}</div>;
            case 'note': return <div key={it.id} className="hint">{it.text}</div>;
            case 'tool':
              return (
                <div key={it.id} className={`toolcall${it.ok ? '' : ' fail'}`}>
                  {it.ok ? <Wrench size={12} style={{ marginTop: 2, flexShrink: 0 }} /> : <CircleAlert size={12} style={{ marginTop: 2, flexShrink: 0, color: 'var(--danger)' }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{it.summary}</b>
                    {!it.ok && <div className="res">{it.result}</div>}
                    {it.image && <img src={it.image} alt="What the assistant saw" style={{ width: '100%', borderRadius: 4, marginTop: 4, display: 'block' }} />}
                  </div>
                </div>
              );
            case 'plan':
              return (
                <div key={it.id} className="plan">
                  <b>{it.state === 'waiting' ? 'The assistant wants to:' : it.state === 'approved' ? 'Approved:' : 'Declined:'}</b>
                  <ol>{it.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  {it.state === 'waiting' && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn primary" style={{ flex: 1 }} onClick={() => answerPlan(true)}><Check size={13} /> Apply</button>
                      <button className="btn" style={{ flex: 1 }} onClick={() => answerPlan(false)}><X size={13} /> Decline</button>
                    </div>
                  )}
                </div>
              );
          }
        })}
        {busy && <div className="hint"><Loader2 size={12} className="spin" style={{ verticalAlign: -2 }} /> Working…</div>}
        {!busy && steps > 0 && (
          <button className="btn" onClick={undoLastTurn} title="Reverts everything the assistant changed for your last message">
            <Undo2 size={13} /> Undo all {steps} change{steps > 1 ? 's' : ''} from this request
          </button>
        )}
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          placeholder="Ask the assistant to build, pose or animate…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="chip" title="Change the provider and model in Settings" style={{ cursor: 'pointer' }} onClick={() => set({ dialog: 'settings' })}>
            {provider === 'openai' ? 'ChatGPT' : 'Claude'} · {model}
          </span>
          <span className="spacer" />
          {busy ? (
            <button className="btn" onClick={stopAssistant}><Square size={12} /> Stop</button>
          ) : (
            <>
              {items.length > 0 && <button className="icon-btn" title="New conversation" onClick={resetChat}><RotateCcw size={13} /></button>}
              <button className="btn primary" disabled={!text.trim()} onClick={() => send()}><Send size={13} /> Send</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
