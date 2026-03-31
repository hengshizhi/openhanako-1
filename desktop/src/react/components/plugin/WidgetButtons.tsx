/**
 * WidgetButtons — titlebar icons for pinned plugin widgets + plugin list + desk toggle.
 *
 * Renders to the left of the jian sidebar toggle, only when the current tab is 'chat'
 * and at least one widget-contributing plugin exists.
 */

import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../stores';
import { resolvePluginTitle, resolvePluginIcon } from '../../utils/resolve-plugin-title';
import { openWidget, openDesk } from '../../stores/plugin-ui-actions';
import s from './WidgetButtons.module.css';

export function WidgetButtons() {
  const widgets = useStore(st => st.pluginWidgets);
  const pinnedWidgets = useStore(st => st.pinnedWidgets);
  const jianView = useStore(st => st.jianView);
  const currentTab = useStore(st => st.currentTab);
  const locale = useStore(st => st.locale);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [dropdownOpen]);

  if (currentTab !== 'chat' || widgets.length === 0) return null;

  const unpinnedWidgets = widgets.filter(w => !pinnedWidgets.includes(w.pluginId));

  return (
    <div className={s.container}>
      {pinnedWidgets.map(id => {
        const w = widgets.find(x => x.pluginId === id);
        if (!w) return null;
        const icon = resolvePluginIcon(w.icon, w.title, locale);
        const title = resolvePluginTitle(w.title, locale, w.pluginId);
        const active = jianView === `widget:${id}`;
        return (
          <button
            key={id}
            className={`${s.btn}${active ? ` ${s.active}` : ''}`}
            title={title}
            onClick={() => active ? openDesk() : openWidget(id)}
            dangerouslySetInnerHTML={icon.type === 'svg' ? { __html: icon.content } : undefined}
          >
            {icon.type === 'text' ? icon.content : null}
          </button>
        );
      })}

      {unpinnedWidgets.length > 0 && (
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button className={s.btn} title="插件" onClick={() => setDropdownOpen(!dropdownOpen)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
            </svg>
          </button>
          {dropdownOpen && (
            <div className={s.dropdown}>
              {unpinnedWidgets.map(w => {
                const title = resolvePluginTitle(w.title, locale, w.pluginId);
                return (
                  <button key={w.pluginId} className={s.dropdownItem}
                    onClick={() => { openWidget(w.pluginId); setDropdownOpen(false); }}>
                    {title}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <button
        className={`${s.btn}${jianView === 'desk' ? ` ${s.active}` : ''}`}
        title="书桌"
        onClick={() => openDesk()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
      </button>
    </div>
  );
}
