/**
 * auto-updater.cjs — 跨平台自动更新
 *
 * Windows: electron-updater（检测 + 下载 + 静默安装）
 * macOS:   GitHub API 手动检测（检测 + 外链下载），签名后无缝切 electron-updater
 *
 * 两个平台产出相同的 AutoUpdateState，前端 UI 统一。
 * beta 开关读 preferences.update_channel，通过 IPC 传入。
 */
const { ipcMain, shell } = require("electron");
const { app } = require("electron");

const isWin = process.platform === "win32";

let _mainWindow = null;
let _updateChannel = "stable"; // "stable" | "beta"

let _updateState = {
  status: "idle",      // idle | checking | available | downloading | downloaded | error | latest
  version: null,
  releaseNotes: null,
  releaseUrl: null,     // GitHub release page URL
  downloadUrl: null,    // direct download URL (asset)
  progress: null,       // { percent, bytesPerSecond, transferred, total }
  error: null,
};

function getState() {
  return { ..._updateState };
}

function sendToRenderer(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

function setState(patch) {
  Object.assign(_updateState, patch);
  sendToRenderer("auto-update-state", getState());
}

function resetState() {
  _updateState = {
    status: "idle", version: null, releaseNotes: null,
    releaseUrl: null, downloadUrl: null, progress: null, error: null,
  };
}

// ── 版本比较 ──
function isNewerVersion(latest, current) {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ══════════════════════════════════════
// Windows: electron-updater
// ══════════════════════════════════════
let autoUpdater = null;

function setupElectronUpdater() {
  autoUpdater = require("electron-updater").autoUpdater;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: null });
  });

  autoUpdater.on("update-available", (info) => {
    setState({
      status: "available",
      version: info.version,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : null,
      releaseUrl: `https://github.com/liliMozi/openhanako/releases/tag/v${info.version}`,
      downloadUrl: info.files?.[0]?.url || null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "latest" });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      progress: {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", () => {
    setState({ status: "downloaded", progress: null });
  });

  autoUpdater.on("error", (err) => {
    setState({ status: "error", error: err?.message || String(err) });
  });
}

async function winCheck() {
  autoUpdater.allowPrerelease = _updateChannel === "beta";
  try {
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo?.version || null;
  } catch (err) {
    setState({ status: "error", error: err?.message || String(err) });
    return null;
  }
}

async function winDownload() {
  try {
    await autoUpdater.downloadUpdate();
    return true;
  } catch (err) {
    setState({ status: "error", error: err?.message || String(err) });
    return false;
  }
}

function winInstall() {
  autoUpdater.quitAndInstall(false, true);
}

// ══════════════════════════════════════
// macOS: GitHub API 手动检测
// ══════════════════════════════════════
const GITHUB_RELEASES_URL = "https://api.github.com/repos/liliMozi/openhanako/releases";

async function macCheck() {
  setState({ status: "checking", error: null, version: null, progress: null });
  try {
    // beta: 取所有 releases 的第一个（含 prerelease）
    // stable: 取 /latest（只返回非 prerelease）
    const url = _updateChannel === "beta"
      ? GITHUB_RELEASES_URL + "?per_page=5"
      : GITHUB_RELEASES_URL + "/latest";
    const res = await fetch(url, {
      headers: { "User-Agent": "Hanako" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      setState({ status: "error", error: `GitHub API ${res.status}` });
      return null;
    }
    const data = await res.json();
    // /latest 返回对象；带 per_page 返回数组
    const release = Array.isArray(data) ? pickRelease(data) : data;
    if (!release) {
      setState({ status: "latest" });
      return null;
    }
    const latest = (release.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    if (!latest || !isNewerVersion(latest, current)) {
      setState({ status: "latest" });
      return null;
    }
    const dmgAsset = (release.assets || []).find(a => a.name?.endsWith(".dmg"));
    setState({
      status: "available",
      version: latest,
      releaseNotes: release.body || null,
      releaseUrl: release.html_url,
      downloadUrl: dmgAsset?.browser_download_url || release.html_url,
    });
    return latest;
  } catch (err) {
    setState({ status: "error", error: err?.message || String(err) });
    return null;
  }
}

/** 从 releases 数组中选出最新的可用 release（beta 模式取第一个，含 prerelease） */
function pickRelease(releases) {
  if (!releases || releases.length === 0) return null;
  if (_updateChannel === "beta") return releases[0];
  return releases.find(r => !r.prerelease && !r.draft) || null;
}

// ══════════════════════════════════════
// 公共 API
// ══════════════════════════════════════

/**
 * 初始化。所有平台都注册 IPC，Windows 额外初始化 electron-updater。
 */
function initAutoUpdater(mainWindow) {
  _mainWindow = mainWindow;

  if (isWin) {
    setupElectronUpdater();
  }

  // ── IPC handlers（所有平台） ──

  ipcMain.handle("auto-update-check", async () => {
    resetState();
    setState({ status: "checking" });
    return isWin ? winCheck() : macCheck();
  });

  ipcMain.handle("auto-update-download", async () => {
    if (isWin) return winDownload();
    // macOS: 用浏览器打开下载链接
    if (_updateState.downloadUrl) {
      shell.openExternal(_updateState.downloadUrl);
    }
    return true;
  });

  ipcMain.handle("auto-update-install", () => {
    if (isWin) return winInstall();
    // macOS: 无法自动安装，打开 release 页面
    if (_updateState.releaseUrl) {
      shell.openExternal(_updateState.releaseUrl);
    }
  });

  ipcMain.handle("auto-update-state", () => {
    return getState();
  });

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    _updateChannel = channel === "beta" ? "beta" : "stable";
  });
}

/**
 * 启动时后台检查更新
 */
async function checkForUpdatesAuto() {
  try {
    return isWin ? await winCheck() : await macCheck();
  } catch {
    return null;
  }
}

/**
 * 设置更新通道（从 preferences 同步）
 */
function setUpdateChannel(channel) {
  _updateChannel = channel === "beta" ? "beta" : "stable";
}

/**
 * 更新 mainWindow 引用
 */
function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = { initAutoUpdater, checkForUpdatesAuto, setMainWindow, setUpdateChannel, getState };
