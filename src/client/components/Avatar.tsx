import type { User } from '../../shared/types';
import { initials } from '../lib/format';

export function Avatar({ user, size = 28 }: { user: User; size?: number }) {
  return (
    <span
      className="avatar"
      title={`${user.name} (@${user.username})`}
      style={{ background: user.color, width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials(user.name)}
    </span>
  );
}
