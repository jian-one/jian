import type { AgentSettings } from '../../shared/model';

export type AgentKind = 'codex' | 'hermes';
export type RosterKind = AgentKind | 'local';

export const normalizeAgentSettings = (settings: AgentSettings): AgentSettings => ({
	...settings,
	local_enabled: true,
  local_profiles: settings.local_profiles?.length ? settings.local_profiles : ['~/.bashrc'],
  codex_args: settings.codex_args || [],
  hermes_args: settings.hermes_args || [],
  codex_env: settings.codex_env || [],
  hermes_env: settings.hermes_env || [],
  hermes_profiles: settings.hermes_profiles || [],
});

export const agentEnabled = (settings: AgentSettings, kind: AgentKind) => kind === 'codex' ? settings.codex_enabled !== false : settings.hermes_enabled !== false;

export const withAgentEnabled = (settings: AgentSettings, kind: RosterKind, enabled: boolean): AgentSettings => kind === 'local' ? settings : {
  ...settings,
  [kind === 'codex' ? 'codex_enabled' : 'hermes_enabled']: enabled,
};

export const parseExpandedRoster = (raw: string | null): RosterKind[] => {
  try {
    const values = JSON.parse(raw || '[]');
    return Array.isArray(values) ? values.filter((value): value is RosterKind => value === 'local' || value === 'codex' || value === 'hermes') : [];
  } catch { return []; }
};
