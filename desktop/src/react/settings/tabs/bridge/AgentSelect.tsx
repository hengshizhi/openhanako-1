import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore, type Agent } from '../../store';
import { hanaFetch, hanaUrl, yuanFallbackAvatar } from '../../api';
import { t } from '../../helpers';
import { SelectWidget, type SelectOption } from '../../widgets/SelectWidget';
import styles from '../../Settings.module.css';

interface AgentSelectProps {
  value: string | null;
  onChange: (agentId: string) => void;
}

export function AgentSelect({ value, onChange }: AgentSelectProps) {
  const agents = useSettingsStore((s) => s.agents);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});

  // Fetch ishiki summaries for all agents
  useEffect(() => {
    if (!agents.length) return;
    const descs: Record<string, string> = {};
    Promise.all(
      agents.map((a) =>
        hanaFetch(`/api/agents/${a.id}/public-ishiki`)
          .then((r) => r.json())
          .then((data) => { descs[a.id] = (data.content || '').split('\n')[0].slice(0, 80); })
          .catch(() => { descs[a.id] = ''; })
      )
    ).then(() => setDescriptions({ ...descs }));
  }, [agents]);

  const options: SelectOption[] = agents.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  // Stable cache-buster — only changes on mount, not every render
  const tsRef = useRef(Date.now());
  const ts = tsRef.current;

  const renderTrigger = (option: SelectOption | undefined, _isOpen: boolean) => {
    const agent = agents.find((a) => a.id === option?.value);
    return (
      <>
        <img
          className={styles['bridge-agent-avatar']}
          src={agent?.hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`) : yuanFallbackAvatar(agent?.yuan || 'hanako')}
          onError={(e) => { (e.target as HTMLImageElement).src = yuanFallbackAvatar(agent?.yuan || 'hanako'); }}
        />
        <div className={styles['bridge-agent-info']}>
          <div className={styles['bridge-agent-name']}>{agent?.name || '—'}</div>
          <div className={styles['bridge-agent-desc']}>{descriptions[agent?.id || ''] || ''}</div>
        </div>
        <span className={styles['sdw-arrow']}>▾</span>
      </>
    );
  };

  const renderOption = (option: SelectOption, isSelected: boolean) => {
    const agent = agents.find((a) => a.id === option.value);
    return (
      <div className={`${styles['bridge-agent-option']}${isSelected ? ' ' + styles['selected'] : ''}`}>
        <img
          className={styles['bridge-agent-avatar']}
          src={agent?.hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`) : yuanFallbackAvatar(agent?.yuan || 'hanako')}
          onError={(e) => { (e.target as HTMLImageElement).src = yuanFallbackAvatar(agent?.yuan || 'hanako'); }}
        />
        <div className={styles['bridge-agent-info']}>
          <div className={styles['bridge-agent-name']}>{option.label}</div>
          <div className={styles['bridge-agent-desc']}>{descriptions[option.value] || ''}</div>
        </div>
        {isSelected && (
          <svg className={styles['bridge-agent-check']} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    );
  };

  return (
    <div className={styles['bridge-agent-select']}>
      <SelectWidget
        options={options}
        value={value || ''}
        onChange={onChange}
        placeholder="Select Agent"
        renderTrigger={renderTrigger}
        renderOption={renderOption}
      />
    </div>
  );
}
