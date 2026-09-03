import React from 'react';
import { Search, X, Zap, SlidersHorizontal } from 'lucide-react';

export default function SearchBox({
  inputRef,
  query,
  setQuery,
  latencyMs,
  selectedOrder,
  setSelectedOrder,
  orders = [],
  onKeyDown
}) {
  return (
    <div className="search-wrapper">
      <div className="search-input-row">
        <Search className="search-icon" size={22} />
        <input
          ref={inputRef}
          type="text"
          className="main-search-input"
          placeholder="Type book title or ISBN to search in sub-millisecond..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          spellCheck="false"
          autoComplete="off"
        />

        <div className="search-actions">
          {query.trim() && (
            <div className="latency-badge" title="Search execution time">
              <Zap size={13} />
              {latencyMs < 0.1 ? '< 0.1 ms' : `${latencyMs} ms`}
            </div>
          )}

          {query && (
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

      <div className="filter-guide-row">
        <div className="order-pills">
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginRight: '2px' }}>
            Filter Order:
          </span>
          <button
            className={`order-pill-btn ${selectedOrder === 'ALL' ? 'active' : ''}`}
            onClick={() => setSelectedOrder('ALL')}
          >
            All Orders
          </button>
          {orders.map((ord) => (
            <button
              key={ord}
              className={`order-pill-btn ${selectedOrder === ord ? 'active' : ''}`}
              onClick={() => setSelectedOrder(ord)}
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
