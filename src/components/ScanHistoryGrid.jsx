import React, { useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Typography } from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';

export default function ScanHistoryGrid({ scans, onUndo, onEdit, isLocked = false, editableFromSeq = 1, stationNames = {} }) {
  const [editError, setEditError] = useState('');
  const columns = useMemo(() => [
    { field: 'order', headerName: 'Order / Box', width: 115, renderCell: ({ value }) => <Typography component="span" sx={{ fontFamily: 'Roboto Mono, monospace', fontWeight: 500 }}>{value || '—'}</Typography> },
    { field: 'title', headerName: 'Book title', flex: 1, minWidth: 240, renderCell: ({ value }) => <span title={value || 'Not in catalog'}>{value || 'Not in catalog'}</span> },
    { field: 'scannedIsbn', headerName: 'ISBN · edit', width: 170, editable: !!onEdit,
      valueGetter: (value, row) => value ?? row.isbn,
      description: 'Double-click the scanned ISBN to correct it. The book, box and result update together.' },
    { field: 'statusType', headerName: 'Result', width: 140, renderCell: ({ value }) => <Chip size="small" variant="outlined" label={value.replaceAll('_', ' ')} color={value === 'PACK' ? 'success' : value === 'VOID' ? 'default' : value === 'NOT_FOUND' ? 'error' : 'warning'} /> },
    { field: 'actions', headerName: 'Action', width: 95, sortable: false, filterable: false, disableExport: true, renderCell: ({ row }) => row.statusType !== 'VOID' && onUndo ? <Button onClick={event => { event.stopPropagation(); void onUndo(row); }} aria-label={`Undo scan for ${row.title || row.isbn}`}>Undo</Button> : null },
    { field: 'status', headerName: 'Details', minWidth: 260, flex: .8 },
    { field: 'station', headerName: 'Station', width: 150, renderCell: ({ value }) => <span title={`Station ID: ${value}`}>{stationNames[value] || value}</span> },
    { field: 'timestamp', headerName: 'Time', width: 180, valueFormatter: value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value || '—' : date.toLocaleString(); } },
  ], [onUndo, onEdit, stationNames]);

  return <>
    {editError && <Alert severity="error" onClose={() => setEditError('')}>{editError}</Alert>}
    <Box sx={{ width: '100%', minWidth: 0, minHeight: 260, flex: 1 }}>
    <DataGrid aria-label="Recent scans from all stations" rows={scans} columns={columns}
      isCellEditable={({ row }) => !!onEdit && !isLocked && row.statusType !== 'VOID' && row.seq >= editableFromSeq}
      processRowUpdate={async (updated, original) => {
        const isbn = String(updated.scannedIsbn ?? updated.isbn).trim();
        if (isbn === (original.scannedIsbn ?? original.isbn)) return original;
        setEditError('');
        return onEdit(original, isbn);
      }}
      onProcessRowUpdateError={error => setEditError(error.message || 'Could not save correction')}
      disableRowSelectionOnClick pageSizeOptions={[10, 25, 50, 100]}
      initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
      showToolbar density="comfortable"
      getRowClassName={({ row }) => row.statusType === 'VOID' ? 'scan-grid-row-void' : ''}
      localeText={{ noRowsLabel: 'Ready for your first scan. Confirmed scans will appear here.' }}
      sx={{ bgcolor: 'background.paper', '& .scan-grid-row-void': { color: 'text.disabled' }, '& .MuiDataGrid-cell:focus-within': { outlineOffset: -2 } }} />
  </Box></>;
}
