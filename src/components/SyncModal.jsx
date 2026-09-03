import React, { useState } from 'react';
import { X, Copy, Check, FileSpreadsheet, Globe, RefreshCw, UploadCloud, Database, AlertCircle } from 'lucide-react';
import { GOOGLE_APPS_SCRIPT_WEBHOOK_CODE } from '../utils/sync';

export default function SyncModal({
  isOpen,
  onClose,
  webhookUrl,
  onSaveWebhook,
  onExportExcel,
  onFetchFromSheet,
  onImportPastedIsbns,
  onReloadBackup
}) {
  const [urlInput, setUrlInput] = useState(webhookUrl || '');
  const [copiedCode, setCopiedCode] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState(null);
  const [pasteText, setPasteText] = useState('');
  const [pasteMsg, setPasteMsg] = useState(null);
  const [backupMsg, setBackupMsg] = useState(null);

  if (!isOpen) return null;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_WEBHOOK_CODE);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleSave = () => {
    onSaveWebhook(urlInput);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleFetch = async () => {
    if (!urlInput.trim()) {
      setFetchMsg({ type: 'error', text: 'Please enter and save your Google Apps Script Webhook URL first.' });
      return;
    }
    setFetching(true);
    setFetchMsg(null);
    try {
      const count = await onFetchFromSheet();
      setFetchMsg({ type: 'success', text: `Successfully synced ${count} scans directly from Google Sheet!` });
    } catch (err) {
      setFetchMsg({ type: 'error', text: err.message || 'Failed to fetch from sheet.' });
    } finally {
      setFetching(false);
    }
  };

  const handlePasteImport = () => {
    if (!pasteText.trim()) return;
    const lines = pasteText.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
    const count = onImportPastedIsbns(lines);
    setPasteMsg(`Successfully imported ${count} scans! All these books are now marked "Already packed ✓".`);
    setPasteText('');
    setTimeout(() => setPasteMsg(null), 4000);
  };

  const handleRestoreBackup = async () => {
    if (onReloadBackup) {
      const count = await onReloadBackup();
      setBackupMsg(`Reset to ${count} initial backup scans.`);
      setTimeout(() => setBackupMsg(null), 3000);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Globe size={20} style={{ color: 'var(--accent-blue)' }} />
            <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Google Sheets & Scans Sync</h2>
          </div>
          <button className="icon-btn" onClick={onClose} style={{ width: '32px', height: '32px' }}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Option 1: Live Fetch from Google Sheet */}
          <div className="modal-section" style={{ background: 'var(--bg-tertiary)', padding: '14px', borderRadius: '10px' }}>
            <h3 className="section-title" style={{ color: 'var(--accent-blue)' }}>
              <RefreshCw size={16} />
              Method 1: Live Fetch from Google Sheet (via Webhook URL)
            </h3>
            <p className="section-desc">
              Pulls all current scans directly from your Google Sheet's <strong>Scan</strong> tab.
            </p>

            <div style={{ marginTop: '10px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Google Apps Script Webhook URL:
              </label>
              <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                <input
                  type="url"
                  className="modal-input"
                  placeholder="https://script.google.com/macros/s/.../exec"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
                <button className="primary-action-btn" onClick={handleSave} style={{ marginTop: 0 }}>
                  {saved ? <><Check size={15} /> Saved!</> : 'Save URL'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: '10px' }}>
              <button
                className="primary-action-btn"
                onClick={handleFetch}
                disabled={fetching || !urlInput.trim()}
                style={{
                  marginTop: 0,
                  width: '100%',
                  justifyContent: 'center',
                  background: 'var(--accent-blue)',
                  gap: '8px',
                  opacity: (!urlInput.trim() || fetching) ? 0.7 : 1
                }}
              >
                <RefreshCw size={15} className={fetching ? 'spinner' : ''} />
                {fetching ? 'Syncing with Google Sheet...' : '📥 Fetch Latest ~2,200 Scans from Google Sheet'}
              </button>
            </div>

            {fetchMsg && (
              <div style={{
                marginTop: '10px',
                padding: '8px 12px',
                borderRadius: '6px',
                fontSize: '12.5px',
                background: fetchMsg.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)',
                color: fetchMsg.type === 'success' ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                border: `1px solid ${fetchMsg.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`
              }}>
                {fetchMsg.text}
              </div>
            )}
          </div>

          <hr className="divider" />

          {/* Option 2: Quick Copy-Paste Column A */}
          <div className="modal-section" style={{ background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.25)', padding: '14px', borderRadius: '10px' }}>
            <h3 className="section-title" style={{ color: 'var(--accent-purple)' }}>
              <UploadCloud size={16} />
              Method 2: Quick Paste Column A from Google Sheet (Instant 0.01s)
            </h3>
            <p className="section-desc">
              Select and copy <strong>Column A</strong> from your <strong>Scan</strong> tab in Google Sheets (<kbd>Cmd+C</kbd> / <kbd>Ctrl+C</kbd>), paste it below, and click <strong>Import</strong>:
            </p>
            <div style={{ marginTop: '10px' }}>
              <textarea
                className="modal-input"
                style={{ width: '100%', height: '80px', fontFamily: 'var(--font-mono)', fontSize: '12px', resize: 'vertical' }}
                placeholder="Paste Column A ISBNs here (all ~2,200 rows)..."
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                <button
                  className="primary-action-btn"
                  onClick={handlePasteImport}
                  disabled={!pasteText.trim()}
                  style={{ marginTop: 0, padding: '8px 16px', fontSize: '13px', background: '#7c3aed' }}
                >
                  <UploadCloud size={15} /> Import ~2,200 Scans Instantly
                </button>
                {pasteMsg && <span style={{ fontSize: '12px', color: 'var(--accent-emerald)', fontWeight: 600 }}>{pasteMsg}</span>}
              </div>
            </div>
          </div>

          <hr className="divider" />

          {/* Apps Script Setup Code */}
          <div className="modal-section">
            <h3 className="section-title">
              <CodeIcon size={16} style={{ color: 'var(--text-secondary)' }} />
              Apps Script Code Reference (doGet + doPost)
            </h3>
            <p className="section-desc">
              If Method 1 gives an authentication error, make sure this script is deployed in your sheet with <strong>Who has access: Anyone</strong> and <strong>Version: New version</strong>.
            </p>
            <div className="code-box">
              <div className="code-box-header">
                <span>Apps Script Webhook Code</span>
                <button className="copy-code-btn" onClick={handleCopyCode}>
                  {copiedCode ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy Code</>}
                </button>
              </div>
              <pre><code>{GOOGLE_APPS_SCRIPT_WEBHOOK_CODE}</code></pre>
            </div>
          </div>

          <hr className="divider" />

          {/* Section 4: Excel Export & Backup Reset */}
          <div className="modal-section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <button className="primary-action-btn" onClick={onExportExcel} style={{ marginTop: 0 }}>
              <FileSpreadsheet size={16} /> Download Packed Scans (.xlsx)
            </button>
            <button
              className="icon-btn"
              onClick={handleRestoreBackup}
              title="Reset to the initial 1,665 backup"
              style={{ fontSize: '12px', gap: '6px', color: 'var(--text-muted)' }}
            >
              <Database size={14} /> Re-load 1,665 static backup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodeIcon({ size, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
