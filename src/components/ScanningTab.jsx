import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, TextField, Typography, CircularProgress } from '@mui/material';
import ScanHistoryGrid from './ScanHistoryGrid';
import { soundFx } from '../utils/audio';

export default function ScanningTab({ manager, onSearch, onCoverMatch, onVoid, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);
  const [result, setResult] = useState(() => manager.pending ? null : manager.lastConfirmed || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => manager.subscribe?.((type, scan) => {
    if (type !== 'SCAN_CONFIRMED' || guard.current) return;
    setResult(scan); setError(''); setValue('');
    if (scan.statusType === 'PACK') soundFx.copySuccess(); else soundFx.duplicateWarning();
    input.current?.focus();
  }), [manager]);
  const submit = async (retry = false) => {
    if (guard.current || (!retry && !value.trim())) return;
    guard.current = true; setBusy(true); setError(''); setResult(null);
    soundFx.init();
    try {
      const entry = await (retry ? manager.retryPending() : manager.markPacked(value.trim()));
      setResult(entry); setValue('');
      if (entry.statusType === 'PACK') soundFx.copySuccess(); else soundFx.duplicateWarning();
    } catch (e) { setError(e.message); soundFx.duplicateWarning(); }
    finally { guard.current = false; setBusy(false); input.current?.focus(); }
  };
  const locked = busy || manager.busy || !manager.ready || !!manager.pending;
  const undoScan = useCallback(async scan => {
    if (window.confirm(`Remove ${scan.title || scan.isbn} (Order ${scan.order || '—'}) from packing?`)) {
      await onVoid(scan);
      setResult(null);
    }
  }, [onVoid]);
  return <section className="scanner-panel">
    {!manager.ready && manager.connected && <Alert severity="warning">Import and reconcile packing history on the central computer before scanning.</Alert>}
    {!manager.connected && <Alert severity="warning">Reconnecting to the server. Pending scans retry automatically; keep the book until its result is confirmed.</Alert>}
    {manager.pending && <Alert severity="warning" action={<Button disabled={busy || manager.busy || !manager.connected} onClick={() => submit(true)}>Retry now</Button>}>Confirming scan: {manager.pending.isbn}. Recovery retries automatically. Keep this book aside until its result appears.</Alert>}
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <TextField fullWidth inputRef={input} value={value} onChange={e => setValue(e.target.value)} autoComplete="off" placeholder="Scan or type an ISBN-13" slotProps={{ htmlInput: { readOnly: locked, 'aria-label': 'ISBN barcode', spellCheck: false }, input: { endAdornment: <Button type="submit" disabled={locked || !value.trim()}>{busy ? <CircularProgress size={18} /> : 'Scan'}</Button> } }} sx={{ '& input': { fontFamily: 'Roboto Mono, monospace', fontSize: { xs: 16, sm: 20 }, py: 2 } }} />
    </form>
    {error && !manager.pending && <Alert severity="error">{error}</Alert>}
    <div className="scanner-feedback" aria-live="assertive" aria-atomic="true">
      {(busy || manager.busy) && !manager.pending && <Alert severity="info">Saving scan… Keep this book in hand.</Alert>}
      {result && !manager.pending && !busy && !manager.busy && <Alert severity={result.statusType === 'PACK' ? 'success' : result.statusType === 'DUPLICATE' ? 'error' : 'warning'} sx={{ alignItems: 'center', py: 2, '& .MuiAlert-icon': { fontSize: 36 }, '& .MuiAlert-message': { minWidth: 0 } }}>
        <Typography component="div" sx={{ fontWeight: 800, fontSize: { xs: 'clamp(36px, 10vw, 54px)', sm: '120px' }, lineHeight: 1.05, mb: 1 }}>{result.statusType === 'PACK' ? `BOX ${result.order}` : result.statusType.replaceAll('_', ' ')}</Typography>
        <Typography variant="body2">{result.title || result.isbn} · {result.status}</Typography>
        {result.statusType === 'NOT_FOUND' && <><Button onClick={() => onSearch('')}>Search by title</Button>
          {onCoverMatch && <Button onClick={onCoverMatch}>Match book cover</Button>}</>}
      </Alert>}
    </div>
    <ScanHistoryGrid editableFromSeq={manager.editableFromSeq || 1} isLocked={locked || !manager.connected} onEdit={async (scan, isbn) => { const entry = await manager.editScan(scan, isbn); setResult(entry); return entry; }} stationNames={manager.stationNames} scans={[...manager.scanLog]} onUndo={onVoid ? undoScan : undefined} />
  </section>;
}
