import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { searchEngine } from "./search/engine";
import { packingManager } from "./utils/sync";
import { soundFx } from "./utils/audio";
import SearchBox from "./components/SearchBox";
import ResultCard from "./components/ResultCard";
import RecentCopies from "./components/RecentCopies";
import ProgressDashboard from "./components/ProgressDashboard";
import ScanLogView from "./components/ScanLogView";
import SyncModal from "./components/SyncModal";
import StationStatus from './components/StationStatus';
import ScanningWorkspace from "./components/ScanningWorkspace";
import CoverMatch from './components/CoverMatch';
import { MenuBook as BookOpen, VolumeUp as Volume2, VolumeOff, Search as SearchIcon, BarChart as BarChart3, FormatListNumbered as ListOrdered, AutoAwesome as Sparkles, Share as Share2, Close as X, Inventory2 as PackageCheck, WarningAmber as AlertTriangle, PhotoCamera, ImageSearch, TextFields } from '@mui/icons-material';
import { ThemeProvider, createTheme, CssBaseline, Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Typography, Switch, Divider, Button, Chip, CircularProgress, IconButton, Tooltip } from '@mui/material';
import "./App.css";

const SAMPLE_QUERIES = [
  "Matlab and Beyond",
  "Unhappy India",
  "Compiler Building",
  "Pharmacology",
  "Statistical Thermodynamics",
  "Tomatoes And Tomato",
];

export default function App() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalRecords: 0,
    orders: [],
    orderTotals: {},
  });
  const [activeTab, changeTab] = useState(() => new URLSearchParams(window.location.search).get('tab') === 'cover' || packingManager.pending?.confirmationToken ? 'cover' : 'scanning');
  const [coverMode, setCoverMode] = useState('vector');
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const setActiveTab = useCallback(tab => {
    const url = new URL(window.location.href);
    if (tab === 'cover') url.searchParams.set('tab', 'cover');
    else if (url.searchParams.get('tab') === 'cover') url.searchParams.delete('tab');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    changeTab(tab);
  }, []);
  const [query, setQuery] = useState("");
  const [selectedOrder, setSelectedOrder] = useState("ALL");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);

  // Packing state revision counter to trigger instant re-renders
  const [packRevision, setPackRevision] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState(packingManager.connectedUsers || 1);
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((toast) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const [recentCopies, setRecentCopies] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("fast_search_recent") || "[]");
    } catch {
      return [];
    }
  });

  const [muted, setMuted] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    const interval = setInterval(() => packingManager.health(), 10000);
    const focus = () => { void packingManager.health(); packingManager.scheduleRecovery(0, true); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(interval); window.removeEventListener('focus', focus); };
  }, []);

  // Initialize Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  }, []);

  // Subscribe to server events for all scanning stations
  useEffect(() => {
    setOnlineUsers(packingManager.connectedUsers || 1);
    const unsubscribe = packingManager.subscribe((type, data) => {
      if (["STATE", "HEALTH"].includes(type)) {
        setPackRevision(r => r + 1);
        setOnlineUsers(packingManager.connectedUsers);
      } else if (type === "USER_COUNT") {
        setOnlineUsers(data || 1);
      } else if (["BOOK_PACKED", "BOOK_EDITED"].includes(type) && data) {
        setPackRevision((r) => r + 1);
        if (data.station !== packingManager.station) addToast({
          title: data.title || `ISBN: ${data.isbn}`,
          order: data.order ? `Order ${data.order}` : '',
          status: type === 'BOOK_EDITED' ? `Corrected by other packer · ${data.statusType}` : data.statusType === 'PACK' ? 'Packed by other packer' : data.statusType,
          station: data.station,
          isRemote: true,
          isWarning: data.statusType !== 'PACK',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }
    });
    return unsubscribe;
  }, [addToast]);

  // Load local catalog and authoritative server history
  const hasLoadedDataRef = useRef(false);
  useEffect(() => {
    if (hasLoadedDataRef.current) return;
    hasLoadedDataRef.current = true;

    async function loadData() {
      try {
        const res = await fetch("/master.json");
        const data = await res.json();
        const info = searchEngine.init(data);
        setStats(info);

        try { await packingManager.refresh(); }
        catch { addToast({ title: 'Central server unavailable', status: 'Scanning requires the server connection.', isWarning: true }); }
        setPackRevision(r => r + 1);

        setLoading(false);
      } catch (err) {
        console.error("Failed to load master dataset:", err);
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Search the in-memory catalog
  const { results, latencyMs, totalMatches } = useMemo(() => {
    if (!query.trim()) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }
    return searchEngine.search(query, {
      limit: 60,
      order: selectedOrder,
    });
  }, [query, selectedOrder]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, selectedOrder]);

  const handleMarkPacked = async (item) => {
    try {
      const entry = await packingManager.markPacked(String(item.ISBN13 || '').trim());
      setPackRevision(r => r + 1);
      if (entry.statusType === 'PACK') { handleCopySuccess(item); soundFx.copySuccess(); }
      else soundFx.duplicateWarning();
      return entry;
    } catch (error) {
      addToast({ title: 'Scan not confirmed', status: error.message, isWarning: true });
      return { statusType: 'ERROR', status: error.message };
    }
  };

  const handleVoidScan = async (scan) => {
    try {
      await packingManager.voidScan(scan.id);
      setPackRevision(r => r + 1);
      addToast({ title: 'Scan Removed', status: `${scan.title || scan.isbn} removed from packing.`, isWarning: false });
    } catch (err) {
      addToast({ title: 'Could not remove scan', status: err.message, isWarning: true });
    }
  };

  // Keyboard navigation & Shortcuts
  const handleKeyDown = (e) => {
    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = prev < results.length - 1 ? prev + 1 : 0;
        soundFx.navigate();
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = prev > 0 ? prev - 1 : results.length - 1;
        soundFx.navigate();
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;
      const target = results[selectedIndex];
      if (target) {
        handleMarkPacked(target);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
    }
  };

  // Record a copied item
  const handleCopySuccess = (item) => {
    const entry = {
      Title: item.Title,
      Order: item.Order,
      ISBN13: item.ISBN13,
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };
    setRecentCopies((prev) => {
      const filtered = prev.filter((p) => p.ISBN13 !== item.ISBN13);
      const updated = [entry, ...filtered].slice(0, 10);
      try {
        localStorage.setItem("fast_search_recent", JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const toggleAudio = () => {
    const isMuted = soundFx.toggleMute();
    setMuted(isMuted);
  };

  const progressData = useMemo(() => {
    return packingManager.getProgress(stats.orderTotals);
  }, [packRevision, stats.orderTotals]);

  const muiTheme = useMemo(() => createTheme({
    palette: { mode: 'dark', primary: { main: '#7d97f8' },
      background: { default: '#121212', paper: '#1e1e1e' } },
    typography: { fontFamily: 'Roboto, sans-serif', fontSize: 14, button: { fontWeight: 500 } },
    shape: { borderRadius: 4 },
    components: { MuiButton: { defaultProps: { size: 'small' } }, MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } }, MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } } }
  }), []);
  const coverEnabled = packingManager.coverMatchEnabled;
  const vector = packingManager.coverVector;
  const vectorAvailable = Boolean(vector?.enabled && (!vector.pilotStation || vector.pilotStation === packingManager.station));
  const activeCoverMode = vectorAvailable ? coverMode : 'title';
  const sections = [
    ['scanning', 'Scanning', PackageCheck],
    ...(coverEnabled || activeTab === 'cover' ? [['cover', 'Cover Match', PhotoCamera]] : []),
    ['search', 'Title Search', SearchIcon],
    ['progress', 'Progress', BarChart3],
    ['scans', 'Scan Log', ListOrdered, packingManager.scanLog.length]
  ];

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <Box className="app-shell">
        <Drawer
          variant="permanent"
          className={`app-sidebar ${sidebarHovered ? 'is-expanded' : 'is-collapsed'}`}
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
          sx={{
            '& .MuiDrawer-paper': {
              width: sidebarHovered ? 240 : 68,
              p: sidebarHovered ? '20px 12px 14px' : '20px 10px 14px',
              background: '#1a1a1a',
              color: '#fff',
              border: 0,
              overflowX: 'hidden',
              transition: 'width 0.2s ease, padding 0.2s ease',
              zIndex: 1200,
            }
          }}
        >
          {sidebarHovered && <Typography sx={{ px: 1.25, mb: 3, fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap' }}>FastSearch ISBN</Typography>}
          <List component="nav" aria-label="Sections" disablePadding>
            {sections.map(([id, label, Icon, count]) => <React.Fragment key={id}>
              <ListItemButton
                selected={activeTab === id}
                onClick={() => setActiveTab(id)}
                sx={{
                  borderRadius: 1,
                  minHeight: 44,
                  mb: .25,
                  px: sidebarHovered ? 2 : 0,
                  justifyContent: sidebarHovered ? 'flex-start' : 'center',
                  color: 'rgba(255,255,255,.7)',
                  '&.Mui-selected': { background: 'rgba(109,139,246,.2)', color: '#b9c8ff' },
                  '&.Mui-selected:hover': { background: 'rgba(109,139,246,.28)' }
                }}
              >
                <ListItemIcon sx={{ color: 'inherit', minWidth: sidebarHovered ? 40 : 'auto', justifyContent: 'center' }}><Icon size={20} /></ListItemIcon>
                {sidebarHovered && <ListItemText primary={label} slotProps={{ primary: { fontSize: 14, fontWeight: 500, noWrap: true } }} />}
                {sidebarHovered && count !== undefined && <Chip size="small" label={count} sx={{ height: 20, fontSize: 11, color: 'inherit', background: 'rgba(255,255,255,.12)' }} />}
              </ListItemButton>
              {id === 'cover' && sidebarHovered && (
                <List component="div" disablePadding sx={{ pl: 3, mb: .5 }}>
                  <ListItemButton
                    selected={activeTab === 'cover' && activeCoverMode === 'vector'}
                    disabled={!vectorAvailable}
                    onClick={() => { setCoverMode('vector'); setActiveTab('cover'); }}
                    sx={{
                      borderRadius: 1, minHeight: 36, mb: .25, px: 1.5, color: 'rgba(255,255,255,.65)',
                      '&.Mui-selected': { background: 'rgba(109,139,246,.16)', color: '#b9c8ff' },
                      '&.Mui-selected:hover': { background: 'rgba(109,139,246,.24)' }
                    }}
                  >
                    <ListItemIcon sx={{ color: 'inherit', minWidth: 32 }}><ImageSearch sx={{ fontSize: 18 }} /></ListItemIcon>
                    <ListItemText primary="Vector" slotProps={{ primary: { fontSize: 13, fontWeight: 500, noWrap: true } }} />
                  </ListItemButton>
                  <ListItemButton
                    selected={activeTab === 'cover' && activeCoverMode === 'title'}
                    onClick={() => { setCoverMode('title'); setActiveTab('cover'); }}
                    sx={{
                      borderRadius: 1, minHeight: 36, mb: .25, px: 1.5, color: 'rgba(255,255,255,.65)',
                      '&.Mui-selected': { background: 'rgba(109,139,246,.16)', color: '#b9c8ff' },
                      '&.Mui-selected:hover': { background: 'rgba(109,139,246,.24)' }
                    }}
                  >
                    <ListItemIcon sx={{ color: 'inherit', minWidth: 32 }}><TextFields sx={{ fontSize: 18 }} /></ListItemIcon>
                    <ListItemText primary="Title" slotProps={{ primary: { fontSize: 13, fontWeight: 500, noWrap: true } }} />
                  </ListItemButton>
                </List>
              )}
            </React.Fragment>)}
          </List>
          <Box sx={{ flex: 1 }} />
          {sidebarHovered ? <>
            <StationStatus manager={packingManager} onlineUsers={onlineUsers} />
            <Button onClick={() => setIsSyncModalOpen(true)} startIcon={<Share2 size={16} />} sx={{ color: '#b9c8ff', mb: 1, whiteSpace: 'nowrap' }}>Storage & export</Button>
            <Divider sx={{ borderColor: 'rgba(255,255,255,.12)', mb: 1 }} />
            <label className="sidebar-switch"><Volume2 size={20} /><span>Scan sounds</span><Switch size="small" checked={!muted} onChange={toggleAudio} slotProps={{ input: { 'aria-label': 'Scan sounds' } }} /></label>
          </> : (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
              <IconButton onClick={() => setIsSyncModalOpen(true)} aria-label="Storage & export" sx={{ color: '#b9c8ff' }}>
                <Share2 sx={{ fontSize: 20 }} />
              </IconButton>
              <IconButton onClick={toggleAudio} aria-label="Scan sounds" sx={{ color: 'rgba(255,255,255,.7)' }}>
                {muted ? <VolumeOff sx={{ fontSize: 20 }} /> : <Volume2 sx={{ fontSize: 20 }} />}
              </IconButton>
            </Box>
          )}
        </Drawer>
        <Box component="main" className={`app-content screen-${activeTab}`}>
          {loading ? <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: '60vh' }}><CircularProgress size={24} /><Typography>Loading book catalog…</Typography></Box> : <>
        {activeTab === 'scanning' && <ScanningWorkspace onDemoToast={addToast} manager={packingManager} revision={packRevision}
          onSearch={isbn => { setQuery(isbn); setActiveTab('search'); }} onCoverMatch={coverEnabled ? () => setActiveTab('cover') : undefined} onVoid={handleVoidScan} />}
        {activeTab === 'cover' && <CoverMatch manager={packingManager} enabled={coverEnabled} mode={activeCoverMode} onModeChange={setCoverMode} />}

        {/* Tab 1: Search View */}
        {activeTab === "search" && (
          <>
            <SearchBox
              inputRef={inputRef}
              query={query}
              setQuery={setQuery}
              latencyMs={latencyMs}
              selectedOrder={selectedOrder}
              setSelectedOrder={setSelectedOrder}
              orders={stats.orders}
              onKeyDown={handleKeyDown}
            />

            {query.trim() ? (
              <div className="results-container">
                <div className="results-header">
                  <div>
                    Showing <strong>{results.length}</strong> of{" "}
                    <strong>{totalMatches}</strong> matching titles
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--accent-emerald)",
                    }}
                  >
                    ⚡ {latencyMs} ms
                  </div>
                </div>

                {results.length > 0 ? (
                  <div className="results-list" ref={listRef}>
                    {results.map((item, idx) => {
                      const allCopies = searchEngine.getCopiesForIsbn(
                        item.ISBN13,
                      );
                      const packedCount = packingManager.getPackedCount(
                        item.ISBN13,
                      );

                      return (
                        <ResultCard
                          key={`${item.ISBN13}-${item.Order}-${idx}`}
                          item={item}
                          query={query}
                          isSelected={idx === selectedIndex}
                          packedCount={packedCount}
                          totalCopies={allCopies.length || 1}
                          onCopy={handleCopySuccess}
                          onMarkPacked={handleMarkPacked}
                          isLocked={!packingManager.connected || !packingManager.ready || packingManager.busy || !!packingManager.pending}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <BookOpen className="empty-icon" />
                    <div className="empty-title">
                      No books found matching "{query}"
                    </div>
                    <div className="empty-subtitle">
                      Try checking spelling or switching the Order filter to
                      "All Orders".
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <Sparkles
                  className="empty-icon"
                  style={{ color: "var(--accent-blue)" }}
                />
                <div className="empty-title">
                  Start typing to search titles instantly
                </div>
                <div className="empty-subtitle">
                  Search the local catalog by title or ISBN.
                </div>

                <div className="sample-queries">
                  {SAMPLE_QUERIES.map((sq) => (
                    <Button
                      key={sq}
                      className="sample-chip"
                      onClick={() => {
                        setQuery(sq);
                        if (inputRef.current) inputRef.current.focus();
                      }}
                    >
                      "{sq}"
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <RecentCopies
              history={recentCopies}
              onClear={() => {
                setRecentCopies([]);
                localStorage.removeItem("fast_search_recent");
              }}
              onReCopy={handleCopySuccess}
            />
          </>
        )}

        {/* Tab 2: Progress Dashboard */}
        {activeTab === "progress" && (
          <ProgressDashboard
            progress={progressData}
            onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
            onSelectOrder={(ord) => {
              setSelectedOrder(ord);
              setActiveTab("search");
            }}
          />
        )}

        {/* Tab 3: Scan Log */}
        {activeTab === "scans" && (
          <ScanLogView
            stationNames={packingManager.stationNames}
            scanLog={packingManager.scanLog}
            onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
            onVoidScan={handleVoidScan}
          />
        )}

        {/* Sync & Export Modal */}
        <SyncModal
          isOpen={isSyncModalOpen}
          onClose={() => setIsSyncModalOpen(false)}
          onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
          manager={packingManager}
          totalScans={packingManager.scanLog.length}
        />
          </>}
        </Box>
      </Box>

      {/* Floating Real-Time Packing Toast Notifications */}
      <div className="toast-stack-container">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pack-toast ${toast.isWarning ? "warning-toast" : toast.isRemote ? "remote-toast" : "local-toast"}`}
          >
            <div className="pack-toast-icon">
              {toast.isWarning ? (
                <AlertTriangle size={18} />
              ) : (
                <PackageCheck size={18} />
              )}
            </div>
            <div className="pack-toast-content">
              <div className="pack-toast-header">
                {toast.order && (
                  <span className="pack-toast-order">{toast.order}</span>
                )}
                <span className="pack-toast-badge">
                  {toast.isWarning
                    ? "Attention"
                    : toast.isRemote
                      ? "⚡ Live Sync"
                      : "✓ Packed"}
                </span>
                <span className="pack-toast-time">{toast.time}</span>
              </div>
              <div className="pack-toast-title" style={{ color: 'var(--accent-blue)' }}>{toast.stationName || (toast.station && packingManager.getStationLabel(toast.station))}</div>
              <div className="pack-toast-title" title={toast.title}>{toast.title}</div><div className="pack-toast-title">{toast.status}</div>
            </div>
            <Button
              className="pack-toast-close"
              onClick={() =>
                setToasts((prev) => prev.filter((t) => t.id !== toast.id))
              }
              title="Dismiss"
            >
              <X size={13} />
            </Button>
          </div>
        ))}
      </div>
    </ThemeProvider>
  );
}
