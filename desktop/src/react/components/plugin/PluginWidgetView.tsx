import { useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import s from './PluginWidgetView.module.css';

declare function t(key: string): string;

interface Props {
  pluginId: string;
}

export function PluginWidgetView({ pluginId }: Props) {
  const widgets = useStore(st => st.pluginWidgets);
  const widget = useMemo(() => widgets.find(w => w.pluginId === pluginId), [widgets, pluginId]);

  const iframeSrc = useMemo(() => {
    if (!widget?.routeUrl) return null;
    const theme = document.documentElement.dataset.theme || 'warm-paper';
    const cssUrl = `/api/plugins/theme.css?theme=${encodeURIComponent(theme)}`;
    const sep = widget.routeUrl.includes('?') ? '&' : '?';
    return `${widget.routeUrl}${sep}hana-theme=${encodeURIComponent(theme)}&hana-css=${encodeURIComponent(cssUrl)}`;
  }, [widget?.routeUrl]);

  const { iframeRef, status, retry } = usePluginIframe(iframeSrc);

  if (!widget) {
    return <div className={s.error}>{t?.('plugin.notFound') || 'Widget not found'}</div>;
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>{t?.('plugin.loadFailed') || '加载失败'}</p>
          <button className={s.retryBtn} onClick={retry}>{t?.('plugin.retry') || '重试'}</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={iframeSrc || undefined}
        sandbox="allow-scripts allow-forms allow-popups"
        style={{ opacity: status === 'ready' ? 1 : 0 }}
      />
    </div>
  );
}
