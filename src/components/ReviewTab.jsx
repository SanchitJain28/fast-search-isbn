import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  ClipboardCheck, 
  Search, 
  CheckCircle2, 
  Clock, 
  ArrowLeft, 
  ArrowRight, 
  RotateCcw, 
  PlusCircle, 
  X,
  FileText,
  Sparkles,
  Zap
} from 'lucide-react';
import ResultCard from './ResultCard';
import defaultTitlesRaw from '../data/titles.txt?raw';

export default function ReviewTab({
  searchEngine,
  packingManager,
  onMarkPacked,
  onCopy,
  isLocked = false,
  packRevision = 0,
  orders = []
}) {
  const inputRef = useRef(null);

  // Parse default titles from titles.txt
  const parsedDefaultTitles = useMemo(() => {
    return defaultTitlesRaw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }, []);

  // State: custom title list or default
  const [titlesList, setTitlesList] = useState(() => {
    try {
      const saved = localStorage.getItem('fast_search_review_titles');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return parsedDefaultTitles;
  });

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterMode, setFilterMode] = useState('ALL'); // 'ALL' | 'UNPACKED' | 'PACKED'
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [selectedOrder, setSelectedOrder] = useState('ALL');
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [customText, setCustomText] = useState('');

  // The active query in the search box (prefilled with selected book's primary title)
  const currentTitleLine = titlesList[selectedIndex] || '';
  const [searchQuery, setSearchQuery] = useState(() => {
    return currentTitleLine.split(',')[0].trim() || currentTitleLine;
  });

  // When selected title index changes, auto-prefill the input box
  useEffect(() => {
    const raw = titlesList[selectedIndex] || '';
    const primary = raw.split(',')[0].trim() || raw;
    setSearchQuery(primary);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [selectedIndex, titlesList]);

  // Language variants for the selected book line
  const currentVariants = useMemo(() => {
    return currentTitleLine.split(',').map(v => v.trim()).filter(Boolean);
  }, [currentTitleLine]);

  // Normal ultra-fast search using the exact same searchEngine.search method
  const { results, latencyMs, totalMatches } = useMemo(() => {
    if (!searchQuery || !searchQuery.trim()) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }
    return searchEngine.search(searchQuery, {
      limit: 20,
      order: selectedOrder
    });
  }, [searchQuery, selectedOrder, searchEngine]);

  // Filtered sidebar items based on sidebar search
  const filteredIndices = useMemo(() => {
    return titlesList
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => {
        if (sidebarSearch.trim()) {
          return t.toLowerCase().includes(sidebarSearch.toLowerCase().trim());
        }
        return true;
      })
      .map(item => item.idx);
  }, [titlesList, sidebarSearch]);

  const totalCount = titlesList.length;

  // Custom Titles Saver
  const handleSaveCustomTitles = () => {
    const lines = customText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      setTitlesList(lines);
      setSelectedIndex(0);
      try {
        localStorage.setItem('fast_search_review_titles', JSON.stringify(lines));
      } catch (e) {}
    }
    setIsCustomModalOpen(false);
  };

  // Reset to default titles.txt
  const handleResetToDefault = () => {
    setTitlesList(parsedDefaultTitles);
    setSelectedIndex(0);
    try {
      localStorage.removeItem('fast_search_review_titles');
    } catch (e) {}
  };

  // Next / Prev title navigation
  const handlePrevTitle = () => {
    if (selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    } else {
      setSelectedIndex(titlesList.length - 1);
    }
  };

  const handleNextTitle = () => {
    if (selectedIndex < titlesList.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    } else {
      setSelectedIndex(0);
    }
  };

  return (
    <div className="review-tab-container">
      {/* Top Banner / Review Overview */}
      <div className="review-header-bar">
        <div className="review-header-left">
          <div className="review-badge-icon">
            <ClipboardCheck size={20} />
          </div>
          <div>
            <div className="review-header-title">
              For Review Queue <span className="badge">{totalCount} Books</span>
            </div>
            <div className="review-header-sub">
              Prefilled title search with instant candidate matching & Excel packing
            </div>
          </div>
        </div>

        <div className="review-header-stats">
          <button
            className="custom-titles-btn"
            onClick={() => {
              setCustomText(titlesList.join('\n'));
              setIsCustomModalOpen(true);
            }}
            title="Paste or edit title list"
          >
            <PlusCircle size={15} /> Edit / Paste List
          </button>

          <button
            className="reset-titles-btn"
            onClick={handleResetToDefault}
            title="Reset to src/data/titles.txt"
          >
            <RotateCcw size={14} /> Reset Default
          </button>
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="review-layout-grid">
        {/* Left Column: Sidebar Queue List */}
        <div className="review-sidebar">
          {/* Sidebar Search & Filters */}
          <div className="review-sidebar-search">
            <Search size={15} style={{ opacity: 0.5 }} />
            <input
              type="text"
              placeholder="Filter review titles..."
              value={sidebarSearch}
              onChange={e => setSidebarSearch(e.target.value)}
            />
            {sidebarSearch && (
              <button className="clear-btn-sm" onClick={() => setSidebarSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>

          {/* Titles List */}
          <div className="review-titles-list">
            {filteredIndices.length > 0 ? (
              filteredIndices.map(idx => {
                const titleLine = titlesList[idx];
                const isSelected = idx === selectedIndex;
                const lineVariants = titleLine.split(',').map(v => v.trim()).filter(Boolean);

                return (
                  <div
                    key={`title-${idx}`}
                    className={`review-title-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedIndex(idx)}
                  >
                    <div className="title-item-top">
                      <span className="title-item-num">#{idx + 1}</span>
                      <div className="title-item-name" title={titleLine}>
                        {lineVariants[0] || titleLine}
                      </div>
                    </div>

                    {lineVariants.length > 1 && (
                      <div className="title-variants-row">
                        {lineVariants.slice(1).map((v, vIdx) => (
                          <span key={vIdx} className="variant-mini-pill" title={v}>
                            {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="sidebar-empty">
                No titles match filter "{sidebarSearch}"
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Active Title & Search Box with Results */}
        <div className="review-main-panel">
          {currentTitleLine ? (
            <>
              {/* Active Title Card with Search Input */}
              <div className="active-title-card">
                <div className="active-title-header">
                  <div className="active-title-num-badge">
                    Book #{selectedIndex + 1} of {totalCount}
                  </div>

                  {/* Nav Buttons */}
                  <div className="active-title-nav">
                    <button
                      className="nav-arrow-btn"
                      onClick={handlePrevTitle}
                      title="Previous Book (Up Arrow)"
                    >
                      <ArrowLeft size={15} /> Prev
                    </button>
                    <button
                      className="nav-arrow-btn"
                      onClick={handleNextTitle}
                      title="Next Book (Down Arrow)"
                    >
                      Next <ArrowRight size={15} />
                    </button>
                  </div>
                </div>

                <div className="active-title-main-text" style={{ fontSize: '16px', color: 'var(--text-muted)' }}>
                  Original: <strong style={{ color: 'var(--text-primary)' }}>{currentTitleLine}</strong>
                </div>

                {/* Main Normal Search Box (prefilled with title) */}
                <div className="review-refine-search-box" style={{ marginTop: '8px', padding: '10px 14px' }}>
                  <Search size={18} style={{ color: 'var(--accent-blue)', flexShrink: 0 }} />
                  <input
                    ref={inputRef}
                    type="text"
                    className="review-refine-input"
                    style={{ fontSize: '15px', fontWeight: 600 }}
                    placeholder="Type or adjust search query..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                  {searchQuery && (
                    <button
                      className="clear-btn-sm"
                      onClick={() => {
                        setSearchQuery('');
                        if (inputRef.current) inputRef.current.focus();
                      }}
                      title="Clear search"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>

                {/* Quick Language Variant Chips (click to put in search box) */}
                {currentVariants.length > 1 && (
                  <div className="active-variants-container">
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
                      Quick Switch Title:
                    </span>
                    {currentVariants.map((v, i) => (
                      <button
                        key={i}
                        className={`active-variant-chip ${searchQuery === v ? 'selected' : ''}`}
                        onClick={() => setSearchQuery(v)}
                        title={`Search "${v}"`}
                      >
                        <Sparkles size={11} style={{ opacity: 0.7 }} />
                        {v}
                      </button>
                    ))}
                  </div>
                )}

                {/* Filter by Order */}
                <div className="review-order-filter-row">
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Filter Order:
                  </span>
                  <select
                    className="order-select-sm"
                    value={selectedOrder}
                    onChange={e => setSelectedOrder(e.target.value)}
                  >
                    <option value="ALL">All Orders</option>
                    {orders.map(o => (
                      <option key={o} value={o}>Order {o}</option>
                    ))}
                  </select>

                  <div className="results-meta-tag">
                    <Zap size={12} style={{ display: 'inline', marginRight: '3px' }} />
                    {latencyMs} ms &bull; Showing {results.length} of {totalMatches} matches
                  </div>
                </div>
              </div>

              {/* Candidate Results List */}
              <div className="review-candidates-section">
                <div className="candidates-section-title">
                  <span>🎯 Results for "{searchQuery}":</span>
                </div>

                {results.length > 0 ? (
                  <div className="review-results-list">
                    {results.map((item, idx) => {
                      const allCopies = searchEngine.getCopiesForIsbn(item.ISBN13);
                      const packed = packingManager.getPackedCount(item.ISBN13);

                      return (
                        <div key={`${item.ISBN13}-${item.Order}-${idx}`} className="candidate-card-wrapper">
                          <div className="candidate-rank-badge">
                            #{idx + 1}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <ResultCard
                              item={item}
                              query={searchQuery}
                              isSelected={false}
                              packedCount={packed}
                              totalCopies={allCopies.length || 1}
                              onCopy={onCopy}
                              onMarkPacked={onMarkPacked}
                              isLocked={isLocked}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state" style={{ padding: '30px' }}>
                    <FileText className="empty-icon" />
                    <div className="empty-title">No books found matching "{searchQuery}"</div>
                    <div className="empty-subtitle">
                      Try removing extra words or checking spelling above.
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ marginTop: '50px' }}>
              <ClipboardCheck className="empty-icon" />
              <div className="empty-title">No Title Selected</div>
              <div className="empty-subtitle">Choose a title from the left sidebar queue to review candidates.</div>
            </div>
          )}
        </div>
      </div>

      {/* Custom Title List Modal */}
      {isCustomModalOpen && (
        <div className="modal-overlay" onClick={() => setIsCustomModalOpen(false)}>
          <div className="modal-card custom-titles-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ClipboardCheck size={20} style={{ color: 'var(--accent-blue)' }} />
                <h3 style={{ margin: 0 }}>Custom Review Titles List</h3>
              </div>
              <button className="icon-btn" onClick={() => setIsCustomModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="modal-body">
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Paste or edit your book titles below (<strong>1 title per line</strong>):
              </p>

              <textarea
                className="custom-titles-textarea"
                rows={12}
                value={customText}
                onChange={e => setCustomText(e.target.value)}
                placeholder="Enter title lines here..."
              />
            </div>

            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button className="btn-secondary" onClick={() => setIsCustomModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleSaveCustomTitles}>
                Save & Load ({customText.split('\n').filter(l => l.trim()).length} Titles)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
