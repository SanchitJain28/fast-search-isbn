import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Alert, Typography, Stack } from '@mui/material';
export default function SyncModal({ isOpen, onClose, onExportExcel, totalScans, manager }) {
  const mirror = manager.mirror || {};
  return <Dialog open={isOpen} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="storage-title"><DialogTitle id="storage-title">Packing storage & reporting</DialogTitle><DialogContent><Stack spacing={2}>
    <Typography>Central server: <strong>{manager.connected ? 'Connected' : 'Disconnected'}</strong></Typography>
    <Typography>History: <strong>{manager.ready ? `${totalScans} attempts saved` : 'Migration required before scanning'}</strong></Typography>
    <Typography>Google Sheets: <strong>{!mirror.enabled ? 'Disabled' : !mirror.configured ? 'Configuration needed' : `${mirror.pending} attempts awaiting sync`}</strong></Typography>
    {mirror.enabled && mirror.tab && <Typography>Reporting destination: {mirror.tab}</Typography>}
    {mirror.lastError && <Alert severity="warning">Reporting delayed: {mirror.lastError}. Scans remain saved on the server.</Alert>}
    {mirror.lastSuccess && <Typography>Last reporting check: {new Date(mirror.lastSuccess).toLocaleString()}</Typography>}
    <Typography variant="body2" color="text.secondary">Scanning continues during a Google outage. Keep the central computer running. Historical imports and database backups are managed on that computer; see README.md.</Typography>
  </Stack></DialogContent><DialogActions><Button onClick={onClose}>Close</Button><Button variant="contained" onClick={onExportExcel}>Download Excel ({totalScans})</Button></DialogActions></Dialog>;
}
