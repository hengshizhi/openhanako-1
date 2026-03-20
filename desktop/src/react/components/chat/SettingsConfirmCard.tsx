/**
 * SettingsConfirmCard — 设置修改确认卡片
 *
 * 三种控件：toggle / list / text
 * 用户可编辑后确认/取消，通过 REST API resolve 阻塞的 tool Promise。
 */

import { memo, useState, useCallback } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';

interface Props {
  confirmId: string;
  settingKey: string;
  cardType: 'toggle' | 'list' | 'text';
  currentValue: string;
  proposedValue: string;
  options?: string[];
  label: string;
  description?: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
}

function toggleLabel(from: string, to: string, t: (k: string) => string): string {
  const f = from === 'true' ? t('common.on') : t('common.off');
  const toLabel = to === 'true' ? t('common.on') : t('common.off');
  return `${f} → ${toLabel}`;
}

export const SettingsConfirmCard = memo(function SettingsConfirmCard(props: Props) {
  const { confirmId, cardType, currentValue, proposedValue, options, label, description, status: initialStatus } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState(initialStatus);
  const [editValue, setEditValue] = useState(proposedValue);

  const handleConfirm = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value: editValue }),
      });
      setStatus('confirmed');
    } catch { /* silent */ }
  }, [confirmId, editValue]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
    } catch { /* silent */ }
  }, [confirmId]);

  // ── 已完成状态 ──
  if (status !== 'pending') {
    if (status === 'confirmed' && cardType === 'toggle') {
      return (
        <div className="settings-confirm-card done">
          <div className="settings-confirm-header">
            <span className="settings-confirm-label">{label}</span>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`} style={{ pointerEvents: 'none' }}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className="settings-confirm-note">{toggleLabel(currentValue, editValue, t)}</div>
        </div>
      );
    }
    const statusText = status === 'confirmed' ? `${label} → ${editValue}`
      : status === 'rejected' ? t('common.changeRejected').replace('{label}', label)
      : t('common.changeTimeout').replace('{label}', label);
    const statusClass = status === 'confirmed' ? 'confirmed' : 'rejected';
    return (
      <div className="settings-confirm-card done">
        <div className={`settings-confirm-status ${statusClass}`}>{statusText}</div>
      </div>
    );
  }

  // ── Pending 状态 ──
  return (
    <div className="settings-confirm-card">
      {cardType === 'toggle' ? (
        <>
          <div className="settings-confirm-header" onClick={() => setEditValue(editValue === 'true' ? 'false' : 'true')} style={{ cursor: 'pointer' }}>
            <div>
              <div className="settings-confirm-label">{label}</div>
              {description && <div className="settings-confirm-desc">{description}</div>}
            </div>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className="settings-confirm-note">{toggleLabel(currentValue, editValue, t)}</div>
        </>
      ) : (
        <>
          <div className="settings-confirm-label">{label}</div>
          {description && <div className="settings-confirm-desc">{description}</div>}
          <div className="settings-confirm-control">
            {cardType === 'list' && options && (
              <div className="settings-confirm-options">
                {options.map(opt => (
                  <button
                    key={opt}
                    className={`settings-confirm-option${opt === editValue ? ' selected' : ''}`}
                    onClick={() => setEditValue(opt)}
                  >
                    {opt === editValue ? '✓ ' : ''}{opt}
                  </button>
                ))}
              </div>
            )}
            {cardType === 'text' && (
              <input
                className="settings-confirm-input"
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
              />
            )}
          </div>
        </>
      )}

      <div className="settings-confirm-actions">
        <button className="settings-confirm-btn confirm" onClick={handleConfirm}>{t('common.confirm')}</button>
        <button className="settings-confirm-btn reject" onClick={handleReject}>{t('common.cancel')}</button>
      </div>
    </div>
  );
});
