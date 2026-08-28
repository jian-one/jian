import type { CSSProperties } from 'react';

type AgentIconProps = { kind?: 'local' | 'codex' | 'hermes' | 'pi'; className?: string };

const iconURLs = { local: '/bash.svg', codex: '/openai.svg', hermes: '/hermesagent.svg', pi: '/pi.svg' } as const;

export function AgentIcon({ kind = 'local', className = '' }: AgentIconProps) {
  const style = { WebkitMaskImage: `url(${iconURLs[kind]})`, maskImage: `url(${iconURLs[kind]})` } as CSSProperties;
  return <span className={`agent-icon agent-icon-${kind} ${className}`.trim()} style={style} aria-hidden="true" />;
}
