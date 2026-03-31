/**
 * PluginTabOverflow — overflow dropdown for excess tabs in ChannelTabBar.
 *
 * Shows a "more" button that opens a dropdown listing tabs that don't fit
 * in the visible tab bar area.
 */

import { useState, useRef, useEffect } from 'react';
import type { TabType } from '../../types';
import s from './PluginTabOverflow.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface Props {
  tabs: { id: TabType; label: string }[];
  currentTab: TabType;
  onSelect: (tab: TabType) => void;
}

export function PluginTabOverflow({ tabs, currentTab, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  if (tabs.length === 0) return null;

  const hasActive = tabs.some(tab => tab.id === currentTab);

  return (
    <div className={s.overflowWrap} ref={wrapRef}>
      <button
        className={`${s.overflowBtn}${open || hasActive ? ` ${s.overflowBtnActive}` : ''}`}
        title={t('channel.moreTabs')}
        onClick={() => setOpen(v => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className={s.dropdown}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`${s.dropdownItem}${tab.id === currentTab ? ` ${s.dropdownItemActive}` : ''}`}
              onClick={() => { onSelect(tab.id); setOpen(false); }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
