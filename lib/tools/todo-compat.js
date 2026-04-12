/**
 * todo-compat.js — 旧格式 → 新格式转换的纯函数
 *
 * 无状态、无副作用。前端镜像：desktop/src/react/utils/todo-compat.ts，
 * 必须保持同步。
 *
 * 旧格式（Pi SDK example 移植版）：
 *   { action, todos: [{id, text, done}], nextId }
 *
 * 新格式（对标 Claude Code TodoWrite）：
 *   { todos: [{content, activeForm, status}], warning? }
 */

import { TODO_TOOL_NAMES } from "./todo-constants.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * 判断一个 todo item 是否是旧格式
 * 强特征：有 done 字段（boolean）
 */
function isLegacyTodoItem(item) {
  return item && typeof item === "object" && typeof item.done === "boolean";
}

/**
 * 判断一个 todo item 是否已经是合法的新格式
 */
function isNewTodoItem(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.content === "string" &&
    typeof item.activeForm === "string" &&
    VALID_STATUSES.has(item.status)
  );
}

/**
 * 把一个旧格式 todo item 转成新格式
 */
function migrateLegacyItem(old) {
  return {
    content: old.text ?? "",
    activeForm: old.text ?? "",  // decision 3: fallback 到 content
    status: old.done ? "completed" : "pending",
  };
}

/**
 * 强制回填成一个合法的新格式 item（最后一道防线）
 */
function sanitizeUnknownItem(item) {
  const anyItem = item || {};
  const content = typeof anyItem.content === "string" ? anyItem.content
    : typeof anyItem.text === "string" ? anyItem.text
    : "";
  const activeForm = typeof anyItem.activeForm === "string" ? anyItem.activeForm : content;
  const status = VALID_STATUSES.has(anyItem.status) ? anyItem.status : "pending";
  return { content, activeForm, status };
}

/**
 * 从 details 对象中提取并转换为新格式的 todos 数组
 *
 * @param {object|null|undefined} details  tool_result.details
 * @returns {Array<{content: string, activeForm: string, status: string}>}
 */
export function migrateLegacyTodos(details) {
  if (!details || typeof details !== "object") return [];
  const todos = details.todos;
  if (!Array.isArray(todos)) return [];
  return todos.map(item => {
    if (isLegacyTodoItem(item)) return migrateLegacyItem(item);
    if (isNewTodoItem(item)) return item;
    // 未知/损坏格式：强制回填成合法 item，避免消费端渲染空白行
    console.error("[todo-compat] corrupt todo item detected, sanitizing to pending:", item);
    return sanitizeUnknownItem(item);
  });
}

/**
 * 从一个消息数组中提取最新的 todo 状态（自动兼容新旧格式）
 *
 * @param {Array<object>} sourceMessages  session 消息数组
 * @returns {Array<object>|null}  最新 todos（新格式），没有则 null
 */
export function extractLatestTodos(sourceMessages) {
  if (!Array.isArray(sourceMessages)) return null;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (!m || m.role !== "toolResult") continue;
    if (!TODO_TOOL_NAMES.includes(m.toolName)) continue;
    const migrated = migrateLegacyTodos(m.details);
    return migrated;
  }
  return null;
}
