import type { AgentSettings } from '../../shared/model';

export type AgentKind = 'codex' | 'hermes' | 'pi';
export type RosterKind = AgentKind | 'local';

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
