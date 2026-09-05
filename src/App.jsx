import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { BookSearchEngine, searchEngine } from "./search/engine";
import { packingManager } from "./utils/sync";
import { soundFx } from "./utils/audio";
import SearchBox from "./components/SearchBox";
import ResultCard from "./components/ResultCard";
import RecentCopies from "./components/RecentCopies";
import ProgressDashboard from "./components/ProgressDashboard";
import ScanLogView from "./components/ScanLogView";
import SyncModal from "./components/SyncModal";
import ReviewTab from "./components/ReviewTab";
import {
  Zap,
  BookOpen,
  Volume2,
  VolumeX,
  Sun,
  Moon,
  Search as SearchIcon,
  BarChart3,
  ListOrdered,
  Sparkles,
  Share2,
  BellRing,
  RefreshCw,
  X,
  ClipboardCheck,
  PackageCheck,
  AlertTriangle,
  Lock,
  CheckCircle2,
} from "lucide-react";
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
  const [activeTab, setActiveTab] = useState("search"); // 'search' | 'progress' | 'scans'
  const [query, setQuery] = useState("");
  const [selectedOrder, setSelectedOrder] = useState("ALL");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);

  // Packing state revision counter to trigger instant re-renders
  const [packRevision, setPackRevision] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState(packingManager.connectedUsers || 1);
  const [toasts, setToasts] = useState([]);
  const [syncLock, setSyncLock] = useState(null); // { isLocked: true, remoteCount: X, localCount: Y, diff: X - Y }
  const [isSyncingNow, setIsSyncingNow] = useState(false);

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

  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("fast_search_theme") || "dark";
  });
  const [muted, setMuted] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Sync Verification Check (Verifies local count matches Sheet count)
  const checkSyncStatus = useCallback(async () => {
    try {
      // Don't flag sync lock if user scanned locally in the last 4 seconds
      if (Date.now() - packingManager.lastLocalScanTime < 4000) return;

      const res = await fetch("/api/sheets/count");
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.count === "number") {
        const remoteCount = data.count;
        const localTotalCount = packingManager.scanLog.length;

        if (remoteCount !== localTotalCount && Math.abs(remoteCount - localTotalCount) > 0) {
          setSyncLock({
            isLocked: true,
            remoteCount,
            localCount: localTotalCount,
            diff: remoteCount - localTotalCount,
          });
        } else {
          setSyncLock(null);
        }
      }
    } catch (e) {
      console.warn("Sync check error:", e);
    }
  }, []);

  // Check sync health periodically and on window focus
  useEffect(() => {
    checkSyncStatus();
    const interval = setInterval(checkSyncStatus, 15000);
    const onFocus = () => checkSyncStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkSyncStatus, packRevision]);

  // Initialize Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fast_search_theme", theme);
  }, [theme]);

  // Subscribe to Central WebSocket/SSE Hub for Real-Time Multi-User Packing
  useEffect(() => {
    setOnlineUsers(packingManager.connectedUsers || 1);
    const unsubscribe = packingManager.subscribe((type, data) => {
      if (type === "USER_COUNT") {
        setOnlineUsers(data || 1);
      } else if (type === "BOOK_PACKED" && data) {
        setPackRevision((r) => r + 1);
        addToast({
          title: data.title || `ISBN: ${data.isbn}`,
          order: data.order ? `Order ${data.order}` : '',
          status: data.statusType === 'PACK' ? 'Packed by other packer' : data.statusType,
          isRemote: true,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      } else if (type === "SCANS_CLEARED") {
        setPackRevision((r) => r + 1);
      }
    });
    return unsubscribe;
  }, [addToast]);

  // Load Data and Build FlexSearch Index + Auto-Sync from Google Sheets API
  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch("/master.json");
        const data = await res.json();
        const info = searchEngine.init(data);
        setStats(info);

        // 1. Direct fetch from Google Sheets API v4 on startup
        let sheetSynced = false;
        try {
          const sheetCount = await packingManager.fetchFromGoogleSheet((isbn) =>
            searchEngine.getCopiesForIsbn(isbn)
          );
          if (sheetCount > 0 || packingManager.scanLog.length > 0) {
            sheetSynced = true;
            setPackRevision((r) => r + 1);
            console.log(
              `⚡ Auto-loaded ${packingManager.scanLog.length} live scans from Google Sheets API on startup.`
            );
          }
        } catch (sheetErr) {
          console.warn("Sheet startup sync skipped:", sheetErr);
        }

        // 2. Fallback to server pool or backup if sheet not accessible
        if (!sheetSynced) {
          const serverSynced = await packingManager.syncInitialStateFromServer((isbn) =>
            searchEngine.getCopiesForIsbn(isbn),
          );
          if (!serverSynced && packingManager.scanLog.length === 0) {
            try {
              const scanRes = await fetch("/initial_scans.json");
              if (scanRes.ok) {
                const initIsbns = await scanRes.json();
                if (Array.isArray(initIsbns) && initIsbns.length > 0) {
                  packingManager.importScans(initIsbns, (isbn) =>
                    searchEngine.getCopiesForIsbn(isbn),
                  );
                  setPackRevision((r) => r + 1);
                }
              }
            } catch (scanErr) {}
          } else {
            setPackRevision((r) => r + 1);
          }
        }

        setLoading(false);
      } catch (err) {
        console.error("Failed to load master dataset:", err);
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Execute Search (Sub-0.2ms FlexSearch in-memory search)
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

  // Packing cooldown ref to prevent accidental rapid double-clicks/scanner bounces
  const lastPackRef = useRef({ isbn: '', time: 0 });

  // Handle Mark Packed with 600ms debounce protection
  const handleMarkPacked = (item) => {
    const isbn = String(item.ISBN13 || "").trim();
    const now = Date.now();

    // Prevent duplicate triggers for the same ISBN within 600ms (mouse microswitch bounce or barcode scanner CR/LF)
    if (lastPackRef.current.isbn === isbn && now - lastPackRef.current.time < 600) {
      console.warn(`[Debounce] Ignored rapid duplicate click for ISBN: ${isbn}`);
      return null;
    }
    lastPackRef.current = { isbn, time: now };

    const candidates = searchEngine.getCopiesForIsbn(isbn);
    const totalCopies = candidates.length || 1;
    const currentPacked = packingManager.getPackedCount(isbn);

    // If already fully packed, warn user immediately and DO NOT record duplicate garbage
    if (currentPacked >= totalCopies) {
      soundFx.duplicateWarning();
      addToast({
        title: item.Title || `ISBN: ${isbn}`,
        order: item.Order ? `Order ${item.Order}` : "",
        status: `Already packed (${currentPacked}/${totalCopies})`,
        isWarning: true,
        isRemote: false,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      });
      return {
        statusType: "DUPLICATE",
        status: `⛔ DUPLICATE (${currentPacked}/${totalCopies} packed) — set aside`,
      };
    }

    const logEntry = packingManager.markPacked(isbn, candidates);
    setPackRevision((r) => r + 1);
    handleCopySuccess(item);

    if (logEntry && logEntry.statusType === "PACK") {
      addToast({
        title: logEntry.title || `ISBN: ${logEntry.isbn}`,
        order: logEntry.order ? `Order ${logEntry.order}` : "",
        status: "Packed by you",
        isRemote: false,
        time: logEntry.timestamp,
      });
    }

    return logEntry;
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

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const toggleAudio = () => {
    const isMuted = soundFx.toggleMute();
    setMuted(isMuted);
  };

  const progressData = useMemo(() => {
    return packingManager.getProgress(stats.orderTotals);
  }, [packRevision, stats.orderTotals]);

  // Import existing scans from Sheet
  const handleFetchFromSheet = async () => {
    setIsSyncingNow(true);
    try {
      const count = await packingManager.fetchFromGoogleSheet((isbn) =>
        searchEngine.getCopiesForIsbn(isbn),
      );
      setPackRevision((r) => r + 1);
      setSyncLock(null);
      addToast({
        title: "⚡ Google Sheet Synced",
        status: `Imported ${count} packed books. System unlocked!`,
        isWarning: false,
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      });
      setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 100);
      return count;
    } catch (err) {
      console.warn("Fetch from sheet error:", err.message);
      throw err;
    } finally {
      setIsSyncingNow(false);
    }
  };

  // Import pasted ISBNs
  const handleImportPasted = (isbns) => {
    const count = packingManager.importScans(isbns, (isbn) =>
      searchEngine.getCopiesForIsbn(isbn),
    );
    setPackRevision((r) => r + 1);
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 100);
    return count;
  };

  // Reload the backup scans
  const handleReloadBackup = async () => {
    try {
      const scanRes = await fetch("/initial_scans.json");
      const initIsbns = await scanRes.json();
      const count = packingManager.importScans(initIsbns, (isbn) =>
        searchEngine.getCopiesForIsbn(isbn),
      );
      setPackRevision((r) => r + 1);
      return count;
    } catch (e) {
      return 0;
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "20px",
              fontWeight: 700,
            }}
          >
            Building Sub-Millisecond Search Index...
          </div>
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: "13px",
              marginTop: "6px",
            }}
          >
            Indexing ~29,500 book titles in memory
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="ambient-bg" />

      <div className="app-container">
        {/* Header */}
        <header className="app-header">
          <div className="brand-section">
            <div className="brand-icon-wrapper">
              <Zap size={24} />
            </div>
            <div>
              <div className="brand-title">
                FastSearch ISBN
                <span className="badge">Sub-MS</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Instant Title Search & Excel Packing Tool
              </div>
            </div>
          </div>

          <div className="header-controls">
            {/* Sync Health Pill */}
            <button
              className={`sync-health-pill ${syncLock?.isLocked ? "out-of-sync" : "in-sync"}`}
              onClick={
                syncLock?.isLocked
                  ? handleFetchFromSheet
                  : () => setIsSyncModalOpen(true)
              }
              title={
                syncLock?.isLocked
                  ? "Click to Sync & Unlock System"
                  : "Google Sheet in Sync (Click for Excel/Sheet Settings)"
              }
            >
              {syncLock?.isLocked ? (
                <>
                  <Lock size={13} />
                  <span>
                    Out of Sync ({syncLock.diff > 0 ? `+${syncLock.diff}` : syncLock.diff})
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} />
                  <span>
                    Synced ({packingManager.scanLog.length})
                  </span>
                </>
              )}
            </button>

            <div
              className="live-users-pill"
              title="Live WebSocket Multi-User Synchronization Active across Wi-Fi network"
            >
              <span className="live-pulse-dot" />
              <span>
                {onlineUsers} {onlineUsers === 1 ? "Packer" : "Packers"} Live
              </span>
            </div>

            <button
              className="icon-btn"
              onClick={() => setIsSyncModalOpen(true)}
              title="Google Sheets & Excel Sync Settings"
              style={{ gap: "6px" }}
            >
              <Share2 size={16} />
              <span>Backup ({packingManager.scanLog.length})</span>
            </button>

            <button
              className="icon-btn"
              onClick={toggleAudio}
              title={muted ? "Unmute Audio" : "Mute Audio"}
            >
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>

            <button
              className="icon-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === "dark" ? "Light" : "Dark"} mode`}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>

        {/* Tab Navigation */}
        <div className="nav-tabs">
          <button
            className={`tab-btn ${activeTab === "search" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("search");
              setTimeout(
                () => inputRef.current && inputRef.current.focus(),
                50,
              );
            }}
          >
            <SearchIcon size={16} /> Title Search
          </button>
          <button
            className={`tab-btn ${activeTab === "review" ? "active" : ""}`}
            onClick={() => setActiveTab("review")}
          >
            <ClipboardCheck size={16} /> For Review
            <span className="tab-counter" style={{ background: "rgba(59, 130, 246, 0.2)", color: "var(--accent-blue)" }}>
              29
            </span>
          </button>
          <button
            className={`tab-btn ${activeTab === "progress" ? "active" : ""}`}
            onClick={() => setActiveTab("progress")}
          >
            <BarChart3 size={16} /> Progress Dashboard
          </button>
          <button
            className={`tab-btn ${activeTab === "scans" ? "active" : ""}`}
            onClick={() => setActiveTab("scans")}
          >
            <ListOrdered size={16} /> Scan Log
            <span className="tab-counter">{packingManager.scanLog.length}</span>
          </button>
        </div>

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
                          isLocked={!!syncLock?.isLocked}
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
                  Searches run in under 0.2 milliseconds with FlexSearch in-memory index.
                </div>

                <div className="sample-queries">
                  {SAMPLE_QUERIES.map((sq) => (
                    <button
                      key={sq}
                      className="sample-chip"
                      onClick={() => {
                        setQuery(sq);
                        if (inputRef.current) inputRef.current.focus();
                      }}
                    >
                      "{sq}"
                    </button>
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

        {/* Tab: For Review */}
        {activeTab === "review" && (
          <ReviewTab
            searchEngine={searchEngine}
            packingManager={packingManager}
            onMarkPacked={handleMarkPacked}
            onCopy={handleCopySuccess}
            isLocked={!!syncLock?.isLocked}
            packRevision={packRevision}
            orders={stats.orders}
          />
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
            scanLog={packingManager.scanLog}
            onClear={() => {
              packingManager.clearLogs();
              setPackRevision((r) => r + 1);
            }}
            onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
          />
        )}

        {/* Sync & Export Modal */}
        <SyncModal
          isOpen={isSyncModalOpen}
          onClose={() => setIsSyncModalOpen(false)}
          onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
          onFetchFromSheet={handleFetchFromSheet}
          onImportExcelFile={(file) =>
            packingManager.importExcelFile(file, (isbn) =>
              searchEngine.getCopiesForIsbn(isbn),
            )
          }
          onImportPastedIsbns={handleImportPasted}
          onReloadBackup={handleReloadBackup}
          totalScans={packingManager.scanLog.length}
        />
      </div>

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
                    ? "⛔ Already Packed"
                    : toast.isRemote
                      ? "⚡ Live Sync"
                      : "✓ Packed"}
                </span>
                <span className="pack-toast-time">{toast.time}</span>
              </div>
              <div className="pack-toast-title" title={toast.title}>
                {toast.title}
              </div>
            </div>
            <button
              className="pack-toast-close"
              onClick={() =>
                setToasts((prev) => prev.filter((t) => t.id !== toast.id))
              }
              title="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
