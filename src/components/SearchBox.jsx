import React from 'react';
import { Search, X, Zap, Lock, RefreshCw } from 'lucide-react';

export default function SearchBox({
  inputRef,
  query,
  setQuery,
  latencyMs,
  selectedOrder,
  setSelectedOrder,
  orders = [],
  onKeyDown,
  isLocked = false,
  syncAlert = null,
  onSyncNow,
  isSyncingNow = false
}) {
  return (
    <div className={`search-wrapper ${isLocked ? 'search-locked' : ''}`}>
      {isLocked && (
        <div className="search-lock-overlay">
          <div className="search-lock-content">
            <div className="lock-icon-circle">
              <Lock size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '14px', color: '#f59e0b' }}>
                🔒 Search Locked — Sync Needed
              </div>
              <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '2px' }}>
                Google Sheet was modified (
                {syncAlert?.diff > 0
                  ? `+${syncAlert.diff} new scans in sheet`
                  : `${Math.abs(syncAlert?.diff || 0)} scans removed in sheet`}
                ). Please sync to prevent duplicate packing.
              </div>
            </div>
            <button
              className="sync-unlock-btn"
              onClick={onSyncNow}
              disabled={isSyncingNow}
            >
              <RefreshCw size={14} className={isSyncingNow ? 'spinner' : ''} />
              {isSyncingNow ? 'Syncing...' : 'Sync & Unlock ⚡'}
            </button>
          </div>
        </div>
      )}

      <div className="search-input-row" style={{ opacity: isLocked ? 0.35 : 1 }}>
        {isLocked ? (
          <Lock className="search-icon" size={22} style={{ color: '#f59e0b' }} />
        ) : (
          <Search className="search-icon" size={22} />
        )}

        <input
          ref={inputRef}
          type="text"
          className="main-search-input"
          placeholder={
            isLocked
              ? '🔒 Search locked until synced with Google Sheet...'
              : 'Type book title or ISBN to search in sub-millisecond...'
          }
          value={query}
          onChange={(e) => !isLocked && setQuery(e.target.value)}
          onKeyDown={!isLocked ? onKeyDown : undefined}
          disabled={isLocked}
          autoFocus={!isLocked}
          spellCheck="false"
          autoComplete="off"
        />

        <div className="search-actions">
          {query.trim() && !isLocked && (
            <div className="latency-badge" title="Search execution time">
              <Zap size={13} />
              {latencyMs < 0.1 ? '< 0.1 ms' : `${latencyMs} ms`}
            </div>
          )}

          {query && !isLocked && (
            <button
              className="clear-btn"
              onClick={() => {
                setQuery('');
                if (inputRef.current) inputRef.current.focus();
              }}
              title="Clear search (Esc)"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="filter-guide-row" style={{ opacity: isLocked ? 0.35 : 1, pointerEvents: isLocked ? 'none' : 'auto' }}>
        <div className="order-pills">
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginRight: '2px' }}>
            Filter Order:
          </span>
          <button
            className={`order-pill-btn ${selectedOrder === 'ALL' ? 'active' : ''}`}
            onClick={() => setSelectedOrder('ALL')}
            disabled={isLocked}
          >
            All Orders
          </button>
          {orders.map((ord) => (
            <button
              key={ord}
              className={`order-pill-btn ${selectedOrder === ord ? 'active' : ''}`}
              onClick={() => setSelectedOrder(ord)}
              disabled={isLocked}
            >
              {ord}
            </button>
          ))}
        </div>

        <div className="keyboard-hints">
          <span><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span>
          <span><kbd>↵ Enter</kbd> Copy ISBN</span>
          <span><kbd>Esc</kbd> Clear</span>
        </div>
      </div>
    </div>
  );
}
