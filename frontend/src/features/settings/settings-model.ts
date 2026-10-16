import type { AgentSettings } from '../../shared/model';
import { api } from '../../shared/api.ts';

export type AgentKind = 'codex' | 'command';
export type RosterKind = AgentKind | 'local';
type SettingsField = keyof AgentSettings;

const rosterFields: Record<RosterKind, SettingsField[]> = {
  local: ['local_profiles'],
  codex: ['codex_bin', 'codex_args', 'codex_env'],
  command: ['command_configs'],
};

export const settingsFields = (kind: RosterKind, scope: 'roster' | 'dialog' | 'toggle' = 'roster'): SettingsField[] => {
  if (scope === 'toggle') return kind === 'local' ? [] : [`${kind}_enabled` as SettingsField];
  return rosterFields[kind];
};

export const mergeSettingsFields = (base: AgentSettings, source: AgentSettings, fields: SettingsField[]): AgentSettings => ({
  ...base,
  ...Object.fromEntries(fields.map(key => [key, source[key]])),
});

export async function saveAgentSettings(draft: AgentSettings, fields: SettingsField[], active: () => boolean) {
  if (!active()) throw new Error('设置页面已关闭');
  return normalizeAgentSettings(await api<AgentSettings>('/settings', {
    method: 'PUT', body: JSON.stringify({ ...draft, _fields: fields }),
  }));
}

export const normalizeAgentSettings = (settings: AgentSettings): AgentSettings => ({
  ...settings,
  local_enabled: true,
  local_profiles: settings.local_profiles?.length ? settings.local_profiles : ['~/.bashrc'],
  codex_args: settings.codex_args || [],
  codex_env: settings.codex_env || [],
  command_configs: settings.command_configs || [],
});

export const agentEnabled = (settings: AgentSettings, kind: AgentKind) => settings[`${kind}_enabled`];

export const withAgentEnabled = (settings: AgentSettings, kind: RosterKind, enabled: boolean): AgentSettings => kind === 'local' ? settings : {
  ...settings,
  [`${kind}_enabled`]: enabled,
};

export const parseExpandedRoster = (raw: string | null): RosterKind[] => {
  try {
    const values = JSON.parse(raw || '[]');
    return Array.isArray(values) ? values.filter((value): value is RosterKind => value === 'local' || value === 'codex' || value === 'command') : [];
  } catch { return []; }
};

export const dirtySettingsKinds = (draft: AgentSettings | null, baseline: AgentSettings | null): RosterKind[] => !draft || !baseline ? [] : (['local', 'codex', 'command'] as RosterKind[]).filter(kind => settingsFields(kind).some(key => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])));
