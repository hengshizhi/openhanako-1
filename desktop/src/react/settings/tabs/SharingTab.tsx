import React, { useState } from 'react';
import { t } from '../helpers';
import styles from '../Settings.module.css';

export function SharingTab() {
  const [screenshotColor, setScreenshotColor] = useState(
    () => localStorage.getItem('hana-screenshot-color') || 'light'
  );
  const [screenshotWidth, setScreenshotWidth] = useState(
    () => localStorage.getItem('hana-screenshot-width') || 'mobile'
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="sharing">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.screenshot.title')}</h2>

        {/* 配色卡片 */}
        <div className={styles['theme-options']}>
          {([
            { key: 'light' as const, bg: '#F8F5ED', color: '#3B3D3F', accent: '#537D96' },
            { key: 'dark' as const, bg: '#2D4356', color: '#C8D1D8', accent: '#A76F6F' },
            { key: 'sakura' as const, bg: '#8ABDCE', color: '#FFFFFF', accent: 'rgba(255,255,255,0.7)' },
          ]).map(({ key, bg, color, accent }) => (
            <button
              key={key}
              className={`${styles['theme-card']}${screenshotColor === key ? ' ' + styles['active'] : ''}`}
              style={{ background: bg }}
              onClick={() => { setScreenshotColor(key); localStorage.setItem('hana-screenshot-color', key); }}
            >
              <div className={styles['theme-card-name']} style={{ color }}>{t(`settings.screenshot.${key}`)}</div>
              <div className={styles['theme-card-mode']} style={{ color: accent }}>{t('settings.screenshot.title')}</div>
            </button>
          ))}
        </div>

        {/* 宽度选择 */}
        <div className={styles['ss-width-group']}>
          {(['mobile', 'desktop'] as const).map(w => (
            <button
              key={w}
              className={`${styles['ss-width-pill']} ${screenshotWidth === w ? styles['ss-width-pill-active'] : ''}`}
              onClick={() => { setScreenshotWidth(w); localStorage.setItem('hana-screenshot-width', w); }}
            >
              {t(`settings.screenshot.${w}`)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
