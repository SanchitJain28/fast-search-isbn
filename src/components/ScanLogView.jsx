import React from 'react';
import { FileSpreadsheet, Trash2, CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react';

export default function ScanLogView({ scanLog = [], onClear, onExportExcel }) {
  if (scanLog.length === 0) {
    return (
      <div className="empty-state">
        <CheckCircle2 className="empty-icon" style={{ color: 'var(--accent-emerald)' }} />
        <div className="empty-title">No books packed yet in this session</div>
        <div className="empty-subtitle">
          Search for any title in the Search tab and click <strong>"Mark packed"</strong> or copy ISBNs.
        </div>
      </div>
    );
  }

  return (
    <div className="scan-log-container">
      <div className="results-header">
        <div>
          Total Scans: <strong>{scanLog.length}</strong>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="icon-btn"
            onClick={onExportExcel}
            style={{ width: 'auto', padding: '6px 12px', fontSize: '12px', gap: '6px' }}
          >
            <FileSpreadsheet size={14} /> Export Excel
          </button>
          <button
            className="icon-btn"
            onClick={onClear}
            style={{ width: 'auto', padding: '6px 12px', fontSize: '12px', gap: '6px', color: 'var(--accent-rose)' }}
          >
            <Trash2 size={14} /> Clear Log
          </button>
        </div>
      </div>

      <div className="results-list">
        {scanLog.map((scan) => (
          <div key={scan.id} className="result-card">
            <div className="card-left">
              <div className="card-title-row">
                <span className="card-title">{scan.title || 'Unknown Title'}</span>
              </div>
              <div className="card-meta-row">
                <span className={`order-badge order-${String(scan.order || '').toLowerCase()}`}>
                  Order {scan.order || '—'}
                </span>
                <span className="isbn-pill">{scan.isbn}</span>
                <span className="copy-count-badge">• {scan.timestamp}</span>
              </div>
              <div className={`action-status-banner ${scan.statusType === 'DUPLICATE' ? 'status-dup' : 'status-pack'}`}>
                {scan.status}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
