/**
 * Bridge — 旧代码 ↔ Zustand 状态桥
 *
 * 核心机制：app.js 的 state 是 Proxy，React mount 后激活，
 * 读写直接走 Zustand，不再需要双向同步。
 *
 * setupLegacyShims() 把已迁移到 React 的模块注册到 window.HanaModules，
 * 供 app.js init() 和残留旧代码通过懒引用调用。
 */

import { useStore, type StoreState } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import * as sessionActions from './stores/session-actions';
import { loadMessages } from './stores/session-actions';
import { applyTbToggleState, hideFloatCard, updateLayout, toggleSidebar } from './components/SidebarLayout';
import * as agentActions from './stores/agent-actions';
import { yuanFallbackAvatar, randomWelcome, yuanPlaceholder } from './utils/agent-helpers';
import { parseMoodFromContent, parseXingFromContent, parseUserAttachments, cleanMoodText, moodLabel } from './utils/message-parser';
import { connectWebSocket } from './services/websocket';
import { handleServerMessage, applyStreamingStatus } from './services/ws-message-handler';
import { requestStreamResume } from './services/stream-resume';
import { setStatus, showError, loadModels, applyStaticI18n } from './utils/ui-helpers';
import * as artifactActions from './stores/artifact-actions';
import * as deskActions from './stores/desk-actions';

declare global {
  interface Window {
    __hanaActivateProxy: (
      getState: () => StoreState,
      setState: (patch: Partial<StoreState>) => void,
    ) => void;
    __hanaGetState: () => StoreState;
  }
}

/**
 * 激活 Proxy：让 app.js 的 state 对象读写直接走 Zustand
 */
function activateProxy(): void {
  window.__hanaActivateProxy?.(
    () => useStore.getState(),
    (patch) => useStore.setState(patch),
  );
  // 暴露 store 给非 React 代码
  (window as any).__zustandStore = { getState: () => useStore.getState() };
}

/**
 * 兼容 shim：已迁移到 React 的模块仍被旧代码引用
 */
function setupLegacyShims(): void {
  const modules = ((window as unknown as Record<string, unknown>).HanaModules ||= {}) as Record<string, unknown>;

  // activity / automation 面板状态
  modules.activity = {
    isActivityVisible: () => useStore.getState().activePanel === 'activity',
    hideActivityPanel: () => useStore.getState().setActivePanel(null),
    closeActivityDetail: () => {},
    isAutomationVisible: () => useStore.getState().activePanel === 'automation',
    hideAutomationPanel: () => useStore.getState().setActivePanel(null),
  };

  // bridge 面板状态
  modules.bridge = {
    isBridgeVisible: () => useStore.getState().activePanel === 'bridge',
    hideBridgePanel: () => useStore.getState().setActivePanel(null),
  };

  // artifacts
  modules.artifacts = {
    handleArtifact: (data: any) => artifactActions.handleArtifact(data),
    renderBrowserCard: () => {},
    openPreview: (a: any) => artifactActions.openPreview(a),
    closePreview: () => artifactActions.closePreview(),
    initArtifacts: () => {},
  };
  artifactActions.initEditorEvents();

  // desk
  let _ctxMenuCleanup: (() => void) | null = null;
  modules.desk = {
    initJian: () => deskActions.initJian(),
    toggleJianSidebar: (...a: [boolean?]) => deskActions.toggleJianSidebar(...a),
    loadDeskFiles: (...a: [string?, string?]) => deskActions.loadDeskFiles(...a),
    renderDeskFiles: () => {},
    deskFullPath: (n: string) => deskActions.deskFullPath(n),
    deskCurrentDir: () => deskActions.deskCurrentDir(),
    showContextMenu: (x: number, y: number, items: Array<{ label?: string; action?: () => void; danger?: boolean; divider?: boolean }>) => {
      // 命令式 DOM 菜单：给 ChannelsPanel 等尚未迁移到 React ContextMenu 的调用者使用
      (modules.desk as any).hideContextMenu();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      for (const item of items) {
        if (item.divider) { const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d); continue; }
        const el = document.createElement('div');
        el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
        el.textContent = item.label || '';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); (modules.desk as any).hideContextMenu(); item.action?.(); });
        menu.appendChild(el);
      }
      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      (window as any).__ctxMenu = menu;
      setTimeout(() => {
        if ((window as any).__ctxMenu !== menu) return;
        const close = (ev: MouseEvent) => {
          if ((window as any).__ctxMenu?.contains(ev.target as Node)) return;
          (modules.desk as any).hideContextMenu();
        };
        document.addEventListener('click', close, true);
        document.addEventListener('contextmenu', close, true);
        _ctxMenuCleanup = () => {
          document.removeEventListener('click', close, true);
          document.removeEventListener('contextmenu', close, true);
        };
      });
    },
    hideContextMenu: () => {
      const m = (window as any).__ctxMenu;
      if (m) { m.remove(); (window as any).__ctxMenu = null; }
      if (_ctxMenuCleanup) { _ctxMenuCleanup(); _ctxMenuCleanup = null; }
    },
    showDeskContextMenu: () => {},
    toggleMemory: () => deskActions.toggleMemory(),
    updateMemoryToggle: () => {},
    selectFolder: () => {},
    applyFolder: (f: string) => deskActions.applyFolder(f),
    updateFolderButton: () => {},
    updateDeskContextBtn: () => deskActions.updateDeskContextBtn(),
    saveJianContent: (c?: string) => deskActions.saveJianContent(c),
    deskUploadFiles: (p: string[]) => deskActions.deskUploadFiles(p),
    deskCreateFile: (t: string) => deskActions.deskCreateFile(t),
    deskRemoveFile: (n: string) => deskActions.deskRemoveFile(n),
    deskMoveFiles: (ns: string[], d: string) => deskActions.deskMoveFiles(ns, d),
    deskMkdir: () => deskActions.deskMkdir(),
    initDesk: () => {},
  };

  // sidebar
  modules.sidebar = {
    loadSessions: () => sessionActions.loadSessions(),
    switchSession: (p: string) => sessionActions.switchSession(p),
    createNewSession: () => sessionActions.createNewSession(),
    ensureSession: () => sessionActions.ensureSession(),
    archiveSession: (p: string) => sessionActions.archiveSession(p),
    toggleSidebar: (forceOpen?: boolean) => toggleSidebar(forceOpen),
    updateTbToggleState: () => applyTbToggleState(),
    updateLayout: () => updateLayout(),
    initSidebar: () => {},
    initSidebarResize: () => {},
    initSidebarModule: () => {},
    dismissFloat: () => hideFloatCard(),
  };

  // channels
  modules.channels = {
    initChannels: () => {},
    switchTab: (tab: string) => useStore.getState().setCurrentTab(tab as any),
    loadChannels: () => useStore.getState().loadChannels(),
    updateChannelTabBadge: () => {},
    renderChannelList: () => {},
    renderChannelMessages: () => {},
    openChannel: (id: string, isDM?: boolean) => useStore.getState().openChannel(id, isDM),
  };

  // appMessages
  modules.appMessages = {
    cleanMoodText,
    moodLabel,
    parseMoodFromContent,
    parseXingFromContent,
    parseUserAttachments,
    loadMessages: () => loadMessages(),
    initAppMessages: () => {},
  };

  // appAgents
  modules.appAgents = {
    yuanFallbackAvatar: (yuan: string) => yuanFallbackAvatar(yuan),
    randomWelcome: (name?: string, yuan?: string) => randomWelcome(name, yuan),
    yuanPlaceholder: (yuan?: string) => yuanPlaceholder(yuan),
    renderWelcomeAgentSelector: () => {},
    clearChat: () => agentActions.clearChat(),
    applyAgentIdentity: (opts: any) => agentActions.applyAgentIdentity(opts),
    loadAgents: () => agentActions.loadAgents(),
    loadAvatars: (info?: Record<string, boolean>) => agentActions.loadAvatars(info),
    initAppAgents: () => {},
  };

  // appWs
  modules.appWs = {
    connectWS: () => connectWebSocket(),
    handleServerMessage: (msg: any) => handleServerMessage(msg),
    requestStreamResume: (sp?: string, opts?: any) => requestStreamResume(sp, opts),
    applyStreamingStatus: (s: boolean) => applyStreamingStatus(s),
    initAppWs: () => {},
  };

  // appUi
  modules.appUi = {
    scrollToBottom: () => {},
    resetScroll: () => {},
    initScrollListener: () => {},
    setStatus: (text: string, connected: boolean) => setStatus(text, connected),
    showError: (msg: string) => showError(msg),
    loadModels: () => loadModels(),
    applyStaticI18n: () => applyStaticI18n(),
    initAppUi: () => {},
  };

  // appInput（拖拽附件绑定在 mainContent 上，不在 portal 内）
  {
    let dragCounter = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (modules as any).appInput = {
      getAttachedCount: () => useStore.getState().attachedFiles.length,
      getDeskContextAttached: () => useStore.getState().deskContextAttached,
      setDeskContextAttached: (v: boolean) => useStore.getState().setDeskContextAttached(v),
      renderAttachedFiles: () => {},
      sendMessage: () => {},
      stopGeneration: () => {},
      autoResize: () => {},
      initInputListeners: () => {},
      initDeskContextBtn: () => {},
      initAppInput: () => {},
      initDragDrop: () => {
        const mainContent = document.querySelector('.main-content');
        const dropOverlay = document.getElementById('dropOverlay');
        if (!mainContent || !dropOverlay) return;

        mainContent.addEventListener('dragenter', (e) => {
          e.preventDefault();
          dragCounter++;
          if (dragCounter === 1) dropOverlay.classList.add('visible');
        });
        mainContent.addEventListener('dragleave', (e) => {
          e.preventDefault();
          dragCounter--;
          if (dragCounter === 0) dropOverlay.classList.remove('visible');
        });
        mainContent.addEventListener('dragover', (e) => e.preventDefault());
        mainContent.addEventListener('drop', async (e: Event) => {
          e.preventDefault();
          dragCounter = 0;
          dropOverlay.classList.remove('visible');

          const de = e as DragEvent;
          const files = de.dataTransfer?.files;
          if (!files || files.length === 0) return;

          const store = useStore.getState();
          if (store.attachedFiles.length >= 9) return;

          let srcPaths: string[] = [];
          const nameMap: Record<string, string> = {};
          for (const file of Array.from(files)) {
            const filePath = window.platform?.getFilePath?.(file);
            if (filePath) {
              srcPaths.push(filePath);
              nameMap[filePath] = file.name;
            }
          }
          if (srcPaths.length === 0) return;

          // Desk 文件直接附加（保留原始路径，不走 upload）
          // 路径正规化：统一为 / 做比较，兼容 macOS 和 Windows
          const toSlash = (s: string) => s.replace(/\\/g, '/');
          const baseName = (s: string) => s.replace(/\\/g, '/').split('/').pop() || s;
          const s = useStore.getState();
          const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
          if (deskBase) {
            const prefix = deskBase + '/';
            const deskFileMap = new Map(s.deskFiles.map(f => [f.name, f]));
            const isDeskPath = (p: string) => toSlash(p).startsWith(prefix);
            const deskPaths = srcPaths.filter(isDeskPath);
            srcPaths = srcPaths.filter(p => !isDeskPath(p));
            for (const p of deskPaths) {
              if (useStore.getState().attachedFiles.length >= 9) break;
              const name = baseName(p);
              const knownFile = deskFileMap.get(name);
              useStore.getState().addAttachedFile({
                path: p,
                name,
                isDirectory: knownFile?.isDir ?? false,
              });
            }
          }
          if (srcPaths.length === 0) return;

          try {
            const res = await hanaFetch('/api/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: srcPaths }),
            });
            const data = await res.json();
            for (const item of (data.uploads || [])) {
              if (item.dest) {
                useStore.getState().addAttachedFile({
                  path: item.dest,
                  name: item.name,
                  isDirectory: item.isDirectory || false,
                });
              }
            }
          } catch (err) {
            console.error('[upload]', err);
            for (const p of srcPaths) {
              useStore.getState().addAttachedFile({
                path: p,
                name: nameMap[p] || p.split('/').pop() || p,
              });
            }
          }
        });
      },
    };
  }
}

/**
 * 初始化 bridge，在 React App mount 时调用
 * 返回 cleanup 函数
 */
export function initBridge(): () => void {
  activateProxy();
  setupLegacyShims();
  window.__hanaGetState = () => useStore.getState();

  return () => { /* cleanup reserved */ };
}
