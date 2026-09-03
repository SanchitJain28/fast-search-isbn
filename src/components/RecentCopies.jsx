import React from 'react';
import { History, Copy, Trash2 } from 'lucide-react';
import { soundFx } from '../utils/audio';

export default function RecentCopies({ history = [], onClear, onReCopy }) {
  if (!history || history.length === 0) return null;

  return (
    <div className="recent-tray">
      <div className="recent-tray-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <History size={16} style={{ color: 'var(--accent-blue)' }} />
          <span>Recent Copies ({history.length})</span>
        </div>
        <button
          className="icon-btn"
          onClick={onClear}
          title="Clear copy history"
          style={{ width: '28px', height: '28px' }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="recent-items-list">
        {history.map((item, idx) => (
          <div key={idx} className="recent-item-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.Title}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px', marginTop: '2px' }}>
                <span>Order {item.Order}</span>
                <span>•</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{item.ISBN13}</span>
                <span>•</span>
                <span>{item.time}</span>
              </div>
            </div>

            <button
              className="copy-isbn-btn"
              style={{ padding: '4px 10px', fontSize: '12px' }}
              onClick={() => {
                navigator.clipboard.writeText(item.ISBN13);
                soundFx.copySuccess();
                if (onReCopy) onReCopy(item);
              }}
              title="Copy again"
            >
              <Copy size={13} /> Copy
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
