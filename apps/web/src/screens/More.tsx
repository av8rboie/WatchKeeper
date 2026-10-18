import { Link } from 'react-router-dom';
import { AnchorIcon, ChecklistIcon, PartsIcon, PassagesIcon, SettingsIcon } from '../shell/icons';

/** Phone-only menu for the screens without a tab. */
export function MoreScreen() {
  const items = [
    { to: '/anchor', label: 'Anchor watch', icon: AnchorIcon },
    { to: '/checklists', label: 'Checklists', icon: ChecklistIcon },
    { to: '/passages', label: 'Passages', icon: PassagesIcon },
    { to: '/maintenance/parts', label: 'Parts', icon: PartsIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
  return (
    <>
      <div className="screen-head">
        <h1 className="screen-title">More</h1>
      </div>
      <ul className="menu-list">
        {items.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link to={to}>
              <Icon size={22} />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
