import React, { useState, useEffect, useRef } from 'react';
import { t } from '../helpers';
import styles from '../Settings.module.css';

const PREVIEW_ESSAY = `# 风

风不是一个东西。风是空气决定换个位置时产生的动静。

你拍不了风的照片。你只能拍被风碰过的东西：旗子、水面、某个人被吹乱的刘海。风永远需要借别人的身体才能被看见，它自己是透明的，连影子都没有。整座城市里最大的存在感来自一个看不见的东西，想想也挺奇怪的。

午后三点的风带着温度。不热不凉，是那种"跟环境差不多，但吹过来你才意识到空气其实在移动"的风。像有人在你旁边轻轻叹了口气。不是冲着你，也不是冲着谁，就是它自己的呼吸。

风穿过巷子和穿过大路完全是两个性格。巷子里的风是被挤过来的，带加速度，有点横冲直撞。大路上的风散漫，到处溜达，没什么目标。最有脾气的是高楼之间的风，两栋楼把它夹在中间，像一个漏斗，它挤出来的时候又快又急，带着被压缩过的委屈。`;

const ALL_COMBOS = ['light', 'dark', 'sakura'].flatMap(c =>
  ['mobile', 'desktop'].map(w => ({ color: c, width: w }))
);

function buildThemeNameLocal(color: string, width: string): string {
  const base = color === 'sakura' ? 'sakura-light' : `solarized-${color}`;
  return width === 'desktop' ? `${base}-desktop` : base;
}

export function SharingTab() {
  const [screenshotColor, setScreenshotColor] = useState(
    () => localStorage.getItem('hana-screenshot-color') || 'light'
  );
  const [screenshotWidth, setScreenshotWidth] = useState(
    () => localStorage.getItem('hana-screenshot-width') || 'mobile'
  );

  // 预览图缓存 key → base64（一次性渲染全部 6 张）
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const didRender = useRef(false);

  useEffect(() => {
    if (didRender.current) return;
    didRender.current = true;

    const hana = (window as any).hana;
    if (!hana?.screenshotRender) return;

    // 串行渲染（共享离屏窗口有 mutex）
    let chain = Promise.resolve();
    for (const { color, width } of ALL_COMBOS) {
      const key = `${color}-${width}`;
      chain = chain.then(() =>
        hana.screenshotRender({
          mode: 'article',
          theme: buildThemeNameLocal(color, width),
          markdown: PREVIEW_ESSAY,
          preview: true,
        }).then((result: any) => {
          if (result.success) {
            setPreviews(prev => ({ ...prev, [key]: result.base64 }));
          }
        }).catch(() => {})
      );
    }
  }, []);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="sharing">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.screenshot.title')}</h2>
        <p className={styles['settings-section-desc']}>{t('settings.screenshot.desc')}</p>

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

        {/* 宽度选择：预览卡片 */}
        <div className={styles['ss-layout-group']}>
          {([
            { width: 'mobile' as const, title: t('settings.screenshot.mobileTitle'), desc: t('settings.screenshot.mobileDesc') },
            { width: 'desktop' as const, title: t('settings.screenshot.desktopTitle'), desc: t('settings.screenshot.desktopDesc') },
          ]).map(({ width, title, desc }) => {
            const key = `${screenshotColor}-${width}`;
            const src = previews[key];
            return (
              <button
                key={width}
                className={`${styles['ss-layout-card']}${screenshotWidth === width ? ' ' + styles['active'] : ''}`}
                onClick={() => { setScreenshotWidth(width); localStorage.setItem('hana-screenshot-width', width); }}
              >
                <div className={styles['ss-layout-preview']}>
                  {src ? (
                    <img src={`data:image/png;base64,${src}`} alt={title} draggable={false} />
                  ) : (
                    <div className={styles['ss-layout-loading']} />
                  )}
                </div>
                <div className={styles['ss-layout-info']}>
                  <div className={styles['ss-layout-title']}>{title}</div>
                  <div className={styles['ss-layout-desc']}>{desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
