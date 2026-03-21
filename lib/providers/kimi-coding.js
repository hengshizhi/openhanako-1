/**
 * Kimi Coding Plan provider plugin
 *
 * 月之暗面 Coding Plan 订阅，走 Anthropic 兼容协议。
 * 与 moonshot (OpenAI 兼容) 是同一厂商的不同接入方式。
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const kimiCodingPlugin = {
  id: "kimi-coding",
  displayName: "Kimi Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.moonshot.cn/anthropic",
  defaultApi: "anthropic-messages",
  builtinModels: [
    "kimi-k2",
  ],
  capabilities: {
    vision: false,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
