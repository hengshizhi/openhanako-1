/**
 * chat-slice.ts — Per-session 消息数据 + 滚动位置
 */

import type { ChatListItem, ChatMessage, SessionMessages, SessionModel } from './chat-types';

export interface ChatSlice {
  chatSessions: Record<string, SessionMessages>;
  scrollPositions: Record<string, number>;

  initSession: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  prependItems: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  appendItem: (path: string, item: ChatListItem) => void;
  updateLastMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  patchBlockByTaskId: (sessionPath: string, taskId: string, patch: Record<string, any>) => void;
  _pendingBlockPatches: Record<string, Record<string, any>>;

  updateSessionModel: (path: string, model: SessionModel) => void;
  setLoadingMore: (path: string, loading: boolean) => void;
  clearSession: (path: string) => void;
  saveScrollPosition: (path: string, scrollTop: number) => void;
}

const MAX_CACHED_SESSIONS = 8;

export const createChatSlice = (
  set: (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => void,
  get: () => ChatSlice,
): ChatSlice => ({
  chatSessions: {},
  scrollPositions: {},

  initSession: (path, items, hasMore) => set((s) => {
    const sessions = { ...s.chatSessions };
    sessions[path] = { items, hasMore, loadingMore: false, oldestId: items[0]?.type === 'message' ? items[0].data.id : undefined, model: sessions[path]?.model };
    // LRU 淘汰
    const keys = Object.keys(sessions);
    if (keys.length > MAX_CACHED_SESSIONS) {
      const oldest = keys.find(k => k !== path);
      if (oldest) delete sessions[oldest];
    }
    return { chatSessions: sessions };
  }),

  prependItems: (path, items, hasMore) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    const merged = [...items, ...session.items];
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: {
          ...session,
          items: merged,
          hasMore,
          loadingMore: false,
          oldestId: items[0]?.type === 'message' ? items[0].data.id : session.oldestId,
        },
      },
    };
  }),

  appendItem: (path, item) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items: [...session.items, item] },
      },
    };
  }),

  updateLastMessage: (path, updater) => set((s) => {
    const session = s.chatSessions[path];
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last.type !== 'message') return {};
    items[lastIdx] = { type: 'message', data: updater(last.data) };
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items },
      },
    };
  }),

  // 缓存：block_update 到达时 block 可能还没添加到 store（时序竞争）
  _pendingBlockPatches: {} as Record<string, Record<string, any>>,

  patchBlockByTaskId: (sessionPath, taskId, patch) => {
    const session = get().chatSessions[sessionPath];
    if (!session) {
      // session 还没初始化，缓存 patch
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
      return;
    }
    const items = [...session.items];
    let found = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'message' || item.data.role !== 'assistant') continue;
      const blocks = item.data.blocks;
      if (!blocks) continue;
      const blockIdx = blocks.findIndex((b: any) => b.type === 'subagent' && b.taskId === taskId);
      if (blockIdx === -1) continue;
      const newBlocks = [...blocks];
      newBlocks[blockIdx] = { ...newBlocks[blockIdx], ...patch };
      const newItems = [...items];
      newItems[i] = { ...item, data: { ...item.data, blocks: newBlocks } };
      set((s) => ({
        chatSessions: {
          ...s.chatSessions,
          [sessionPath]: { ...s.chatSessions[sessionPath], items: newItems },
        },
      }));
      found = true;
      break;
    }
    if (!found) {
      // block 还没被添加到 store，缓存 patch 等 content_block 到达后 apply
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
    }
  },

  updateSessionModel: (path, model) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return { chatSessions: { ...s.chatSessions, [path]: { ...session, model } } };
  }),

  setLoadingMore: (path, loading) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, loadingMore: loading },
      },
    };
  }),

  clearSession: (path) => set((s) => {
    const sessions = { ...s.chatSessions };
    delete sessions[path];
    return { chatSessions: sessions };
  }),

  saveScrollPosition: (path, scrollTop) => set((s) => ({
    scrollPositions: { ...s.scrollPositions, [path]: scrollTop },
  })),
});
