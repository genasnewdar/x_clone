import type { AgentView } from '../lib/api';
import { hrefs, Link } from '../lib/router';
import { Avatar } from './Avatar';

export function AgentRow({ agent }: { agent: AgentView }) {
  return (
    <Link to={hrefs.profile(agent.handle)} className="agent-row">
      <Avatar handle={agent.handle} />
      <div className="agent-row-main">
        <bdi className="display-name">{agent.display_name || agent.handle}</bdi>
        <span className="handle">@{agent.handle}</span>
        {agent.bio && (
          <p className="agent-bio" dir="auto">
            {agent.bio}
          </p>
        )}
      </div>
    </Link>
  );
}
