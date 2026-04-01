/**
 * DeferredResultStore — 异步后台任务结果通知存储
 *
 * 工具调用触发异步任务时通过 defer() 注册占位，任务完成后调用
 * resolve() 或 fail()，通知所有订阅方并向 EventBus 广播事件。
 * 支持按 session 批量清理，适用于 session 终止时清除孤立任务。
 */

export class DeferredResultStore {
  constructor(bus) {
    this._bus = bus || null;
    /** @type {Map<string, { status: string, sessionPath: string, meta: object, deferredAt: number, result: any, reason: any }>} */
    this._tasks = new Map();
    this._resultCbs = [];
    this._failCbs = [];
  }

  /**
   * 注册一个 pending 异步任务
   *
   * @param {string} taskId - 任务唯一标识
   * @param {string} sessionPath - 所属 session 路径
   * @param {object} [meta] - 附加元数据（传给订阅方和前端渲染）
   */
  defer(taskId, sessionPath, meta = {}) {
    if (this._tasks.has(taskId)) return;
    this._tasks.set(taskId, {
      status: "pending",
      sessionPath,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
    });
  }

  /**
   * 将任务标记为成功，通知所有订阅方并广播 EventBus 事件
   *
   * @param {string} taskId
   * @param {*} result
   */
  resolve(taskId, result) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "resolved";
    task.result = result;

    for (const cb of this._resultCbs) {
      try { cb(taskId, task.sessionPath, result, task.meta); } catch {}
    }

    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "success",
      result,
      meta: task.meta,
    }, task.sessionPath);
  }

  /**
   * 将任务标记为失败，通知所有订阅方并广播 EventBus 事件
   *
   * @param {string} taskId
   * @param {*} reason - 失败原因（字符串或 Error）
   */
  fail(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "failed";
    task.reason = reason;

    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, reason, task.meta); } catch {}
    }

    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "failed",
      reason,
      meta: task.meta,
    }, task.sessionPath);
  }

  /**
   * 查询任务当前状态快照，未知 taskId 返回 null
   *
   * @param {string} taskId
   * @returns {{ status, sessionPath, meta, deferredAt, result, reason } | null}
   */
  query(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    return { ...task };
  }

  /**
   * 列出指定 session 下所有 pending 任务的摘要
   *
   * @param {string} sessionPath
   * @returns {{ taskId: string, meta: object, deferredAt: number }[]}
   */
  listPending(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath && task.status === "pending") {
        result.push({ taskId, meta: task.meta, deferredAt: task.deferredAt });
      }
    }
    return result;
  }

  /**
   * 订阅任务成功事件，返回取消订阅函数
   *
   * @param {(taskId, sessionPath, result, meta) => void} callback
   * @returns {() => void}
   */
  onResult(callback) {
    this._resultCbs.push(callback);
    return () => {
      const idx = this._resultCbs.indexOf(callback);
      if (idx !== -1) this._resultCbs.splice(idx, 1);
    };
  }

  /**
   * 订阅任务失败事件，返回取消订阅函数
   *
   * @param {(taskId, sessionPath, reason, meta) => void} callback
   * @returns {() => void}
   */
  onFail(callback) {
    this._failCbs.push(callback);
    return () => {
      const idx = this._failCbs.indexOf(callback);
      if (idx !== -1) this._failCbs.splice(idx, 1);
    };
  }

  /**
   * session 终止时，删除该 session 下所有 pending 任务（不触发回调）
   *
   * @param {string} sessionPath
   */
  clearBySession(sessionPath) {
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath && task.status === "pending") {
        this._tasks.delete(taskId);
      }
    }
  }

  /** 任务总数（调试用） */
  get size() { return this._tasks.size; }
}
