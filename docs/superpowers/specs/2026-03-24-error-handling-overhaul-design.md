# Error Handling Overhaul — Design Spec

**Date**: 2026-03-24
**Status**: Draft
**Scope**: 全量修复 — 基础设施 + 所有已知缺陷

## 问题陈述

当前项目的错误处理碎片化严重：

- **崩溃级**：`copyDirSync` 无 try-catch（Windows 文件锁直接崩）、`main.cjs` 多处裸 `JSON.parse(readFileSync(...))`、CLI 裸 `JSON.parse` WebSocket 消息、`first-run.js` 的 `statSync` TOCTOU 竞态
- **功能受损**：LLM 调用超时无重试无用户提示、WebSocket `onerror` 完全为空、web-search 三个 provider 的 `res.json()` 无 try-catch、CLI fetch 不检查 `res.ok`
- **体验降级**：Toast 无 action 按钮 / 不能持久化关键错误 / 无去重、设置页有独立 Toast 实现（重复代码）、ErrorBoundary 只有一个全局的、错误消息混合中英文

核心问题：AI 编码场景下，每次新 session 都可能忘记错误处理约定。需要**结构强制**而非**约定依赖**的错误架构。

## 设计原则

1. **结构强制优于约定依赖**：AI 什么都不记得的情况下，系统仍然正确运作
2. **四层防线**：工具函数 → 中间件/包装器 → 区域 ErrorBoundary → 全局兜底，每层自动生效
3. **ErrorBus 中心化路由**：所有错误最终汇聚到 ErrorBus，统一分类、去重、路由到正确的反馈通道
4. **安静的反馈**：错误反馈存在但不喧哗，符合项目设计哲学
5. **i18n 分层**：用户可见的走 i18n（toast / 状态栏 / fallback），开发者级别的保持英文（console / 日志）

## 模块格式约束

项目存在三种模块环境，共享代码必须适配：

| 进程 | 模块格式 | 说明 |
|------|---------|------|
| 主进程 `desktop/main.cjs` | CommonJS (`require()`) | 不能直接 import ESM 或 TS |
| 服务端 `core/`, `server/`, `lib/` | ESM JavaScript (`import`) | `"type": "module"`，不能直接执行 TS |
| 渲染进程 `desktop/src/` | TypeScript (Vite 编译) | `tsconfig.json` 只 include `desktop/src/**` |

**解决方案**：

1. `shared/` 目录下所有文件写 **纯 ESM JavaScript**（`.js`），服务端和渲染进程都能直接 import
2. 渲染进程如需类型，在 `desktop/src/react/errors/types.ts` 中写类型声明（re-export + type augmentation），Vite 编译
3. 主进程 `main.cjs` 使用 `.cjs` 版本的包装器（`desktop/ipc-wrapper.cjs`），通过 `await import()` 动态导入 `shared/` 的 ESM 模块，或内联一份轻量 AppError 实现（只需 wrap + toJSON）
4. `tsconfig.json` 不需要改——TS 类型声明放在 `desktop/src/` 内部

## 参考架构

| 来源 | 采纳的模式 |
|------|-----------|
| VS Code | 类型化错误子类 + `onUnexpectedError` 全局漏斗 + `INotificationService` 结构化通知 |
| Sentry | 面包屑环形缓冲 + fingerprint 去重 + 事件处理管道 |
| Electron 社区 | IPC result envelope（`{ ok, data/error }`）跨进程保真传递错误 |
| React `react-error-boundary` | 区域 boundary + `resetKeys` 自动恢复 + `onError` 回调 |
| Fastify 官方 | `setErrorHandler` 全局中间件 + `@fastify/error` 结构化错误码 |
| AWS Architecture Blog | decorrelated jitter 重试策略（基于前次延迟的随机退避） |

---

## 一、AppError 体系

### 1.1 错误严重度

```typescript
type ErrorSeverity = 'critical' | 'degraded' | 'cosmetic';
```

- **critical**：应用无法继续正常运行（进程崩溃、数据损坏、渲染崩溃）
- **degraded**：功能不可用但应用整体可用（LLM 超时、WebSocket 断连、文件未找到）
- **cosmetic**：体验受损但功能正常（头像加载失败、i18n 缺失、慢响应提示）

### 1.2 错误分类

```typescript
type ErrorCategory = 'network' | 'llm' | 'filesystem' | 'ipc' | 'render' | 'bridge' | 'config' | 'auth' | 'unknown';
```

### 1.3 错误定义注册表

`ERROR_DEFS` 是单一事实来源，每个错误码对应 severity、category、i18n key、是否可重试、HTTP 状态码：

```typescript
interface ErrorDef {
  severity: ErrorSeverity;
  category: ErrorCategory;
  i18nKey: string;
  retryable: boolean;
  httpStatus?: number;
}

const ERROR_DEFS: Record<string, ErrorDef> = {
  // LLM
  LLM_TIMEOUT:         { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmTimeout',        retryable: true,  httpStatus: 504 },
  LLM_RATE_LIMITED:    { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmRateLimited',    retryable: true,  httpStatus: 429 },
  LLM_EMPTY_RESPONSE:  { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmEmptyResponse',  retryable: true,  httpStatus: 502 },
  LLM_AUTH_FAILED:     { severity: 'degraded', category: 'llm',        i18nKey: 'error.llmAuthFailed',     retryable: false, httpStatus: 401 },
  LLM_SLOW_RESPONSE:   { severity: 'cosmetic', category: 'llm',        i18nKey: 'error.llmSlowResponse',   retryable: false },

  // Filesystem
  FS_PERMISSION:       { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsPermission',      retryable: false, httpStatus: 500 },
  FS_NOT_FOUND:        { severity: 'degraded', category: 'filesystem', i18nKey: 'error.fsNotFound',        retryable: false, httpStatus: 404 },
  FS_COPY_FAILED:      { severity: 'critical', category: 'filesystem', i18nKey: 'error.fsCopyFailed',      retryable: true,  httpStatus: 500 },

  // Network
  WS_DISCONNECTED:     { severity: 'degraded', category: 'network',    i18nKey: 'error.wsDisconnected',    retryable: true },
  FETCH_TIMEOUT:       { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchTimeout',      retryable: true,  httpStatus: 504 },
  FETCH_SERVER_ERROR:  { severity: 'degraded', category: 'network',    i18nKey: 'error.fetchServerError',  retryable: true,  httpStatus: 502 },

  // IPC / Render / Config / Bridge
  IPC_FAILED:          { severity: 'degraded', category: 'ipc',        i18nKey: 'error.ipcFailed',         retryable: false },
  RENDER_CRASH:        { severity: 'critical', category: 'render',     i18nKey: 'error.renderCrash',       retryable: false },
  CONFIG_PARSE:        { severity: 'critical', category: 'config',     i18nKey: 'error.configParse',       retryable: false, httpStatus: 500 },
  BRIDGE_SEND_FAILED:  { severity: 'degraded', category: 'bridge',     i18nKey: 'error.bridgeSendFailed',  retryable: true,  httpStatus: 502 },

  // Skills / Memory / DB / Auth
  SKILL_SYNC_FAILED:       { severity: 'degraded', category: 'filesystem', i18nKey: 'error.skillSyncFailed',      retryable: true,  httpStatus: 500 },
  MEMORY_COMPILE_FAILED:   { severity: 'degraded', category: 'unknown',    i18nKey: 'error.memoryCompileFailed',  retryable: true },
  DB_ERROR:                { severity: 'critical', category: 'filesystem', i18nKey: 'error.dbError',              retryable: false, httpStatus: 500 },
  SERVER_AUTH_FAILED:      { severity: 'degraded', category: 'auth',       i18nKey: 'error.serverAuthFailed',     retryable: false, httpStatus: 403 },

  // Fallback
  UNKNOWN:             { severity: 'degraded', category: 'unknown',    i18nKey: 'error.unknown',           retryable: false, httpStatus: 500 },
};
```

新增错误码只需在此表加一行，所有下游（ErrorBus 路由、toast 显示、日志格式）自动适配。

### 1.4 AppError 类

```typescript
class AppError extends Error {
  readonly code: string;
  readonly severity: ErrorSeverity;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly httpStatus: number;
  readonly context: Record<string, unknown>;
  readonly traceId: string;       // 跨进程关联 ID
  readonly cause?: Error;

  constructor(code: string, opts?: {
    cause?: Error;
    context?: Record<string, unknown>;
    message?: string;
    traceId?: string;             // 不传则自动生成短 ID
  });

  toJSON(): { code: string; message: string; context: Record<string, unknown>; traceId: string };
  static fromJSON(data: { code: string; message?: string; context?: Record<string, unknown>; traceId?: string }): AppError;
  static wrap(err: unknown, fallbackCode?: string): AppError;
}
```

关键方法：
- `toJSON()` / `fromJSON()`：跨 IPC / WebSocket 序列化保真传递，包含 `traceId`
- `wrap()`：兜底层用，把裸 Error 包装成 AppError，确保后续流程总能拿到结构化信息
- `traceId`：短随机 ID（如 8 位 hex），构造时自动生成。当错误跨进程传递时（HTTP response / WebSocket error / IPC envelope），接收方的 `fromJSON` 保留原始 traceId，使得服务端日志和前端日志可通过 traceId 关联

---

## 二、ErrorBus — 中心化路由

### 2.1 职责

- 接收所有错误上报
- 维护面包屑环形缓冲（错误前的上下文轨迹）
- 按 fingerprint 去重（同一错误码 + 同一 context 在窗口期内不重复路由）
- 根据 severity 自动路由到正确的反馈通道
- 始终写结构化日志

### 2.2 接口

```typescript
interface Breadcrumb {
  type: 'action' | 'navigation' | 'network' | 'ipc' | 'llm' | 'filesystem' | 'lifecycle';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

interface ErrorEntry {
  error: AppError;
  timestamp: number;
  breadcrumbs: Breadcrumb[];
}

type ErrorRoute = 'toast' | 'statusbar' | 'boundary' | 'silent';

class ErrorBus {
  addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'>): void;
  report(error: unknown, extra?: { context?: Record<string, unknown>; route?: ErrorRoute }): void;
  subscribe(listener: (entry: ErrorEntry, route: ErrorRoute) => void): () => void;
}
```

### 2.3 路由规则

| severity | 默认路由 | 说明 |
|----------|---------|------|
| critical | `boundary` | 区域 ErrorBoundary fallback |
| degraded | `toast` | 弹 toast 提示 |
| cosmetic | `toast` | 轻提示 |
| WS_DISCONNECTED | `statusbar` | 常驻状态栏（特殊覆盖） |

路由可被调用者手动 override（`extra.route`），但默认靠 severity 自动决定。

### 2.4 去重

默认 fingerprint = `code`（仅错误码），窗口期 5 秒。同一 fingerprint 在窗口期内只路由一次。

调用者可通过 `extra.dedupeKey` 传入自定义 fingerprint（如 `code + sessionPath`），用于需要按上下文区分的场景。默认只用 `code` 是因为 `context` 中可能包含时间戳等非确定性字段，会导致去重失效。

### 2.5 面包屑

环形缓冲 50 条。各模块在关键操作时调用 `errorBus.addBreadcrumb()`：
- 路由切换、session 切换 → `navigation`
- fetch / WebSocket 发送 → `network`
- IPC 调用 → `ipc`
- 用户操作（发送消息、切换 agent）→ `action`
- LLM 调用开始/结束 → `llm`
- 文件读写操作 → `filesystem`
- 应用/窗口生命周期事件 → `lifecycle`

错误上报时，当前面包屑快照附加到 `ErrorEntry`，供 debug 时还原现场。

### 2.6 实例化

全局单例 `errorBus`，在应用启动时创建。后端（server 进程）和前端（renderer 进程）各一个实例。主进程（main.cjs）也一个实例。三个实例独立运行，通过各自的日志持久化。

跨进程关联通过 `AppError.traceId` 实现：服务端错误携带 traceId 通过 HTTP / WebSocket / IPC 传递到前端，前端 ErrorBus 日志中记录同一 traceId，debug 时可跨进程检索。

---

## 三、四层防线

### 3.1 第一层：封装好的工具函数

AI 编码时最常用的操作提供安全封装，内部自动 try-catch + 上报 ErrorBus。

#### safe-fs

```javascript
safeReadJSON(filePath, fallback = null)     // JSON.parse + readFileSync，失败返回 fallback + 上报
safeReadYAML(filePath, fallback = null)     // YAML.load + readFileSync，同上
safeReadFile(filePath, fallback = '')       // readFileSync，失败返回 fallback + 上报
safeCopyDir(src, dst)                       // 原子复制：先复制到 tmp，成功后 rename，失败清理 tmp
```

`safeCopyDir` 关键改进（原子复制 + 完整故障恢复）：

1. 递归复制 `src` → `dst.tmp_{ts}`
2. 若 `dst` 已存在，`rename(dst, dst.bak_{ts})`
3. `rename(dst.tmp_{ts}, dst)`
4. 删除 `dst.bak_{ts}`
5. **故障恢复**：若步骤 3 失败，`rename(dst.bak_{ts}, dst)` 回滚 + 清理 `dst.tmp_{ts}`

Windows 注意：`rename` 在目标已存在时会失败（不像 POSIX 原子替换），所以步骤 2 必须先移走旧目录。目录有打开的文件句柄时 rename 也会失败，配合 `withRetry` 短延迟重试 2-3 次。

#### safe-parse

```javascript
safeParseJSON(text, fallback = null)        // JSON.parse 包装，失败返回 fallback + 上报
safeParseResponse(response, fallback = null) // res.json() 包装，检查 res.ok + parse
```

#### LLM 慢响应检测

在 `llm-client.js` 的 `callText` 中加入 15 秒慢响应 timer：
- 超过 15 秒未收到响应 → `errorBus.report(LLM_SLOW_RESPONSE)`
- 前端 toast："模型响应较慢，请耐心等待"
- 收到响应后 clearTimeout

### 3.2 第二层：中间件 / 包装器自动捕获

#### Fastify 全局错误中间件

```javascript
app.setErrorHandler((error, request, reply) => {
  const appErr = AppError.wrap(error);
  errorBus.report(appErr, { context: { method: request.method, url: request.url } });
  reply.status(appErr.httpStatus).send({
    error: { code: appErr.code, message: appErr.message }
  });
});
```

所有路由里忘了 catch 的错误，都会被这里兜住，返回标准格式。

#### IPC handler 包装器

```typescript
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function wrapIpcHandler(channel, handler): void;
```

- 替代所有 `ipcMain.handle` 调用
- 内部自动 try-catch + AppError.wrap + ErrorBus 上报
- 返回 `IpcResult` envelope（`{ ok: true, data }` 或 `{ ok: false, error: { code, message, traceId } }`），不丢失错误码
- **文件格式**：`desktop/ipc-wrapper.cjs`（CommonJS），因为 `main.cjs` 是 CJS 环境。内部通过 `await import('../shared/errors.js')` 动态加载 ESM 的 AppError

渲染侧解包器（TypeScript，在 `desktop/src/react/errors/invoke-ipc.ts`）：
```typescript
async function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T>;
// ok=true → 返回 data；ok=false → throw AppError.fromJSON(error)
```

#### WebSocket 消息处理器包装

```javascript
function wrapWsHandler(ws, handler): (raw) => Promise<void>;
```

- 替代 `ws.on("message")` 中的直接处理
- 内部自动 parse + try-catch + ErrorBus 上报
- 失败时向客户端发送 `{ type: 'error', error: { code, message } }`

### 3.3 第三层：区域 ErrorBoundary

替代现有单一全局 ErrorBoundary，拆为区域级：

```typescript
interface RegionalErrorBoundaryProps {
  region: string;           // 'sidebar' | 'chat' | 'desk' | 'input' | 'settings'
  resetKeys?: unknown[];    // 值变化时自动重置（session 切换 / agent 切换）
  children: React.ReactNode;
}
```

布局中的使用：
```tsx
<RegionalErrorBoundary region="sidebar" resetKeys={[currentAgentId]}>
  <Sidebar />
</RegionalErrorBoundary>
<RegionalErrorBoundary region="chat" resetKeys={[currentSessionPath]}>
  <ChatArea />
</RegionalErrorBoundary>
<RegionalErrorBoundary region="desk" resetKeys={[deskCurrentPath]}>
  <DeskPanel />
</RegionalErrorBoundary>
<RegionalErrorBoundary region="input" resetKeys={[currentSessionPath]}>
  <InputArea />
</RegionalErrorBoundary>
```

Fallback UI：
- 浅灰色底，居中文字：`t('error.regionUnavailable', { region })`
- 下方小字按钮："重试"
- 不用红色、不用感叹号、不用 emoji
- `componentDidCatch` 中调用 `errorBus.report(RENDER_CRASH)`

`resetKeys` 行为：当数组中任意值变化时，ErrorBoundary 自动 reset，清除 stale 错误状态。用户切 session 不需要手动 dismiss 错误。

### 3.4 第四层：全局兜底

**主进程** (`main.cjs`)：
```javascript
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  errorBus.report(AppError.wrap(err), { route: 'silent' });
});
process.on('unhandledRejection', (reason) => {
  errorBus.report(AppError.wrap(reason), { route: 'silent' });
});
```

**渲染进程** (`App.tsx`)：
```javascript
window.addEventListener('error', (event) => {
  errorBus.report(AppError.wrap(event.error), {
    context: { filename: event.filename, line: event.lineno }
  });
});
window.addEventListener('unhandledrejection', (event) => {
  errorBus.report(AppError.wrap(event.reason));
});
```

这两层保留现有的过滤逻辑（EPIPE 等），但改为走 ErrorBus 而非直接 console.error，确保日志结构化。

---

## 四、前端反馈三通道

### 4.1 Toast（增强版）

在现有 toast-slice 基础上扩展：

```typescript
interface Toast {
  id: number;
  text: string;
  type: 'success' | 'error' | 'info' | 'warning';
  errorCode?: string;
  persistent?: boolean;       // critical 错误不自动消失
  action?: {
    label: string;            // i18n key，如 'action.retry'
    onClick: () => void;
  };
  dedupeKey?: string;
}
```

增强点：
- `persistent`：critical 级别的 toast 不自动消失，需要用户手动 dismiss。**上限 3 条**，超出时折叠为 "还有 N 个错误" 摘要
- `action`：可选操作按钮（重试、查看详情等）
- `dedupeKey`：与 ErrorBus 的去重联动
- `warning` 类型：用于 `cosmetic` 级别的提示（如慢响应），视觉上比 `error` 柔和（浅黄色调而非红色）

**合并设置页 Toast**：消除 `settings/Toast.tsx` 的独立实现。设置窗口是独立 BrowserWindow，拥有自己的 ErrorBus 实例和 ToastContainer，使用相同的 toast-slice 模式但独立运行。不通过 IPC 中转主窗口。

### 4.2 状态栏

常驻在聊天区底部的一行小字，显示持续性状态：

```typescript
// connection-slice.ts 扩展
interface ConnectionSlice {
  // ...现有字段
  wsState: 'connected' | 'reconnecting' | 'disconnected';
  wsReconnectAttempt: number;
}
```

UI 规则：
- WebSocket 正常 → 不显示任何东西
- `reconnecting` → 显示 "正在重连..."（`t('status.reconnecting')`），灰色小字
- `disconnected`（超出重连上限）→ 显示 "连接已断开"（`t('status.disconnected')`），带手动重连按钮
- 重连成功 → 短暂显示 "已重新连接" 后淡出

样式：13px 灰色文字，左对齐，无图标无背景色。和现有 `setStatus()` 机制融合。

### 4.3 区域 Fallback

由 RegionalErrorBoundary 渲染（见 3.3），样式写在 `RegionalErrorBoundary.module.css` 中（不用内联样式）：

- 浅灰色底（`var(--bg-secondary)`），居中布局
- 一行文字 + 一个按钮，字号 13px
- 不破坏周围布局的尺寸

---

## 五、withRetry 工具函数

### 5.1 接口

```typescript
interface RetryOpts {
  maxAttempts?: number;        // 默认 3
  baseDelayMs?: number;        // 默认 1000
  maxDelayMs?: number;         // 默认 30000
  signal?: AbortSignal;        // 支持取消
  shouldRetry?: (err: AppError) => boolean;  // 默认检查 err.retryable
}

function withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T>;
```

### 5.2 退避策略

采用 **decorrelated jitter**（AWS 推荐，实测流量分散效果最好）：

```
delay = min(maxDelay, random(baseDelay, previousDelay * 3))
```

### 5.3 使用场景

| 场景 | maxAttempts | baseDelayMs | maxDelayMs | 说明 |
|------|-------------|-------------|------------|------|
| LLM 调用 | 2 | 2000 | 15000 | 超时/5xx/429 重试，用户可通过 abort signal 取消 |
| 文件复制（Windows） | 3 | 500 | 3000 | 文件锁是暂态的，短延迟重试 |
| Web search | 2 | 1000 | 5000 | 搜索 API 偶发失败 |
| 前端 fetch | 不重试 | - | - | 本地通信，失败说明服务器问题，重试无意义 |

---

## 六、WebSocket 重连增强

### 6.1 现状

指数退避 1s → 2s → 4s → ... → 30s，无上限，`onerror` 为空。

### 6.2 改进

- 重连上限：20 次。超限后停止重连，`wsState` 设为 `disconnected`
- `onerror`：上报 `WS_DISCONNECTED` 到 ErrorBus
- `wsState` 暴露到 connection-slice，状态栏组件订阅渲染
- 重连成功：重置计数器，`wsState` 设为 `connected`
- 手动重连：超限后状态栏显示"重新连接"按钮，点击重置计数器并重新开始连接

---

## 七、具体修复清单

### 第一层修复（工具函数替换）

| 文件 | 问题 | 修复 |
|------|------|------|
| `main.cjs` ~6 处 | 裸 `JSON.parse(readFileSync(...))` | → `safeReadJSON()` |
| `core/first-run.js` `copyDirSync` | 无错误处理，不原子 | → `safeCopyDir()` |
| `core/provider-registry.js` | 裸 readFileSync + YAML.load | → `safeReadYAML()` |
| `core/bridge-session-manager.js:92` | 裸 JSON.parse | → `safeReadJSON()` |
| `core/sync-favorites.js` | 裸 YAML.load + readFileSync | → `safeReadYAML()` |
| `core/agent.js` ~5 处 | 静默返回空字符串 | → `safeReadFile()` |
| `lib/tools/web-search.js` 3 处 | `res.json()` 无 try-catch | → `safeParseResponse()` |
| `server/cli.js:55` | 裸 JSON.parse | → `safeParseJSON()` |
| `server/routes/fs.js:41,56` | 裸 readFileSync | → `safeReadFile()` |
| `core/agent-manager.js` 部分 | 未保护的 readFileSync | → `safeReadJSON()` / `safeReadYAML()` |

### 第二层修复（中间件/包装器）

| 文件 | 问题 | 修复 |
|------|------|------|
| `server/index.js` | 无全局 errorHandler | → `app.setErrorHandler()` |
| `main.cjs` 46 个 IPC handler | 各自 try-catch 不一致 | → `wrapIpcHandler` 统一包装 |
| `server/routes/chat.js` | ws handler 部分无 catch | → `wrapWsHandler` |
| `websocket.ts` onerror | 完全为空 | → 上报 ErrorBus + 更新 wsState |

### 第三层修复（区域 ErrorBoundary）

| 文件 | 问题 | 修复 |
|------|------|------|
| `App.tsx` | 单一全局 ErrorBoundary | → 4 个区域 boundary（sidebar / chat / desk / input） |
| `ErrorBoundary.tsx` | 无 i18n、无 region、内联样式 | → 新 `RegionalErrorBoundary` + CSS Module |

### 第四层修复（全局兜底）

| 文件 | 问题 | 修复 |
|------|------|------|
| `main.cjs` uncaughtException | 日志不结构化 | → 接入 ErrorBus |
| `App.tsx` window error handlers | 只发 POST /api/log | → 同时接入 ErrorBus |

### 其他修复

| 文件 | 问题 | 修复 |
|------|------|------|
| `core/llm-client.js` | 无慢响应检测 | → 15s timer + `LLM_SLOW_RESPONSE` |
| `websocket.ts` | 无重连上限 | → 20 次上限 + `wsState` 状态管理 |
| `settings/Toast.tsx` | 独立 Toast 实现 | → 合并到主 ToastContainer |
| `lib/memory/compile.js:121,133` | 文件读取失败返回空字符串 | → `safeReadFile()` + 上报 |
| `lib/bridge/bridge-manager.js:463` | 只 console.error | → 上报 ErrorBus |
| `server/routes/skills.js:181` | copyDirSync 无 try-catch | → `safeCopyDir()` |

---

## 八、文件结构

```
shared/                          # 纯 ESM JavaScript，三个进程都能用
  errors.js                      # AppError + ERROR_DEFS + ErrorSeverity/ErrorCategory
  error-bus.js                   # ErrorBus 类 + 面包屑 + 去重 + 路由
  retry.js                       # withRetry + decorrelated jitter
  safe-fs.js                     # safeReadJSON, safeReadYAML, safeCopyDir, safeReadFile
  safe-parse.js                  # safeParseJSON, safeParseResponse

server/
  middleware/
    error-handler.js             # Fastify setErrorHandler

desktop/
  ipc-wrapper.cjs                # wrapIpcHandler（CJS，供 main.cjs 使用）
  src/react/
    errors/
      types.ts                   # TypeScript 类型声明（re-export shared/ 的类型）
      invoke-ipc.ts              # 渲染侧 IPC 解包器
    components/
      RegionalErrorBoundary.tsx  # 区域 ErrorBoundary
      RegionalErrorBoundary.module.css
      ToastContainer.tsx         # 增强版 Toast
    stores/
      toast-slice.ts             # 增强 Toast 类型
      connection-slice.ts        # wsState / wsReconnectAttempt
```

---

## 九、明确排除

1. **不做 Circuit Breaker**：单用户桌面应用，`withRetry` + 超时已足够
2. **不做错误遥测上报**：隐私优先，所有日志留本地
3. **不做错误详情面板**：debug 交给 AI 看结构化日志
4. **不做 Result<T, E> 类型**：项目大量 JS 文件，`AppError.wrap()` 在兜底层实现同样效果
5. **不给 i18n 里每个现有 error key 都迁移到 ErrorDef**：现有的 `t('error.xxx')` 在路由/tool 层仍然有效，ErrorDef 管的是**基础设施层**的错误码，两套并存

---

## 十、实施依赖链

实施必须按以下顺序，每一步依赖前一步的产出：

```
Phase 1: 基础设施（无外部依赖）
  shared/errors.js         ← AppError + ERROR_DEFS
  shared/error-bus.js      ← ErrorBus（依赖 AppError）
  shared/retry.js          ← withRetry（独立）
  shared/safe-fs.js        ← 安全文件操作（依赖 AppError + ErrorBus）
  shared/safe-parse.js     ← 安全解析（依赖 AppError + ErrorBus）

Phase 2: 中间件/包装器（依赖 Phase 1）
  server/middleware/error-handler.js    ← Fastify 全局错误中间件
  desktop/ipc-wrapper.cjs              ← IPC handler 包装器
  desktop/src/react/errors/invoke-ipc.ts ← 渲染侧 IPC 解包器
  desktop/src/react/errors/types.ts    ← TypeScript 类型声明

Phase 3: 前端 UI（依赖 Phase 1 + Phase 2）
  stores/toast-slice.ts 增强
  stores/connection-slice.ts 增强
  components/RegionalErrorBoundary.tsx
  components/ToastContainer.tsx 增强
  services/websocket.ts 改造

Phase 4: 逐文件修复（依赖 Phase 1）
  各处 safeReadJSON / safeCopyDir / safeParseResponse 替换
  各处 wrapIpcHandler / wrapWsHandler 替换
  App.tsx ErrorBoundary 拆分 + 全局 handler 接入 ErrorBus
  llm-client.js 慢响应检测
```

Phase 1 和 Phase 2 之间是严格依赖。Phase 3 和 Phase 4 可以并行（分别处理 UI 层和逻辑层）。

## 十一、i18n 注意事项

所有新增的用户可见文本都需要在 `en.json` 和 `zh.json`（或对应的 locale 文件）中添加对应 key。`ERROR_DEFS` 中的 `i18nKey` 值（如 `error.llmTimeout`）必须在两个 locale 文件中都有条目。

开发者级别的日志消息（`console.error`、ErrorBus 内部日志）保持英文，不走 i18n。

## 十二、成功标准

1. 无论 AI 写出什么代码，错误都至少被四层中的某一层捕获并记录
2. 用户永远不会看到 "一直在转圈" — 超时、慢响应、断连都有明确反馈
3. Windows 首次启动 skills 同步失败不再弹裸错误窗口，而是 toast 提示 + 日志记录
4. 同一错误不会在 5 秒内弹两次 toast
5. 任何面板崩溃不影响其他面板，切 session 自动恢复
6. debug 时只需要看 ErrorBus 日志 → 错误码定位模块 → context + breadcrumbs 还原现场
