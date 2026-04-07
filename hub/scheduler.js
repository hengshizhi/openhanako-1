/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：只跑当前 active agent（有书桌才有心跳）
 * Cron：所有 agent 独立并发，不随 active agent 切换而中断
 *
 * Agent 切换时只 reload heartbeat，cron 持续跑。
 *
 * 通知策略：agent 自行决定是否调用 notify 工具，scheduler 不做通知判断。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.js";
import { createCronScheduler } from "../lib/desk/cron-scheduler.js";
import { CronStore } from "../lib/desk/cron-store.js";
import { getLocale } from "../server/i18n.js";

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeat = null;
    this._agentCrons = new Map(); // agentId → CronScheduler
    this._executingJobs = new Map(); // jobId → AbortController（per-job 锁 + abort 控制）
    this._heartbeatSessions = new Map(); // agentId → { sessionPath, date }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  /** 暴露 heartbeat（给 desk route 的 triggerNow 用） */
  get heartbeat() { return this._heartbeat; }

  /** 暴露某个 agent 的 cronScheduler */
  getCronScheduler(agentId) {
    return this._agentCrons.get(agentId ?? this._engine.currentAgentId) ?? null;
  }

  /** @deprecated 兼容旧访问 */
  get cronScheduler() { return this.getCronScheduler(); }

  // ──────────── Heartbeat State ────────────

  /** 读取 heartbeat-state.json（容错） */
  _loadHeartbeatState(agentId) {
    const cached = this._heartbeatSessions.get(agentId);
    if (cached) return cached;
    try {
      const agent = this._engine.getAgent(agentId);
      if (!agent) return null;
      const statePath = path.join(agent.deskDir, "heartbeat-state.json");
      const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (raw?.sessionPath && raw?.date) {
        this._heartbeatSessions.set(agentId, raw);
        return raw;
      }
    } catch {}
    return null;
  }

  /** 写入 heartbeat-state.json（原子写入） */
  _saveHeartbeatState(agentId, state) {
    this._heartbeatSessions.set(agentId, state);
    try {
      const agent = this._engine.getAgent(agentId);
      if (!agent) return;
      const statePath = path.join(agent.deskDir, "heartbeat-state.json");
      const tmpPath = statePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      console.warn(`[scheduler] saveHeartbeatState 失败: ${err.message}`);
    }
  }

  /** 清除某个 agent 的心跳 session 缓存 */
  _clearHeartbeatState(agentId) {
    this._heartbeatSessions.delete(agentId);
    try {
      const agent = this._engine.getAgent(agentId);
      if (!agent) return;
      const statePath = path.join(agent.deskDir, "heartbeat-state.json");
      try { fs.unlinkSync(statePath); } catch {}
    } catch {}
  }

  // ──────────── 生命周期 ────────────

  start() {
    this.startHeartbeat();
    this._startAllCrons();
  }

  async stop() {
    await this.stopHeartbeat();
    for (const sched of this._agentCrons.values()) {
      await sched.stop();
    }
    this._agentCrons.clear();
  }

  /** 启动某个 agent 的 cron（幂等，已有则跳过） */
  startAgentCron(agentId) { this._startAgentCron(agentId); }

  /** 停止并移除某个 agent 的 cron */
  async removeAgentCron(agentId) {
    const sched = this._agentCrons.get(agentId);
    if (sched) {
      await sched.stop();
      this._agentCrons.delete(agentId);
    }
  }

  /** Agent 切换：只重建 heartbeat，cron 不中断 */
  async reloadHeartbeat() {
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    const engine = this._engine;
    const agent = engine.agent;
    if (!agent.deskManager || !agent.cronStore) return;

    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const hbEnabled = agent.config?.desk?.heartbeat_enabled !== false;
    this._heartbeat = createHeartbeat({
      getDeskFiles: () => engine.listDeskFiles(),
      getWorkspacePath: () => engine.homeCwd,
      getAgentName: () => engine.agentName,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      onBeat: (prompt) => this._executeActivity(prompt, "heartbeat", null, { withMemory: true }),
      onJianBeat: (prompt, cwd) => {
        const isZh = getLocale().startsWith("zh");
        this._executeActivity(prompt, "heartbeat", `${isZh ? "笺" : "jian"}:${path.basename(cwd)}`, { cwd, withMemory: true });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    // 注册 promote 回调：升格活跃心跳 session 时清除缓存
    engine.setOnPromoteHeartbeat((oldPath, promotedAgentId) => {
      const cached = this._heartbeatSessions.get(promotedAgentId);
      if (cached && cached.sessionPath === oldPath) {
        this._clearHeartbeatState(promotedAgentId);
        engine.emitDevLog("[heartbeat] 活跃 session 被升格，下轮将新建", "heartbeat");
      }
    });

    if (hbEnabled) this._heartbeat.start();
  }

  async stopHeartbeat() {
    if (this._heartbeat) {
      await this._heartbeat.stop();
      this._heartbeat = null;
      this._engine.setOnPromoteHeartbeat(null);
    }
  }

  // ──────────── Per-agent Cron ────────────

  _startAllCrons() {
    const engine = this._engine;
    let entries;
    try {
      entries = fs.readdirSync(engine.agentsDir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (e.isDirectory()) this._startAgentCron(e.name);
    }
  }

  _startAgentCron(agentId) {
    if (this._agentCrons.has(agentId)) return;
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const deskDir = path.join(agentDir, "desk");

    let cronStore;
    try {
      cronStore = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
      );
    } catch { return; }

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJobForAgent(agentId, job),
      abortJob: (jobId) => {
        const ac = this._executingJobs.get(jobId);
        if (ac) { ac.abort(); console.log(`\x1b[90m[scheduler] cron abort ${jobId} (timeout)\x1b[0m`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          { type: "cron_job_done", jobId: job.id, label: job.label, agentId, result },
          null,
        );
      },
    });
    this._agentCrons.set(agentId, sched);
    sched.start();
    console.log(`\x1b[90m[scheduler] cron 已启动: ${agentId}\x1b[0m`);
  }

  // ──────────── 执行 ────────────

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId, job) {
    // per-job 锁：同一 job 不并发，但同一 agent 的不同 job 可以并行
    if (this._executingJobs.has(job.id)) {
      console.log(`\x1b[90m[scheduler] cron 跳过 ${job.id}：上一次仍在执行\x1b[0m`);
      const err = new Error(`cron job ${job.id} 仍在执行，跳过`);
      err.skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(job.id, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
            "**不要在执行过程中创建新的定时任务。**",
            "",
            job.prompt,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            "",
            job.prompt,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        model: job.model || undefined,
        signal: ac.signal,
      });
    } finally {
      this._executingJobs.delete(job.id);
    }
  }

  /**
   * 心跳专用执行：复用当天持久 session，单条 ActivityStore entry
   */
  async _executeHeartbeatForAgent(agentId, prompt, label, opts = {}) {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const today = new Date().toISOString().slice(0, 10);
    const dailyId = `hb_daily_${today}`;

    // ── 日轮换检测 ──
    const cached = this._loadHeartbeatState(agentId);
    let resumeSessionPath = null;
    if (cached && cached.date === today && fs.existsSync(cached.sessionPath)) {
      resumeSessionPath = cached.sessionPath;
    }

    const startedAt = Date.now();

    // ── 执行 ──
    const { signal, ...restOpts } = opts;
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      resumeSessionPath,
      signal,
      ...restOpts,
    });
    const { sessionPath, replyText, error } = result;
    const finishedAt = Date.now();
    const failed = !!error;

    // ── 记住 session 路径 ──
    if (sessionPath && !failed) {
      this._saveHeartbeatState(agentId, { sessionPath, date: today });
    }

    // ── 摘要（用当轮 prompt + replyText，不读文件） ──
    let summary = null;
    if (!failed && replyText) {
      try {
        summary = await engine.summarizeActivity(null, {
          userText: prompt.slice(0, 600),
          assistantText: replyText.slice(0, 600),
        });
      } catch {}
    }

    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;
    const isZh = getLocale().startsWith("zh");
    const hbLabel = isZh ? "日常巡检" : "routine patrol";
    const failSuffix = isZh ? "执行失败" : "execution failed";

    // ── ActivityStore：首轮 add，后续 update ──
    const store = engine.getActivityStore(agentId);
    const existing = store.get(dailyId);

    if (existing) {
      // 后续轮次：update
      const updated = store.update(dailyId, {
        finishedAt,
        summary: failed
          ? `${hbLabel} ${failSuffix}`
          : (summary || existing.summary || hbLabel),
        status: failed ? "error" : "done",
        error: error || null,
      });
      this._hub.eventBus.emit({ type: "activity_update", activity: updated }, null);
    } else {
      // 首轮：add
      const entry = {
        id: dailyId,
        type: "heartbeat",
        label: label || null,
        agentId,
        agentName,
        startedAt,
        finishedAt,
        summary: failed ? `${hbLabel} ${failSuffix}` : (summary || hbLabel),
        sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
        status: failed ? "error" : "done",
        error: error || null,
      };
      store.add(entry);
      this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);
    }

    if (failed) {
      const reason = error || (isZh ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[heartbeat] ${label || "巡检"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${summary || hbLabel}`, "heartbeat");
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts = {}) {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId + signal 参数）
    const { signal, ...restOpts } = opts;
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      signal,
      ...restOpts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // 生成摘要
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath);
      } catch {}
    }

    const entry = {
      id,
      type,
      label: label || null,
      agentId,
      agentName,
      startedAt,
      finishedAt,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        return summary || (type === "heartbeat" ? hbLabel : (label || cronLabel));
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

  /**
   * active agent 的心跳活动（保留向后兼容）
   */
  _executeActivity(prompt, type, label, opts = {}) {
    const agentId = this._engine.currentAgentId;
    if (type === "heartbeat" && !label) {
      return this._executeHeartbeatForAgent(agentId, prompt, label, opts);
    }
    return this._executeActivityForAgent(agentId, prompt, type, label, opts);
  }
}
