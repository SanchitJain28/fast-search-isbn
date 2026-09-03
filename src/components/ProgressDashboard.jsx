import React from 'react';
import { CheckCircle2, AlertTriangle, HelpCircle, Package, ArrowRight, FileSpreadsheet } from 'lucide-react';

export default function ProgressDashboard({ progress, onExportExcel, onSelectOrder }) {
  if (!progress) return null;

  const { orders = [], totalScanned, totalPacked, duplicates, notFound } = progress;

  return (
    <div className="progress-dashboard">
      {/* Top Metric Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-blue)' }}>
            <Package size={20} />
          </div>
          <div>
            <div className="kpi-value">{totalPacked.toLocaleString()}</div>
            <div className="kpi-label">Books Packed</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'var(--accent-emerald)' }}>
            <CheckCircle2 size={20} />
          </div>
          <div>
            <div className="kpi-value">{totalScanned.toLocaleString()}</div>
            <div className="kpi-label">Total Scans</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ background: 'rgba(245, 158, 11, 0.15)', color: 'var(--accent-amber)' }}>
            <AlertTriangle size={20} />
          </div>
          <div>
            <div className="kpi-value">{duplicates.toLocaleString()}</div>
            <div className="kpi-label">Duplicates Caught</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper" style={{ background: 'rgba(244, 63, 94, 0.15)', color: 'var(--accent-rose)' }}>
            <HelpCircle size={20} />
          </div>
          <div>
            <div className="kpi-value">{notFound.toLocaleString()}</div>
            <div className="kpi-label">Not Found</div>
          </div>
        </div>
      </div>

      {/* Orders Table & Progress Bars */}
      <div className="orders-table-wrapper">
        <div className="table-header-row">
          <div style={{ fontWeight: 700, fontSize: '15px' }}>Order Packing Status (Box-wise)</div>
          <button className="icon-btn" onClick={onExportExcel} title="Export to Excel" style={{ width: 'auto', padding: '6px 12px', fontSize: '12px', gap: '6px' }}>
            <FileSpreadsheet size={15} /> Export .xlsx
          </button>
        </div>

        <div className="orders-list">
          {orders.map((o) => (
            <div key={o.order} className="order-progress-row">
              <div className="order-progress-info">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`order-badge order-${o.order.toLowerCase()}`}>
                    Order {o.order}
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>
                    {o.packed} / {o.total} packed
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {o.remaining} remaining ({o.pct}%)
                </div>
              </div>

              <div className="progress-bar-bg">
                <div
                  className="progress-bar-fill"
                  style={{
                    width: `${o.pct}%`,
                    background: o.pct >= 100 ? 'var(--accent-emerald)' : 'var(--accent-blue)'
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
