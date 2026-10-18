// Inline stroke icons from the mockups: 1.8 px stroke, no icon fonts.

import type { ReactNode } from 'react';

function Svg({ size = 24, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

type P = { size?: number };

export const DashboardsIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <rect x="13" y="13" width="8" height="8" rx="2" />
  </Svg>
);

export const LogIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
    <path d="M9 8h6" />
    <path d="M9 12h6" />
  </Svg>
);

export const MaintenanceIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />
  </Svg>
);

export const AnchorIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M12 6v14" />
    <path d="M8 9h8" />
    <path d="M5 14a7 7 0 0 0 14 0" />
    <circle cx="12" cy="4.5" r="1.5" />
  </Svg>
);

export const ChecklistIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M9 6h11" />
    <path d="M9 12h11" />
    <path d="M9 18h11" />
    <path d="M4 6l1 1 2-2" />
    <path d="M4 12l1 1 2-2" />
    <path d="M4 18l1 1 2-2" />
  </Svg>
);

export const SettingsIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Svg>
);

export const MoreIcon = ({ size }: P) => (
  <Svg size={size}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </Svg>
);

export const MoonIcon = ({ size = 22 }: P) => (
  <Svg size={size}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);

export const SunIcon = ({ size = 22 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const PassagesIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 17c3-1 4-6 8-6s5 4 10 3" />
    <circle cx="4" cy="17" r="1.5" />
    <circle cx="20" cy="14" r="1.5" />
  </Svg>
);

export const PartsIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
    <path d="M4 7l8 4 8-4" />
    <path d="M12 11v10" />
  </Svg>
);

export const BackIcon = ({ size = 22 }: P) => (
  <Svg size={size}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);
