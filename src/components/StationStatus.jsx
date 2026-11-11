import React, { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, TextField, Tooltip, Typography } from '@mui/material';
import EditOutlined from '@mui/icons-material/EditOutlined';

export default function StationStatus({ manager, onlineUsers = 1, onNameSaved, mirror = manager.mirror || {} }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const stationName = manager.getStationLabel(manager.station);
  const syncing = mirror.enabled && Number(mirror.pending) > 0;
  const save = async event => {
    event.preventDefault(); setSaving(true); setError('');
    try { await manager.updateStationName(name.trim()); onNameSaved?.(); setEditing(false); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  return <>
    <Box className="station-details">
      <div><span>Station</span><Box sx={{ minWidth: 0, textAlign: 'right' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: .5 }}>
          <Tooltip title={`Station ID: ${manager.station}`}><strong>{stationName}</strong></Tooltip>
          <IconButton size="small" aria-label="Edit station name" sx={{ color: '#b9c8ff', p: .25 }} onClick={() => { setName(manager.stationNames?.[manager.station] || ''); setError(''); setEditing(true); }}><EditOutlined sx={{ fontSize: 15 }} /></IconButton>
        </Box>
        {stationName !== manager.station && <Typography variant="caption" sx={{ display: 'block', color: 'rgba(255,255,255,.5)', fontSize: 10 }}>{manager.station}</Typography>}
      </Box></div>
      <div><span>Live packers</span><strong>{onlineUsers}</strong></div>
      <div><span>Server</span><strong className={manager.connected ? 'status-ok' : 'status-error'}>{manager.connected ? 'Connected' : 'Disconnected'}</strong></div>
      <Box className="sheet-sync-status" sx={{ mb: 1.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ display: 'inline-flex', flexDirection: 'column' }}>
            <span>Sheet sync</span>
            {syncing && <LinearProgress aria-label="Syncing scans to Google Sheets" sx={{ mt: .75, height: 2, borderRadius: 1, opacity: .65 }} />}
          </Box>
          <strong>{!mirror.enabled ? 'Off' : `${mirror.pending || 0} pending`}</strong>
        </Box>
      </Box>
    </Box>
    <Dialog open={editing} onClose={() => !saving && setEditing(false)} fullWidth maxWidth="xs" aria-labelledby="station-name-title">
      <form onSubmit={save}>
        <DialogTitle id="station-name-title">Station display name</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Station ID: {manager.station}. The ID saved with scans and in Sheets stays the same.</Typography>
          <TextField autoFocus fullWidth label="Display name" placeholder="Basement floor" value={name} onChange={event => setName(event.target.value)} slotProps={{ htmlInput: { maxLength: 80 } }} helperText="Leave blank to show the station ID." sx={{ mt: 1 }} />
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions><Button disabled={saving} onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" variant="contained" disabled={saving}>{saving ? 'Saving…' : 'Save name'}</Button></DialogActions>
      </form>
    </Dialog>
  </>;
}
