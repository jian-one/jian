import type { AgentSettings, SettingsResponse } from '../../shared/model';
import { api } from '../../shared/api.ts';

export type AgentKind = 'codex' | 'hermes' | 'pi';
export type RosterKind = AgentKind | 'local';

type SettingsField = keyof AgentSettings;
const rosterFields: Record<RosterKind, SettingsField[]> = {
  local: ['local_profiles'],
  codex: ['codex_bin', 'codex_args', 'codex_env'],
  hermes: ['hermes_home', 'hermes_bin', 'hermes_profiles', 'hermes_args', 'hermes_env'],
  pi: ['pi_default', 'pi_roles', 'pi_args', 'pi_env'],
};

export const settingsFields = (kind: RosterKind, scope: 'roster' | 'dialog' | 'toggle' = 'roster'): SettingsField[] => {
  if (scope === 'toggle') return kind === 'local' ? [] : [`${kind}_enabled`];
  return scope === 'dialog' && kind !== 'local' ? [`${kind}_args`, `${kind}_env`] : rosterFields[kind];
};

export const mergeSettingsFields = (base: AgentSettings, source: AgentSettings, fields: SettingsField[]): AgentSettings => ({
  ...base,
  ...Object.fromEntries(fields.map(key => [key, source[key]])),
});

export async function saveAgentSettings(draft: AgentSettings, fields: SettingsField[], active: () => boolean) {
  const { settings } = await api<SettingsResponse>('/settings');
  if (!active()) throw new Error('设置页面已关闭');
  return normalizeAgentSettings(await api<AgentSettings>('/settings', {
    method: 'PUT', body: JSON.stringify(mergeSettingsFields(normalizeAgentSettings(settings), draft, fields)),
  }));
}

export const normalizeAgentSettings = (settings: AgentSettings): AgentSettings => ({
	...settings,
	local_enabled: true,
  local_profiles: settings.local_profiles?.length ? settings.local_profiles : ['~/.bashrc'],
  codex_args: settings.codex_args || [],
  hermes_args: settings.hermes_args || [],
  codex_env: settings.codex_env || [],
  hermes_env: settings.hermes_env || [],
  pi_args: settings.pi_args || [],
  pi_env: settings.pi_env || [],
  pi_default: settings.pi_default || '',
  pi_roles: settings.pi_roles || [],
  hermes_profiles: settings.hermes_profiles || [],
});

export const agentEnabled = (settings: AgentSettings, kind: AgentKind) => settings[`${kind}_enabled` as 'codex_enabled' | 'hermes_enabled' | 'pi_enabled'] !== false;

export const withAgentEnabled = (settings: AgentSettings, kind: RosterKind, enabled: boolean): AgentSettings => kind === 'local' ? settings : {
  ...settings,
  [`${kind}_enabled`]: enabled,
};

export const parseExpandedRoster = (raw: string | null): RosterKind[] => {
  try {
    const values = JSON.parse(raw || '[]');
    return Array.isArray(values) ? values.filter((value): value is RosterKind => value === 'local' || value === 'codex' || value === 'hermes' || value === 'pi') : [];
  } catch { return []; }
};

export const dirtySettingsKinds = (draft: AgentSettings | null, baseline: AgentSettings | null): RosterKind[] => !draft || !baseline ? [] : (['local', 'codex', 'hermes', 'pi'] as RosterKind[]).filter(kind => settingsFields(kind).some(key => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])));
