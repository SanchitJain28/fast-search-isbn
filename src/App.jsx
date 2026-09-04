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
  const [webhookUrl, setWebhookUrl] = useState(packingManager.webhookUrl);

  // Sync Needed Notification State
  const [syncAlert, setSyncAlert] = useState(null); // { remoteCount, localCount, diff } | null
  const [isSyncingNow, setIsSyncingNow] = useState(false);

  // Packing state revision counter to trigger instant re-renders
  const [packRevision, setPackRevision] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState(1);

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

  // Initialize Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fast_search_theme", theme);
  }, [theme]);

  // Subscribe to Central WebSocket Hub for Real-Time Multi-User Packing
  useEffect(() => {
    const unsubscribe = packingManager.subscribe((type, data) => {
      if (type === "USER_COUNT") {
        setOnlineUsers(data || 1);
      } else if (type === "BOOK_PACKED" || type === "SCANS_CLEARED") {
        setPackRevision((r) => r + 1);
      }
    });
    return unsubscribe;
  }, []);

  // Load Data and Build FlexSearch Index + Preload Initial Scans & Sync Central State
  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch("/master.json");
        const data = await res.json();
        const info = searchEngine.init(data);
        setStats(info);

        // 1. First attempt to sync state from central server pool (if running in multi-user network)
        const serverSynced = await packingManager.syncInitialStateFromServer((isbn) =>
          searchEngine.getCopiesForIsbn(isbn),
        );

        // 2. If no scans in server or localStorage, auto-populate from initial_scans.json backup
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
                console.log(
                  `Auto-loaded ${initIsbns.length} initial scans from backup.`,
                );
              }
            }
          } catch (scanErr) {
            console.warn("No initial scans file found:", scanErr);
          }
        } else {
          setPackRevision((r) => r + 1);
        }

        setLoading(false);
      } catch (err) {
        console.error("Failed to load master dataset:", err);
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Check for Remote Google Sheet Changes with 15s in-flight grace period
  const checkForUpdates = useCallback(async () => {
    if (!webhookUrl) return;
    const remoteCount = await packingManager.checkRemoteCount();
    const localCount = packingManager.scanLog.length;

    if (typeof remoteCount === "number") {
      const timeSinceLocalScan =
        Date.now() - (packingManager.lastLocalScanTime || 0);

      // If local is ahead because user just packed a book locally in the last 15 seconds,
      // the outbound write to Google Sheet is actively in-flight. Suppress false alarm!
      if (localCount > remoteCount && timeSinceLocalScan < 15000) {
        setSyncAlert(null);
        return;
      }

      if (remoteCount !== localCount) {
        setSyncAlert({
          remoteCount,
          localCount,
          diff: remoteCount - localCount,
        });
      } else {
        setSyncAlert(null);
      }
    }
  }, [webhookUrl]);

  // Background Change Detection Poller (every 6s + immediately when switching back to tab)
  useEffect(() => {
    if (!webhookUrl) return;

    // Check immediately
    checkForUpdates();

    // Check every 6 seconds
    const interval = setInterval(checkForUpdates, 6000);

    // Check immediately when user switches focus to this window
    const handleFocus = () => checkForUpdates();
    window.addEventListener("focus", handleFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [webhookUrl, packRevision, checkForUpdates]);

  // Execute Search (locked when sync is needed)
  const { results, latencyMs, totalMatches } = useMemo(() => {
    if (!query.trim() || syncAlert) {
      return { results: [], latencyMs: 0, totalMatches: 0 };
    }
    return searchEngine.search(query, {
      limit: 60,
      order: selectedOrder,
    });
  }, [query, selectedOrder, syncAlert]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, selectedOrder]);

  // Packing cooldown ref to prevent accidental rapid double-clicks/scanner bounces
  const lastPackRef = useRef({ isbn: '', time: 0 });

  // Handle Mark Packed with 600ms debounce protection
  const handleMarkPacked = (item) => {
    if (syncAlert) return null;
    const isbn = String(item.ISBN13 || "").trim();
    const now = Date.now();

    // Prevent duplicate triggers for the same ISBN within 600ms (mouse microswitch bounce or barcode scanner CR/LF)
    if (lastPackRef.current.isbn === isbn && now - lastPackRef.current.time < 600) {
      console.warn(`[Debounce] Ignored rapid duplicate click for ISBN: ${isbn}`);
      return null;
    }
    lastPackRef.current = { isbn, time: now };

    const candidates = searchEngine.getCopiesForIsbn(isbn);
    const logEntry = packingManager.markPacked(isbn, candidates);
    setPackRevision((r) => r + 1);
    handleCopySuccess(item);
    return logEntry;
  };

  // Keyboard navigation & Shortcuts
  const handleKeyDown = (e) => {
    if (results.length === 0 || syncAlert) return;

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
      setSyncAlert(null);
      setTimeout(() => {
        if (inputRef.current) inputRef.current.focus();
      }, 100);
      return count;
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
    setSyncAlert(null);
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
      setSyncAlert(null);
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

      {/* Live Change Alert Banner (Handles both additions AND row deletions in Sheet) */}
      {syncAlert && (
        <div className="sync-notification-banner">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className="pulsing-badge">
              <BellRing size={16} />
            </span>
            <span>
              <strong>Sync Needed!</strong> Google Sheet has been modified (
              <strong
                style={{
                  color:
                    syncAlert.diff > 0
                      ? "var(--accent-emerald)"
                      : "var(--accent-rose)",
                }}
              >
                {syncAlert.diff > 0
                  ? `+${syncAlert.diff} new scans`
                  : `${Math.abs(syncAlert.diff)} scans removed/deleted`}
              </strong>{" "}
              — Sheet: {syncAlert.remoteCount}, App: {syncAlert.localCount}).
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              className="sync-now-banner-btn"
              onClick={handleFetchFromSheet}
              disabled={isSyncingNow}
            >
              <RefreshCw size={14} className={isSyncingNow ? "spinner" : ""} />
              {isSyncingNow ? "Syncing..." : "Sync & Unlock ⚡"}
            </button>
            <button
              className="icon-btn"
              onClick={() => setSyncAlert(null)}
              style={{
                width: "28px",
                height: "28px",
                background: "transparent",
                border: "none",
                color: "#fff",
              }}
              title="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

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
            <div className="live-users-pill" title="Live WebSocket Multi-User Synchronization Active across Wi-Fi network">
              <span className="live-pulse-dot" />
              <span>{onlineUsers} {onlineUsers === 1 ? "Packer" : "Packers"} Live</span>
            </div>

            <button
              className="icon-btn"
              onClick={() => setIsSyncModalOpen(true)}
              title="Google Sheets & Excel Sync Settings"
              style={{ gap: "6px" }}
            >
              <Share2 size={16} />
              <span>Sync & Backup ({packingManager.scanLog.length})</span>
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
              isLocked={!!syncAlert}
              syncAlert={syncAlert}
              onSyncNow={handleFetchFromSheet}
              isSyncingNow={isSyncingNow}
            />

            {query.trim() && !syncAlert ? (
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
                          isLocked={!!syncAlert}
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
                  {syncAlert ? "🔒 Search is Locked Until Synced" : "Start typing to search titles instantly"}
                </div>
                <div className="empty-subtitle">
                  {syncAlert
                    ? "Click 'Sync & Unlock ⚡' above to fetch the latest Google Sheet changes."
                    : "Searches run in under 0.2 milliseconds with FlexSearch in-memory index."}
                </div>

                {!syncAlert && (
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
                )}
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
            isLocked={!!syncAlert}
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
          webhookUrl={webhookUrl}
          onSaveWebhook={(url) => {
            setWebhookUrl(url);
            packingManager.setWebhookUrl(url);
          }}
          onExportExcel={() => packingManager.exportExcel(stats.orderTotals)}
          onFetchFromSheet={handleFetchFromSheet}
          onImportPastedIsbns={handleImportPasted}
          onReloadBackup={handleReloadBackup}
        />
      </div>
    </>
  );
}
