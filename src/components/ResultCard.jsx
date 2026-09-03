import React, { useState } from 'react';
import { Copy, Check, Hash, PackageCheck, CheckCircle2 } from 'lucide-react';
import { soundFx } from '../utils/audio';

function getOrderClass(order) {
  const o = String(order || '').toUpperCase();
  if (o === '317') return 'order-317';
  if (o === '322') return 'order-322';
  if (o === '323') return 'order-323';
  if (o === '327') return 'order-327';
  if (o.includes('OX')) return 'order-ox2';
  return 'order-default';
}

function highlightMatch(text, query) {
  if (!query || !query.trim() || !text) return text;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return text;

  const escapedTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const parts = String(text).split(regex);

  return parts.map((part, i) =>
    regex.test(part) ? <mark key={i}>{part}</mark> : part
  );
}

export default function ResultCard({
  item,
  query,
  isSelected,
  packedCount = 0,
  totalCopies = 1,
  onCopy,
  onMarkPacked,
  isLocked = false
}) {
  const [copied, setCopied] = useState(false);
  const [lastAction, setLastAction] = useState(null);

  const isbn = String(item.ISBN13 || '').trim();
  const order = String(item.Order || '').trim();
  const orderClass = getOrderClass(order);

  const isFullyPacked = packedCount >= totalCopies;
  const remainingCopies = Math.max(0, totalCopies - packedCount);

  const handleCopy = (e) => {
    e.stopPropagation();
    if (isLocked) return;
    navigator.clipboard.writeText(isbn);
    soundFx.copySuccess();
    setCopied(true);
    if (onCopy) onCopy(item);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleMarkPacked = (e) => {
    e.stopPropagation();
    if (isFullyPacked || isLocked) return;
    if (onMarkPacked) {
      const res = onMarkPacked(item);
      setLastAction(res);
      soundFx.copySuccess();
    }
  };

  return (
    <div
      className={`result-card ${isSelected ? 'selected' : ''} ${isFullyPacked ? 'card-fully-packed' : ''} ${isLocked ? 'card-locked' : ''}`}
      onClick={!isLocked ? handleCopy : undefined}
      title={isLocked ? 'Action locked until synced' : 'Click card to copy ISBN'}
      style={{ opacity: isLocked ? 0.6 : 1 }}
    >
      <div className="card-left">
        <div className="card-title-row">
          <span className="card-title">
            {highlightMatch(item.Title, query)}
          </span>
        </div>

        <div className="card-meta-row">
          <span className={`order-badge ${orderClass}`}>
            Order {order || '—'}
          </span>

          <span className="isbn-pill">
            <Hash size={13} style={{ opacity: 0.6 }} />
            {isbn}
          </span>

          {totalCopies > 1 ? (
            <span
              className="copy-count-badge"
              style={{
                color: isFullyPacked ? 'var(--accent-emerald)' : 'var(--accent-amber)',
                fontWeight: 600
              }}
            >
              • {packedCount}/{totalCopies} Packed ({remainingCopies} left)
            </span>
          ) : isFullyPacked ? (
            <span className="copy-count-badge" style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>
              • Already packed ✓
            </span>
          ) : null}

          {item.Qty && (
            <span className="copy-count-badge">
              • Qty: {item.Qty}
            </span>
          )}
        </div>

        {lastAction && (
          <div className={`action-status-banner ${lastAction.statusType === 'DUPLICATE' ? 'status-dup' : 'status-pack'}`}>
            {lastAction.status}
          </div>
        )}
      </div>

      <div className="card-actions">
        {/* Mark Packed Button */}
        {isFullyPacked ? (
          <button className="mark-packed-btn done" disabled title="This book is already fully packed">
            <CheckCircle2 size={15} /> Already packed ✓
          </button>
        ) : (
          <button
            className="mark-packed-btn"
            onClick={handleMarkPacked}
            disabled={isLocked}
            title={isLocked ? 'Locked until synced' : 'Mark this book as packed'}
            style={{ opacity: isLocked ? 0.5 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}
          >
            <PackageCheck size={15} />
            {totalCopies > 1 && packedCount > 0
              ? `Pack copy ${packedCount + 1} of ${totalCopies}`
              : 'Mark packed'}
          </button>
        )}

        {/* Copy ISBN Button */}
        <button
          className={`copy-isbn-btn ${copied ? 'copied' : ''}`}
          onClick={handleCopy}
          disabled={isLocked}
          title={isLocked ? 'Locked until synced' : 'Copy ISBN-13 to clipboard'}
          style={{ opacity: isLocked ? 0.5 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}
        >
          {copied ? (
            <>
              <Check size={15} /> Copied!
            </>
          ) : (
            <>
              <Copy size={15} /> Copy ISBN
            </>
          )}
        </button>
      </div>
    </div>
  );
}
