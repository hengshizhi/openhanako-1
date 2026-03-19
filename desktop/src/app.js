/**
 * Hanako Desktop — 前端主入口（Vanilla JS 残留层）
 *
 * 大部分逻辑已迁移到 React（stores / services / components）。
 * 此文件保留：
 * - state Proxy（旧代码 ↔ Zustand 桥接，大量模块仍通过 __hanaState 访问）
 * - hanaFetch / __hanaLog（init 启动流程 + 错误上报）
 * - init()（加载 config / health / agent / WS / sessions 的编排入口）
 * - 全局 drag 阻止、panel 事件绑定、settings 快捷键
 */

// ── 阻止 Electron 默认的文件拖入导航行为 ──
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// ── 模块懒引用（bridge.ts setupLegacyShims 注入） ──
const _sb = () => window.HanaModules.sidebar;
const _dk = () => window.HanaModules.desk;
const _ag = () => window.HanaModules.appAgents;
const _ws = () => window.HanaModules.appWs;
const _ui = () => window.HanaModules.appUi;

// ── DOM 工具 ──
const $ = (sel) => document.querySelector(sel);

/** 带认证的 fetch 封装（30s 超时 + res.ok 校验） */
async function hanaFetch(path, opts = {}) {
  const headers = { ...opts.headers };
  if (state.serverToken) {
    headers["Authorization"] = `Bearer ${state.serverToken}`;
  }
  const { timeout = 30000, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${state.serverPort}${path}`, {
      ...fetchOpts, headers, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 前端日志上报：POST 到 server 写入持久化日志文件
 */
window.__hanaLog = function (level, module, message) {
  if (!state.serverPort) return;
  hanaFetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, module, message }),
  }).catch(() => {});
};

// 全局错误捕获 → 持久化日志
window.addEventListener("error", (e) => {
  window.__hanaLog("error", "desktop", `${e.message} at ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  window.__hanaLog("error", "desktop", `unhandledRejection: ${e.reason}`);
});

// ── 状态 ──
// ws 字段只存本地，不同步到 Zustand
const LOCAL_ONLY_KEYS = new Set(['ws']);

const _stateLocal = {
  serverPort: null,
  serverToken: null,
  ws: null,
  connected: false,
  isStreaming: false,
  models: [],
  currentModel: null,

  sessions: [],
  currentSessionPath: null,
  sessionStreams: {},
  sidebarOpen: true,
  sidebarAutoCollapsed: false,

  homeFolder: null,
  selectedFolder: null,
  cwdHistory: [],
  pendingNewSession: false,
  memoryEnabled: true,

  agentName: "Hanako",
  userName: "User",

  agentAvatarUrl: null,
  userAvatarUrl: null,
  agentYuan: "hanako",

  agents: [],
  currentAgentId: null,
  selectedAgentId: null,
  settingsAgentId: null,

  sessionTodos: [],

  jianOpen: true,
  jianAutoCollapsed: false,

  previewOpen: false,
  artifacts: [],
  currentArtifactId: null,

  deskFiles: [],
  deskBasePath: "",
  deskCurrentPath: "",
  deskJianContent: null,

  activities: [],

  currentTab: "chat",
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelTotalUnread: 0,

  browserRunning: false,
  browserUrl: null,
  browserThumbnail: null,
};

// Zustand 读写函数，bridge 激活后注入
let _zustandGet = null;
let _zustandSet = null;

const state = new Proxy(_stateLocal, {
  get(target, key) {
    if (_zustandGet && !LOCAL_ONLY_KEYS.has(key)) {
      const val = _zustandGet()[key];
      if (val !== undefined) return val;
    }
    return target[key];
  },
  set(target, key, value) {
    target[key] = value;
    if (_zustandSet && !LOCAL_ONLY_KEYS.has(key) && typeof value !== 'function') {
      _zustandSet({ [key]: value });
    }
    return true;
  },
});

// bridge 用：暴露 state Proxy 供旧代码访问
window.__hanaState = state;
// 暴露 helper 给 bridge.ts desk shim（late-binding）
state.clearChat = (...a) => _ag().clearChat(...a);

// bridge 激活入口：React mount 后调用，把本地已有值推入 Zustand
window.__hanaActivateProxy = function(getState, setState) {
  const patch = {};
  for (const [k, v] of Object.entries(_stateLocal)) {
    if (LOCAL_ONLY_KEYS.has(k) || typeof v === 'function') continue;
    if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      patch[k] = v;
    }
  }
  _zustandGet = getState;
  _zustandSet = setState;
  if (Object.keys(patch).length > 0) setState(patch);
};

// ── 初始化 ──
async function init() {
  state.serverPort = await platform.getServerPort();
  state.serverToken = await platform.getServerToken();
  if (!state.serverPort) {
    _ui().setStatus(t("status.serverNotReady"), false);
    platform.appReady();
    return;
  }

  try {
    const [healthRes, configRes] = await Promise.all([
      hanaFetch("/api/health"),
      hanaFetch("/api/config"),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();
    await i18n.load(configData.locale || "zh-CN");
    await _ag().applyAgentIdentity({
      agentName: healthData.agent || "Hanako",
      userName: healthData.user || "用户",
      ui: { avatars: false, agents: false, welcome: true },
    });
    state.homeFolder = configData.desk?.home_folder || null;
    state.selectedFolder = state.homeFolder || null;
    if (Array.isArray(configData.cwd_history)) {
      state.cwdHistory = configData.cwd_history;
    }
    _ui().applyStaticI18n();
    _ag().loadAvatars(healthData.avatars);
  } catch (err) {
    console.error("[init] i18n/health/config failed:", err);
  }

  const _inp = () => window.HanaModules.appInput;

  _ws().connectWS();
  await _ui().loadModels();

  state.pendingNewSession = true;
  await _ag().loadAgents();
  await _sb().loadSessions();

  _dk().initJian();
  _inp().initDragDrop();
  _sb().updateLayout();

  // 浮动面板按钮
  const _togglePanel = (panel) => {
    const s = _zustandGet?.();
    if (s?.setActivePanel) {
      s.setActivePanel(s.activePanel === panel ? null : panel);
    } else {
      state.activePanel = state.activePanel === panel ? null : panel;
    }
  };
  $("#activityBar")?.addEventListener("click", () => _togglePanel("activity"));
  $("#automationBar")?.addEventListener("click", () => _togglePanel("automation"));
  $("#bridgeBar")?.addEventListener("click", () => _togglePanel("bridge"));

  // 任务计划 badge
  try {
    const res = await hanaFetch("/api/desk/cron");
    const data = await res.json();
    const count = (data.jobs || []).length;
    const badge = document.getElementById("automationCountBadge");
    if (badge) badge.textContent = count > 0 ? count : "";
  } catch {}

  $("#browserBgBar")?.addEventListener("click", () => {
    platform?.openBrowserViewer?.();
  });

  $("#settingsBtn")?.addEventListener("click", () => platform.openSettings());

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      platform.openSettings();
    }
  });

  platform.onSettingsChanged((type, data) => {
    switch (type) {
      case "agent-switched":
        _ag().applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        _sb().loadSessions();
        window.__loadDeskSkills?.();
        break;
      case "skills-changed":
        window.__loadDeskSkills?.();
        break;
      case "locale-changed":
        i18n.load(data.locale).then(() => {
          i18n.defaultName = state.agentName;
          _ui().applyStaticI18n();
        });
        break;
      case "models-changed":
        _ui().loadModels();
        break;
      case "agent-created":
      case "agent-deleted":
        _ag().loadAgents();
        break;
      case "agent-updated":
        _ag().applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
          ui: { settings: false },
        });
        break;
      case "theme-changed":
        setTheme(data.theme);
        break;
      case "font-changed":
        setSerifFont(data.serif);
        break;
    }
  });

  platform.appReady();
}

// ── 启动 ──
loadSavedTheme();
loadSavedFont();

window.__hanaInit = init;
if (!window.__REACT_MANAGED) {
  init().catch((err) => {
    console.error("[init] 初始化异常:", err);
    platform?.appReady?.();
  });
}
