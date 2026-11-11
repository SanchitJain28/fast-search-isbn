import React from 'react';
import { Paper, Typography, Button, LinearProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import { FileSpreadsheet } from 'lucide-react';
export default function ProgressDashboard({ progress, onExportExcel, onSelectOrder }) {
  if (!progress) return null;
  const { orders = [], totalScanned, totalPacked, duplicates, notFound } = progress;
  return <div className="progress-dashboard"><div className="kpi-grid">{[['Books packed', totalPacked], ['Total scans', totalScanned], ['Duplicates caught', duplicates, 'warning.main'], ['Not found', notFound, 'error.main']].map(([label, value, color]) => <Paper key={label} sx={{ p: 2 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="h4" sx={{ mt: .5, color }}>{value.toLocaleString()}</Typography></Paper>)}</div>
    <Paper><div className="table-header-row"><Typography sx={{ fontWeight: 500 }}>Order packing status</Typography><Button variant="outlined" startIcon={<FileSpreadsheet size={16} />} onClick={onExportExcel}>Export Excel</Button></div><TableContainer><Table size="small" aria-label="Order packing progress"><TableHead><TableRow>{['Order', 'Packed', 'Remaining', 'Progress'].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{orders.map(o => <TableRow key={o.order} hover><TableCell><Button onClick={() => onSelectOrder(o.order)}>{o.order}</Button></TableCell><TableCell>{o.packed} / {o.total}</TableCell><TableCell>{o.remaining}</TableCell><TableCell sx={{ minWidth: 160 }}><Typography variant="caption">{o.pct}%</Typography><LinearProgress variant="determinate" value={Math.max(0, Math.min(100, o.pct))} color={o.pct >= 100 ? 'success' : 'primary'} aria-label={`Order ${o.order} packed`} sx={{ height: 4, borderRadius: 1, mb: 1 }} /></TableCell></TableRow>)}</TableBody></Table></TableContainer></Paper>
  </div>;
}
