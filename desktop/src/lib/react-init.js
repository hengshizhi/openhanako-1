/**
 * React 迁移兼容层
 *
 * 必须在 app.js 之前加载。
 * 1. 设置 __REACT_MANAGED 标志，让 app.js 不自动调用 init()
 * 2. 确保 HanaModules 命名空间存在（icons.js / utils.js 会向其中注入）
 */

window.__REACT_MANAGED = true;
window.HanaModules = window.HanaModules || {};
