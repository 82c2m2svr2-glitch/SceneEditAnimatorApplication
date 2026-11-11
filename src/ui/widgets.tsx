import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toHex } from '../core/color';
import { doc } from '../state/store';

/** Number input with a draggable label (scrub) and Enter/blur commit. */
export function NumberField(props: {
  label?: string;
  value: number | undefined;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  /** Undo label for a scrub gesture, which is grouped into one step. */
  undoLabel?: string;
  title?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  const { value, onChange, step = 1, min = -Infinity, max = Infinity, precision = 2 } = props;
  const fmt = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '' : String(Math.round(v * 10 ** precision) / 10 ** precision));
  const [text, setText] = useState(fmt(value));
  const [editing, setEditing] = useState(false);
  const scrub = useRef<{ x: number; v: number } | null>(null);
  useEffect(() => {
    if (!editing) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing]);
  const clampV = (v: number) => Math.max(min, Math.min(max, v));
  const commit = () => {
    setEditing(false);
    // Allow simple arithmetic like "120+30" or "50*2".
    let v = Number(text);
    if (Number.isNaN(v) && /^[\d\s.+\-*/()]+$/.test(text)) {
      try {
        v = Number(new Function(`return (${text})`)());
      } catch {}
    }
    if (!Number.isFinite(v)) return setText(fmt(value));
    v = clampV(v);
    if (v !== value) onChange(v);
    setText(fmt(v));
  };
  return (
    <div className="field" title={props.title}>
      {props.label !== undefined && (
        <span
          className="lbl"
          onPointerDown={(e) => {
            if (props.disabled || value === undefined) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            scrub.current = { x: e.clientX, v: value };
            doc.begin(props.undoLabel ?? 'Edit value');
          }}
          onPointerMove={(e) => {
            const s = scrub.current;
            if (!s) return;
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            onChange(clampV(s.v + Math.round(e.clientX - s.x) * step * mult));
          }}
          onPointerUp={() => {
            if (scrub.current) doc.commit();
            scrub.current = null;
          }}
        >
          {props.label}
        </span>
      )}
      <input
        className="num"
        type="text"
        inputMode="decimal"
        disabled={props.disabled}
        value={text}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(fmt(value));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== undefined) {
            e.preventDefault();
            const v = clampV(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(v);
            setText(fmt(v));
          }
          e.stopPropagation();
        }}
      />
      {props.suffix && <span className="lbl plain">{props.suffix}</span>}
    </div>
  );
}

/** Text input that commits on Enter/blur so typing is a single undo step. */
export function TextField(props: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; multiline?: boolean; live?: boolean }) {
  const [text, setText] = useState(props.value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(props.value);
  }, [props.value, editing]);
  const commit = () => {
    setEditing(false);
    if (text !== props.value) props.onChange(text);
  };
  const common = {
    className: props.className,
    value: text,
    placeholder: props.placeholder,
    onFocus: () => setEditing(true),
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      if (props.live) props.onChange(e.target.value);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (!props.multiline || e.ctrlKey || e.metaKey)) (e.target as HTMLElement).blur();
      if (e.key === 'Escape') {
        setText(props.value);
        setEditing(false);
        (e.target as HTMLElement).blur();
      }
    },
  };
  return props.multiline ? <textarea rows={3} style={{ flex: 1, width: '100%' }} {...common} /> : <input type="text" style={{ flex: 1 }} {...common} />;
}

export function ColorField(props: { value: string | null; onChange: (v: string | null) => void; allowNone?: boolean; title?: string }) {
  const { value } = props;
  return (
    <div className="field" title={props.title}>
      <span className={`swatch${value ? '' : ' none'}`}>
        {value && <i style={{ background: value }} />}
        <input
          type="color"
          value={value ? toHex(value) : '#000000'}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </span>
      {props.allowNone && (
        <button className="icon-btn sm" title={value ? 'Remove' : 'Add'} onClick={() => props.onChange(value ? null : '#ffffff')}>
          {value ? <X size={12} /> : '+'}
        </button>
      )}
    </div>
  );
}

export function KeyDot(props: { state: 'none' | 'track' | 'on'; onClick: () => void; title?: string }) {
  return (
    <button
      className={`keydot ${props.state === 'none' ? '' : props.state}`}
      title={props.title ?? (props.state === 'on' ? 'Remove keyframe' : 'Add keyframe at the playhead')}
      onClick={props.onClick}
    >
      <i />
    </button>
  );
}

export function Section(props: { title: string; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={{ flex: 1 }}>{props.title}</span>
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2 }}>
          {props.actions}
        </span>
      </div>
      {open && <div className="section-body">{props.children}</div>}
    </div>
  );
}

export function Row(props: { name?: string; children: ReactNode; title?: string }) {
  return (
    <div className="row" title={props.title}>
      {props.name !== undefined && <span className="name">{props.name}</span>}
      <div className="grow">{props.children}</div>
    </div>
  );
}

export function Dialog(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`dialog${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>{props.title}</span>
          <button className="icon-btn" onClick={props.onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{props.children}</div>
        {props.footer && <div className="dialog-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/** Dropdown menu anchored to its button; closes on outside click or selection. */
export function Menu(props: { label: ReactNode; children: (close: () => void) => ReactNode; className?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div className="menu-root" ref={ref}>
      <button className={`${props.className ?? 'menu-btn'}${open ? ' open' : ''}`} title={props.title} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && <div className="menu-pop">{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem(props: { label: ReactNode; kbd?: string; onClick: () => void; disabled?: boolean; icon?: ReactNode }) {
  return (
    <button className="menu-item" disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
      {props.kbd && <span className="kbd">{props.kbd}</span>}
    </button>
  );
}
