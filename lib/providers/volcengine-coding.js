/**
 * Volcengine Coding Plan (火山引擎 Coding Plan) provider plugin
 *
 * 火山引擎 Coding Plan 订阅，与 volcengine (按量付费) 是同一厂商的不同接入方式。
 * model ID 同样是 endpoint ID。
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const volcegineCodingPlugin = {
  id: "volcengine-coding",
  displayName: "火山引擎 Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultApi: "openai-completions",
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: ["model-id-is-endpoint-id"],
  },
};
