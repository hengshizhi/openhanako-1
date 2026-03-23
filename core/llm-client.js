/**
 * core/llm-client.js — 统一的非流式 LLM 调用入口
 *
 * 替代原先手写 HTTP 的 callProviderText()，所有调用走 Pi SDK completeSimple()。
 * 确保 URL 构造、header、协议适配和 Chat 链路完全一致，消灭分裂。
 */

import { completeSimple } from "@mariozechner/pi-ai";

/**
 * 统一非流式文本生成。
 *
 * @param {object} opts
 * @param {string} opts.api            API 协议 ("openai-completions" | "anthropic-messages" | ...)
 * @param {string} opts.apiKey         API key（本地模型可省略）
 * @param {string} opts.baseUrl        Provider base URL
 * @param {string} opts.model          模型 ID
 * @param {string} [opts.provider]     Provider ID（可选，用于 SDK 自动检测 compat）
 * @param {string} [opts.systemPrompt] System prompt
 * @param {Array}  [opts.messages]     消息数组 [{ role, content }]
 * @param {number} [opts.temperature]  温度 (default 0.3)
 * @param {number} [opts.maxTokens]    最大输出 token (default 512)
 * @param {number} [opts.timeoutMs]    超时毫秒 (default 60000)
 * @param {AbortSignal} [opts.signal]  外部取消信号
 * @returns {Promise<string>} 生成的文本
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  provider = "custom",
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  maxTokens = 512,
  timeoutMs = 60_000,
  signal,
}) {
  // ── 1. 消息归一化：提取 system 消息合并到 systemPrompt ──
  // Pi SDK Context.messages 只接受 user / assistant / toolResult，
  // system 必须走 context.systemPrompt。
  let mergedSystemPrompt = systemPrompt || "";
  const filteredMessages = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || "").join("")
          : "";
      if (text) {
        mergedSystemPrompt += (mergedSystemPrompt ? "\n" : "") + text;
      }
    } else {
      filteredMessages.push({
        ...m,
        timestamp: m.timestamp || Date.now(),
      });
    }
  }

  // ── 2. 本地 URL 无 key 处理 ──
  // Pi SDK 在 apiKey 为空时会直接抛 "No API key for provider"。
  // 本地模型（Ollama 等）不需要认证，注入 dummy key 绕过校验。
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(baseUrl || "");
  const effectiveApiKey = apiKey || (isLocal ? "ollama" : undefined);

  // ── 3. 构造最小 SDK Model 对象 ──
  const sdkModel = {
    id: model,
    name: model,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens,
  };

  // ── 4. 超时信号 ──
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  // ── 5. 调用 Pi SDK completeSimple ──
  const result = await completeSimple(sdkModel, {
    systemPrompt: mergedSystemPrompt || undefined,
    messages: filteredMessages,
  }, {
    temperature,
    maxTokens,
    signal: combinedSignal,
    apiKey: effectiveApiKey,
  });

  // ── 6. 提取文本（跳过 thinking 块）──
  const text = result.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");

  if (!text.trim()) {
    throw new Error(`LLM returned empty response (model=${model}, stopReason=${result.stopReason})`);
  }

  return text;
}
