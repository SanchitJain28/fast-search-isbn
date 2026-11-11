import React from 'react';
import { Paper, TextField, InputAdornment, IconButton, Chip, Stack, Typography } from '@mui/material';
import { Search, X } from 'lucide-react';
export default function SearchBox({ inputRef, query, setQuery, latencyMs, selectedOrder, setSelectedOrder, orders = [], onKeyDown }) {
  return <Paper className="search-wrapper" sx={{ p: 2 }}>
    <TextField fullWidth inputRef={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} autoFocus autoComplete="off" placeholder="Book title or ISBN" slotProps={{ htmlInput: { 'aria-label': 'Book title or ISBN', spellCheck: false }, input: {
      startAdornment: <InputAdornment position="start"><Search size={20} /></InputAdornment>,
      endAdornment: query && <InputAdornment position="end"><Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>{latencyMs} ms</Typography><IconButton size="small" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={18} /></IconButton></InputAdornment>
    } }} />
    <div className="filter-guide-row"><Stack direction="row" spacing={.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}><Typography variant="caption" color="text.secondary">Order</Typography>{['ALL', ...orders].map(order => <Chip key={order} label={order === 'ALL' ? 'All' : order} size="small" color={selectedOrder === order ? 'primary' : 'default'} variant={selectedOrder === order ? 'filled' : 'outlined'} onClick={() => setSelectedOrder(order)} />)}</Stack><div className="keyboard-hints"><span><kbd>↑</kbd> <kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Pack</span></div></div>
  </Paper>;
}
