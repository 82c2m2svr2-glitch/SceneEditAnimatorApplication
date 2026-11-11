import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { listAnthropicModels, listOpenAIModels } from '../ai/providers';
import { useSettings, type ProviderId } from '../state/settings';
import { useUI } from '../state/ui';
import { Dialog } from './widgets';

function ModelField(props: { label: string; value: string; onChange: (v: string) => void; options: string[]; filter?: (id: string) => boolean }) {
  const opts = props.options.filter(props.filter ?? (() => true));
  const listId = `models-${props.label.replace(/\W+/g, '')}`;
  return (
    <div className="form-row">
      <label>{props.label}</label>
      <div>
        <input type="text" list={listId} value={props.value} onChange={(e) => props.onChange(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
        <datalist id={listId}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const s = useSettings();
  const set = useUI((u) => u.set);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [loading, setLoading] = useState<ProviderId | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const check = async (provider: ProviderId) => {
    setLoading(provider);
    setStatus(null);
    try {
      if (provider === 'openai') {
        const list = await listOpenAIModels(s.openaiKey);
        setOpenaiModels(list);
        setStatus({ kind: 'ok', text: `OpenAI key works. ${list.length} models available; start typing in a model box to pick one.` });
      } else {
        const list = await listAnthropicModels(s.anthropicKey);
        setAnthropicModels(list);
        setStatus({ kind: 'ok', text: `Anthropic key works. ${list.length} models available.` });
      }
    } catch (err) {
      setStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(null);
    }
  };

  return (
    <Dialog title="Settings" onClose={() => set({ dialog: null })} footer={<><span className="spacer" /><button className="btn primary" onClick={() => set({ dialog: null })}>Done</button></>}>
      <div className="note">
        Keys are stored only on this computer{window.dreamforge ? ', in the operating system credential store,' : ' (in this browser\'s local storage)'} and are sent only to the service they belong to. Usage is billed to your own account with that service.
      </div>

      <b>OpenAI (ChatGPT)</b>
      <div className="form-row">
        <label>API key</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="password" placeholder="sk-…" value={s.openaiKey} autoComplete="off" onChange={(e) => s.update({ openaiKey: e.target.value.trim() })} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" disabled={!s.openaiKey || loading !== null} onClick={() => void check('openai')}>
            {loading === 'openai' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Test
          </button>
        </div>
      </div>
      <ModelField label="Assistant model" value={s.openaiModel} onChange={(v) => s.update({ openaiModel: v })} options={openaiModels} filter={(id) => /^(gpt|o\d|chatgpt)/.test(id) && !id.includes('image')} />
      <ModelField label="Character image model" value={s.imageModel} onChange={(v) => s.update({ imageModel: v })} options={openaiModels} filter={(id) => id.includes('image')} />
      <ModelField label="Image-to-vector model" value={s.visionModel} onChange={(v) => s.update({ visionModel: v })} options={openaiModels} filter={(id) => /^(gpt|o\d|chatgpt)/.test(id) && !id.includes('image')} />
      <div className="hint">The OpenAI key powers the Character Creator button and, if you choose it below, the assistant.</div>

      <b style={{ marginTop: 6 }}>Anthropic (Claude)</b>
      <div className="form-row">
        <label>API key</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="password" placeholder="sk-ant-…" value={s.anthropicKey} autoComplete="off" onChange={(e) => s.update({ anthropicKey: e.target.value.trim() })} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" disabled={!s.anthropicKey || loading !== null} onClick={() => void check('anthropic')}>
            {loading === 'anthropic' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Test
          </button>
        </div>
      </div>
      <ModelField label="Assistant model" value={s.anthropicModel} onChange={(v) => s.update({ anthropicModel: v })} options={anthropicModels} />
      <div className="hint">
        With Claude models that support it, a request the model declines is retried automatically on a fallback Claude model.
      </div>

      <b style={{ marginTop: 6 }}>Assistant</b>
      <div className="form-row">
        <label>Powered by</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={s.assistantProvider === 'openai' ? 'on' : ''} onClick={() => s.update({ assistantProvider: 'openai' })}>ChatGPT</button>
          <button className={s.assistantProvider === 'anthropic' ? 'on' : ''} onClick={() => s.update({ assistantProvider: 'anthropic' })}>Claude</button>
        </div>
      </div>
      <div className="form-row">
        <label>When it edits</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={s.aiMode === 'auto' ? 'on' : ''} onClick={() => s.update({ aiMode: 'auto' })}>Act right away (undoable)</button>
          <button className={s.aiMode === 'ask' ? 'on' : ''} onClick={() => s.update({ aiMode: 'ask' })}>Ask me first</button>
        </div>
      </div>
      {status && <div className={`note ${status.kind === 'err' ? 'err' : ''}`}>{status.text}</div>}
    </Dialog>
  );
}
