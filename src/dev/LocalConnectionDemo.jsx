import React, { useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import ScanningTab from '../components/ScanningTab';
import { createConnectionDemo } from './connectionDemoManager';
import { DEMO_ISBNS } from './scanDemoManager';

export default function LocalConnectionDemo() {
  const [, render] = useState(0);
  const demoRef = useRef(null);
  if (!demoRef.current) demoRef.current = createConnectionDemo(() => render(value => value + 1));
  const demo = demoRef.current;
  const { manager, state } = demo;
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState('');
  const run = async () => {
    setRunning(true); setReport('');
    try {
      await demo.restore();
      await demo.dropFeed();
      if (!manager.connected) throw Error('Live-feed drop blocked scanning');
      const before = state.saved.size, start = state.attempts.length;
      demo.loseReply();
      const entry = await manager.markPacked(DEMO_ISBNS.pack);
      const attempts = state.attempts.slice(start);
      if (state.saved.size !== before + 1 || attempts.length !== 2 || new Set(attempts).size !== 1 || manager.pending) throw Error('Retry verification failed');
      demo.log(`PASS: scan confirmed as ${entry.statusType}; 2 attempts, same ID, exactly 1 saved row.`);
      await demo.goOffline();
      try { await manager.markPacked('9780000000000'); } catch { /* Expected: pending is retained. */ }
      const pendingId = manager.pending?.id;
      if (!pendingId) throw Error('Pending scan was lost');
      demo.log(`PASS: full outage kept pending scan ${pendingId}. No box assignment guessed.`);
      await demo.restore();
      const recovered = await manager.retryPending();
      if (recovered.id !== pendingId || manager.pending) throw Error('Recovery did not preserve request ID');
      demo.log('PASS: restored connection confirmed the saved request with its original ID.');
      setReport('PASS — live-feed drop kept scanning available; lost reply retried the same ID with one saved row; full outage preserved and recovered the pending request.');
    } catch (error) { setReport(`FAIL — ${error.message}`); }
    finally { setRunning(false); }
  };
  return <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
    <Typography variant="h5">Connection recovery demo</Typography>
    <Alert severity="info">Localhost only. This uses the actual PackingManager connection and retry code with an isolated simulated server. No production requests, browser storage, or Google Sheets writes.</Alert>
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button variant="contained" disabled={running || manager.busy || !!manager.pending} onClick={run}>Run all connection checks</Button>
      <Button disabled={running} onClick={() => demo.dropFeed()}>Drop live feed only</Button>
      <Button disabled={running} onClick={() => demo.loseReply()}>Lose next scan reply</Button>
      <Button disabled={running} onClick={() => demo.goOffline()}>Disconnect network</Button>
      <Button disabled={running} onClick={() => demo.restore()}>Restore network</Button>
    </Stack>
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Chip color={manager.connected ? 'success' : 'warning'} label={`Scanner: ${manager.connected ? 'connected' : 'disconnected'}`} />
      <Chip label={`Server rows saved: ${state.saved.size}`} />
      <Chip label={`Scan POST attempts reaching server: ${state.attempts.length}`} />
      <Chip label={`Pending: ${manager.pending ? manager.pending.id : 'none'}`} />
    </Stack>
    {report && <Alert severity={report.startsWith('PASS') ? 'success' : 'error'}>{report}</Alert>}
    <Box sx={{ bgcolor: '#1a1a1a', border: '1px solid #444', borderRadius: 1, p: 2, maxHeight: 240, overflow: 'auto' }} aria-live="polite">
      {state.events.length ? state.events.map((event, index) => <Typography key={`${index}-${event}`} sx={{ fontFamily: 'monospace', fontSize: 13, mb: 0.5 }}>{event}</Typography>) : <Typography>Run the checks, or choose a failure and scan the sample below.</Typography>}
    </Box>
    {!running && <ScanningTab manager={manager} initialValue={DEMO_ISBNS.pack} onSearch={() => {}} />}
  </Stack>;
}
