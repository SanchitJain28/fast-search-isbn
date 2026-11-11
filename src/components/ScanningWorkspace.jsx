import React, { lazy, Suspense, useState } from 'react';
import { Box, Button, CircularProgress } from '@mui/material';
import ScanningTab from './ScanningTab';

const LocalScanDemo = import.meta.env.DEV ? lazy(() => import('../dev/LocalScanDemo')) : null;
const LocalConnectionDemo = import.meta.env.DEV ? lazy(() => import('../dev/LocalConnectionDemo')) : null;
const allowDemo = import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

export default function ScanningWorkspace(props) {
  const [demo, setDemo] = useState(() => allowDemo && new URLSearchParams(window.location.search).get('demo') === 'scanning');
  const [connectionDemo, setConnectionDemo] = useState(() => allowDemo && new URLSearchParams(window.location.search).get('demo') === 'connection');
  return <Box className="scanning-workspace">
    {allowDemo && <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mb: 1.5 }}><Button variant="outlined" onClick={() => { setConnectionDemo(false); setDemo(value => !value); }}>{demo ? 'Exit scan demo' : 'Try scan demo'}</Button><Button variant="outlined" onClick={() => { setDemo(false); setConnectionDemo(value => !value); }}>{connectionDemo ? 'Exit connection demo' : 'Connection demo'}</Button></Box>}
    {allowDemo && connectionDemo ? <Suspense fallback={<CircularProgress size={24} />}><LocalConnectionDemo /></Suspense> : allowDemo && demo ? <Suspense fallback={<CircularProgress size={24} />}><LocalScanDemo onToast={props.onDemoToast} /></Suspense> : <ScanningTab {...props} />}
  </Box>;
}
