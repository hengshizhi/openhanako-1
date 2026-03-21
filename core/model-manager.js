/**
 * ModelManager — 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * v2 新增：ProviderRegistry / ModelCatalog / AuthStore / ExecutionRouter
 * 四个新模块通过 init() 后挂载到实例，旧接口保持向后兼容。
 */
import path from "path";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { registerOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";
import { clearConfigCache, loadGlobalProviders } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ModelCatalog } from "./model-catalog.js";
import { AuthStore } from "./auth-store.js";
import { ExecutionRouter } from "./execution-router.js";

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

export class ModelManager {
  /**
   * @param {object} opts
   * @param {string} opts.hanakoHome - 用户数据根目录
   */
  constructor({ hanakoHome }) {
    this._hanakoHome = hanakoHome;
    this._authStorage = null;
    this._modelRegistry = null;
    this._defaultModel = null;   // 设置页面选的，持久化，bridge 用这个
    this._sessionModel = null;   // 聊天页面临时切的，只影响桌面端
    this._availableModels = [];

    // v2：新架构四层模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(hanakoHome);
    this.modelCatalog = null;   // 依赖 modelsJsonPath，init() 后创建
    this.authStore = null;
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._hanakoHome, "auth.json"));
    registerOAuthProvider(minimaxOAuthProvider);
    this._modelRegistry = new ModelRegistry(
      this._authStorage,
      path.join(this._hanakoHome, "models.json"),
    );

    // v2 模块初始化
    this.providerRegistry.reload();
    this.modelCatalog = new ModelCatalog(this.providerRegistry, this.modelsJsonPath);
    this.authStore = new AuthStore(this._hanakoHome, this.providerRegistry);
    this.authStore.load();
    this.executionRouter = new ExecutionRouter(this.modelCatalog, this.authStore);
  }

  // ── Getters ──

  get authStorage() { return this._authStorage; }
  get modelRegistry() { return this._modelRegistry; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._sessionModel || this._defaultModel; }
  set currentModel(m) { this._sessionModel = m; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._hanakoHome, "models.json"); }
  get authJsonPath() { return path.join(this._hanakoHome, "auth.json"); }

  /** 注入 PreferencesManager 引用（engine init 时调用） */
  setPreferences(prefs) { this._prefs = prefs; }

  /** 刷新可用模型列表 */
  async refreshAvailable() {
    this._availableModels = await this._modelRegistry.getAvailable();
    this._injectOAuthCustomModels();
    // v2：同步刷新 ModelCatalog + builtinModels 回灌
    if (this.modelCatalog) {
      await this.modelCatalog.build();
      const oauthCustom = this._prefs?.getOAuthCustomModels?.() || {};
      this.modelCatalog.injectOAuthCustomModels(oauthCustom);
      this.authStore?.load();
      // 将 Catalog 中有但 _availableModels 没有的 builtinModels 回灌
      // 让 UI、REST API、Bridge、Agent 切换都能看到
      this._mergeBuiltinModels();
    }
    return this._availableModels;
  }

  /**
   * 将用户为 OAuth provider 添加的自定义模型注入到 availableModels
   * 从同 provider 的已有模型克隆 baseUrl / api / cost 等属性
   */
  _injectOAuthCustomModels() {
    const custom = this._prefs?.getOAuthCustomModels?.() || {};
    for (const [provider, modelIds] of Object.entries(custom)) {
      if (!Array.isArray(modelIds) || modelIds.length === 0) continue;
      // 找同 provider 的模板模型（继承 baseUrl、api、cost 等）
      let template = this._availableModels.find(m => m.provider === provider);
      if (!template) {
        // 无已有模型时从 providers.yaml 构建最小模板
        const gp = loadGlobalProviders().providers?.[provider];
        if (!gp?.base_url || !gp?.api) continue;
        template = {
          provider,
          baseUrl: gp.base_url,
          api: gp.api,
          input: ["text", "image"],
          contextWindow: 128_000,
        };
      }
      const existing = new Set(this._availableModels.filter(m => m.provider === provider).map(m => m.id));
      for (const id of modelIds) {
        if (existing.has(id)) continue;
        this._availableModels.push({
          ...template,
          id,
          name: id,
        });
      }
    }
  }

  /**
   * 将 ModelCatalog 中有但 _availableModels 中没有的模型回灌
   * 主要来源：ProviderRegistry 的 builtinModels 声明
   * @private
   */
  _mergeBuiltinModels() {
    if (!this.modelCatalog) return;
    const existingIds = new Set(this._availableModels.map(m => m.id));
    for (const entry of this.modelCatalog.list()) {
      if (existingIds.has(entry.modelId)) continue;
      this._availableModels.push(this.modelCatalog.toSdkEntry(entry));
      existingIds.add(entry.modelId);
    }
  }

  /**
   * 同步 favorites → models.json，然后刷新 ModelRegistry
   * @param {string} configPath - agent config.yaml 路径
   * @param {object} opts
   * @returns {boolean}
   */
  async syncModelsAndRefresh(configPath, { favorites, sharedModels, authJsonPath }) {
    const { syncFavoritesToModelsJson } = await import("./sync-favorites.js");
    const synced = syncFavoritesToModelsJson(configPath, {
      modelsJsonPath: this.modelsJsonPath,
      favorites,
      sharedModels,
      authJsonPath: authJsonPath || this.authJsonPath,
    });
    if (synced) {
      clearConfigCache();
      this._modelRegistry.refresh();
      // refresh() 内部调 resetOAuthProviders()，需要重新注册
      registerOAuthProvider(minimaxOAuthProvider);
      this._availableModels = await this._modelRegistry.getAvailable();
      this._injectOAuthCustomModels();
      // v2：同步刷新 ModelCatalog + AuthStore
      if (this.modelCatalog) {
        await this.modelCatalog.refresh();
        const oauthCustom = this._prefs?.getOAuthCustomModels?.() || {};
        this.modelCatalog.injectOAuthCustomModels(oauthCustom);
        this.authStore?.invalidate();
        this.authStore?.load();
      }
    }
    return synced;
  }

  /**
   * 切换当前模型（只改状态，不推到 session）
   * @returns {object} 新模型对象
   */
  setModel(modelId) {
    const model = this._availableModels.find(m => m.id === modelId);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._sessionModel = model;
    return model;
  }

  /** auto → medium，其余原样 */
  resolveThinkingLevel(level) {
    return level === "auto" ? "medium" : level;
  }

  /**
   * 将模型引用（id/name/object）解析成 SDK 可用的模型对象
   * 委托 ModelCatalog，fallback 到 _availableModels
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef; // 对象直通（session-coordinator 路径）
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;

    // 新路径：通过 ModelCatalog 解析（支持 "provider/model" 格式）
    if (this.modelCatalog) {
      const entry = this.modelCatalog.resolve(ref);
      if (entry) return this.modelCatalog.toSdkEntry(entry);
    }

    // fallback：从 _availableModels 查找（覆盖 Catalog 未索引到的情况）
    const model = this._availableModels.find(m => m.id === ref || m.name === ref);
    if (!model) throw new Error(t("error.modelNotFound", { id: ref }));
    return model;
  }

  /** 根据模型 ID 推断其所属 provider */
  inferModelProvider(modelId) {
    if (!modelId) return null;
    // 新路径：ModelCatalog
    if (this.modelCatalog) {
      const entry = this.modelCatalog.resolve(modelId);
      if (entry) return entry.providerId;
    }
    return this._availableModels.find(m => m.id === modelId)?.provider || null;
  }

  /**
   * 根据 provider 名称查找凭证
   * 委托 AuthStore，返回 snake_case 格式（兼容 callProviderText 消费方）
   * @param {string} provider
   * @param {object} [agentConfig]
   * @returns {{ api_key: string, base_url: string, api: string }}
   */
  resolveProviderCredentials(provider, agentConfig) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    if (this.authStore) {
      const cred = this.authStore.get(provider, agentConfig);
      if (cred) {
        return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
      }
    }
    return { api_key: "", base_url: "", api: "" };
  }

  /**
   * 统一解析：模型引用 → { model, provider, api, api_key, base_url }
   * 返回 snake_case 格式（兼容 callProviderText / diary-writer / compile 等消费方）
   * @param {string|object} modelRef
   * @param {object} [agentConfig]
   * @returns {{ model: string, provider: string, api: string, api_key: string, base_url: string }}
   */
  resolveModelWithCredentials(modelRef, agentConfig) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider, agentConfig);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    if (!creds.base_url || (!creds.api_key && !isLocalBaseUrl(creds.base_url))) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: entry.id,
      provider,
      api: creds.api,
      api_key: creds.api_key,
      base_url: creds.base_url,
    };
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * 委托 ExecutionRouter
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApi) {
    return this.executionRouter.resolveUtilityConfig(agentConfig, sharedModels, utilApi);
  }
}
