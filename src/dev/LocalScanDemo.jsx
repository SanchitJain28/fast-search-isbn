import React, { useState } from 'react';
import { Alert, Box, Button, Stack } from '@mui/material';
import StationStatus from '../components/StationStatus';
import ScanningTab from '../components/ScanningTab';
import { createScanDemoManager, DEMO_ISBNS } from './scanDemoManager';

export default function LocalScanDemo({ onToast }) {
  const [manager, setManager] = useState(createScanDemoManager);
  const [scenario, setScenario] = useState(0);
  const [sample, setSample] = useState(DEMO_ISBNS.pack);
  const [syncPending, setSyncPending] = useState(0);
  const [revision, setRevision] = useState(0);
  const loadSample = isbn => { setSample(isbn); setScenario(value => value + 1); };
  return <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
    <Alert severity="info">Local scan demo · Sample data only. Nothing is saved to your server or Google Sheets. Choose a sample, then press Enter or Scan. Double-click an ISBN in the grid to correct it; Enter saves and Escape cancels.</Alert>
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button variant="outlined" onClick={() => { setManager(createScanDemoManager()); loadSample(DEMO_ISBNS.pack); }}>Packed example</Button>
      <Button variant="outlined" color="warning" onClick={() => loadSample(DEMO_ISBNS.duplicate)}>Duplicate example</Button>
      <Button variant="outlined" color="error" onClick={() => loadSample(DEMO_ISBNS.notFound)}>Not-found example</Button>
      <Button onClick={() => { setManager(createScanDemoManager()); loadSample(DEMO_ISBNS.pack); }}>Reset demo</Button>
    </Stack>
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
      <Box sx={{ width: 280, bgcolor: '#1a1a1a', borderRadius: 1 }}><StationStatus manager={manager} onNameSaved={() => setRevision(value => value + 1)} mirror={{ enabled: true, pending: syncPending }} /></Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button variant="outlined" onClick={() => { setSyncPending(2); }}>Show syncing (2 pending)</Button>
        <Button onClick={() => setSyncPending(0)}>Finish sync</Button>
        <Button variant="outlined" onClick={() => onToast?.({ title: 'Sociology of changing agrarian society', station: manager.station, stationName: manager.getStationLabel(manager.station), order: 'Order ZB343', status: 'Packed by other packer', isRemote: true, time: new Date().toLocaleTimeString() })}>Preview live-feed toast</Button>
      </Stack>
    </Box>
    <ScanningTab key={scenario} manager={manager} revision={revision} initialValue={sample} onSearch={() => loadSample('')} onVoid={async scan => { await manager.voidScan(scan.id); setRevision(value => value + 1); }} />
  </Stack>;
}
