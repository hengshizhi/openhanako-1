/**
 * SubagentCard — 子 Agent 实时执行状态卡片
 *
 * 订阅 streamKey 上的实时事件，互斥显示当前状态：
 * 思考 / 文字输出 / 工具调用 / 已完成 / 失败 / 已中断
 */

import { memo, useState, useEffect, useRef, useMemo } from 'react';
import { subscribeStreamKey } from '../../services/stream-key-dispatcher';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SubagentCardProps {
  block: {
    taskId: string;
    task: string;
    agentId?: string;
    agentName?: string;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed';
    summary?: string;
  };
}

export const SubagentCard = memo(function SubagentCard({ block }: SubagentCardProps) {
  const [status, setStatus] = useState(block.streamStatus);
  const [display, setDisplay] = useState<string>(() => {
    if (block.streamStatus === 'done') return block.summary || '已完成';
    if (block.streamStatus === 'failed') return block.summary || '失败';
    return '准备中...';
  });
  const textRef = useRef('');

  // 头像：优先用 agent 头像 API，fallback 到 yuan 剪影头像
  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const agentId = block.agentId || currentAgentId || '';
  const agentName = block.agentName || block.agentId || 'Subagent';

  const agent = agents?.find((a: any) => a.id === agentId);
  const fallbackAvatar = useMemo(() => {
    const types = (window.t?.('yuan.types') || {}) as Record<string, { avatar?: string }>;
    const yuan = agent?.yuan || 'hanako';
    const entry = types[yuan] || types['hanako'];
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }, [agent?.yuan]);
  const avatarSrc = (agent?.hasAvatar && agentId)
    ? hanaUrl(`/api/agents/${agentId}/avatar?t=${agentId}`)
    : fallbackAvatar;

  // Sync block prop changes (from block_update patch)
  useEffect(() => {
    setStatus(block.streamStatus);
    if (block.streamStatus === 'done') setDisplay(block.summary || '已完成');
    if (block.streamStatus === 'failed') setDisplay(block.summary || '失败');
  }, [block.streamStatus, block.summary]);

  // Subscribe to live events
  useEffect(() => {
    if (status !== 'running' || !block.streamKey) return;

    const unsub = subscribeStreamKey(block.streamKey, (event: any) => {
      if (event.type === 'text_delta') {
        textRef.current += event.delta || '';
        if (textRef.current.length > 100) textRef.current = textRef.current.slice(-100);
        setDisplay(textRef.current);
      } else if (event.type === 'thinking_start') {
        setDisplay('正在思考...');
      } else if (event.type === 'thinking_end') {
        if (textRef.current) setDisplay(textRef.current);
      } else if (event.type === 'tool_start') {
        setDisplay(`正在调用 ${event.name}...`);
      } else if (event.type === 'tool_end') {
        if (textRef.current) setDisplay(textRef.current);
        else setDisplay('执行中...');
      } else if (event.type === 'turn_end') {
        setStatus('done');
        setDisplay(textRef.current || '已完成');
      }
    });

    return unsub;
  }, [block.streamKey, status]);

  // "已中断" 仅在历史加载时判断：组件首次 mount 时如果 streamKey 为空且 status=running，
  // 等待一小段时间让 block_update 到达。如果一直没到才标记中断。
  const [waitedForKey, setWaitedForKey] = useState(false);
  useEffect(() => {
    if (block.streamKey || status !== 'running') return;
    const timer = setTimeout(() => setWaitedForKey(true), 3000);
    return () => clearTimeout(timer);
  }, [block.streamKey, status]);

  const isInterrupted = status === 'running' && !block.streamKey && waitedForKey;

  return (
    <div className={`${styles.subagentCard} ${styles[`subagent-${status}`]}`}>
      <img
        className={styles.subagentAvatar}
        src={avatarSrc}
        alt={agentName}
        draggable={false}
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          if (img.src.endsWith(fallbackAvatar)) {
            img.onerror = null;
            return;
          }
          img.onerror = null;
          img.src = fallbackAvatar;
        }}
      />
      <div className={styles.subagentBody}>
        <div className={styles.subagentName}>
          {agentName}
          <span className={styles.subagentStatus}>
            {isInterrupted ? '已中断' : status === 'done' ? '已完成' : status === 'failed' ? '失败' : '已派出'}
          </span>
        </div>
        <div className={styles.subagentDisplay}>
          {isInterrupted ? '' : display}
        </div>
      </div>
    </div>
  );
});
