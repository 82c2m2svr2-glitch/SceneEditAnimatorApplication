import { CircleAlert, Download, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP_VERSION, checkForUpdates, type UpdateInfo } from '../state/updates';
import { useUI } from '../state/ui';
import { Dialog } from './widgets';

/** Help > Check for updates: compares this copy with the newest published release. */
export function UpdateDialog() {
  const set = useUI((s) => s.set);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  const check = () => {
    const ac = new AbortController();
    setBusy(true);
    setError('');
    checkForUpdates(ac.signal)
      .then(setInfo, (err) => !ac.signal.aborted && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  };
  useEffect(check, []);

  const close = () => set({ dialog: null });
  return (
    <Dialog
      title={<><RefreshCw size={17} /> Updates</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>You have version {APP_VERSION}.</span>
          <button className="btn" onClick={close}>Close</button>
          {!info?.newer && <button className="btn" disabled={busy} onClick={check}>{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check again</button>}
          {info?.newer && (
            <a className="btn primary" href={info.download ?? info.page} target="_blank" rel="noreferrer"><Download size={14} /> Download {info.latest}</a>
          )}
        </>
      }
    >
      {busy && !info && <div className="hint"><Loader2 size={13} className="spin" style={{ verticalAlign: -2 }} /> Checking for a newer version…</div>}
      {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
      {info && !info.newer && <div className="note">DreamForge is up to date. Version {info.latest} is the newest release.</div>}
      {info?.newer && (
        <>
          <div className="note"><b>Version {info.latest} is available.</b> Download it, close DreamForge, and run the new file in place of this one. Your projects and saved characters are kept.</div>
          {info.notes && <pre className="update-notes">{info.notes}</pre>}
          <a className="hint" href={info.page} target="_blank" rel="noreferrer">Open the release page</a>
        </>
      )}
    </Dialog>
  );
}
