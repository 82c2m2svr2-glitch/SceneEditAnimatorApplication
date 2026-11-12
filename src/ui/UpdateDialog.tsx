import { CircleAlert, Download, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { saveToLibrary } from '../state/persistence';
import { doc } from '../state/store';
import { APP_VERSION, checkForUpdates, useUpdate, type UpdateInfo } from '../state/updates';
import { useUI } from '../state/ui';
import { Dialog } from './widgets';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** View > Check for updates, or the Update button: finds the newest release and installs it. */
export function UpdateDialog() {
  const set = useUI((s) => s.set);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  /** Whether this copy can replace itself, or why not. */
  const [self, setSelf] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [installing, setInstalling] = useState<'download' | 'restart' | null>(null);
  const native = window.dreamforge;

  const check = () => {
    const ac = new AbortController();
    setBusy(true);
    setError('');
    checkForUpdates(ac.signal)
      .then((found) => {
        setInfo(found);
        useUpdate.setState({ available: found.newer ? found : null });
      }, (err) => !ac.signal.aborted && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  };
  useEffect(check, []);
  useEffect(() => {
    if (!native?.canSelfUpdate) return setSelf({ ok: false });
    native.canSelfUpdate().then(setSelf, () => setSelf({ ok: false }));
  }, [native]);
  useEffect(() => native?.onUpdateProgress?.(setProgress), [native]);

  const canInstall = !!(info?.newer && info.download && self?.ok && native?.installUpdate);

  const install = async () => {
    if (!info?.download || !native?.installUpdate) return;
    setError('');
    setInstalling('download');
    setProgress(null);
    try {
      // The open project goes to Recent projects first, so nothing is lost when DreamForge restarts.
      if (doc.project) await saveToLibrary();
      const res = await native.installUpdate({ url: info.download, size: info.downloadSize, sha256: info.sha256 });
      if (!res.ok) throw new Error(res.error ?? 'The update could not be installed.');
      setInstalling('restart');
    } catch (err) {
      setInstalling(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const close = () => {
    if (installing) return;
    set({ dialog: null });
  };
  const pct = progress?.total ? Math.min(100, (progress.received / progress.total) * 100) : 0;

  return (
    <Dialog
      title={<><RefreshCw size={17} /> Updates</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>You have version {APP_VERSION}.</span>
          <button className="btn" disabled={!!installing} onClick={close}>Close</button>
          {!info?.newer && <button className="btn" disabled={busy} onClick={check}>{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check again</button>}
          {info?.newer && (canInstall
            ? (
              <button className="btn primary" disabled={!!installing} onClick={() => void install()}>
                {installing ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {installing === 'restart' ? 'Restarting…' : installing ? 'Updating…' : `Update now to ${info.latest}`}
              </button>
            )
            : <a className="btn primary" href={info.download ?? info.page} target="_blank" rel="noreferrer"><Download size={14} /> Download {info.latest}</a>)}
        </>
      }
    >
      {busy && !info && <div className="hint"><Loader2 size={13} className="spin" style={{ verticalAlign: -2 }} /> Checking for a newer version…</div>}
      {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
      {info && !info.newer && <div className="note">DreamForge is up to date. Version {info.latest} is the newest release.</div>}
      {info?.newer && (
        <>
          {installing === 'download' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="progress"><i style={{ width: `${pct}%` }} /></div>
              <span className="hint">{progress ? `Downloading ${mb(progress.received)}${progress.total ? ` of ${mb(progress.total)}` : ''}…` : 'Saving your project and starting the download…'}</span>
            </div>
          )}
          {installing === 'restart' && <div className="note">Version {info.latest} is downloaded and checked. DreamForge is closing and will open again on the new version in a few seconds.</div>}
          {!installing && (
            <div className="note">
              <b>Version {info.latest} is available.</b>{' '}
              {canInstall
                ? 'Update now downloads it, saves your project to Recent projects, and restarts DreamForge on the new version. Your projects, characters, settings and API keys are kept.'
                : 'Download it, close DreamForge, and run the new file in place of this one. Your projects and saved characters are kept.'}
              {!canInstall && self?.reason && <><br /><span className="hint">{self.reason}</span></>}
            </div>
          )}
          {info.notes && <pre className="update-notes">{info.notes}</pre>}
          <a className="hint" href={info.page} target="_blank" rel="noreferrer">Open the release page</a>
        </>
      )}
    </Dialog>
  );
}
