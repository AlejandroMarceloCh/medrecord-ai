import React from 'react';

export const MR_ICON_PATHS = {
  home:        'M3 10.5 12 4l9 6.5M5 9.5V20h14V9.5M9.5 20v-5h5v5',
  mic:         'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
  check:       'M5 12.5 10 17.5 19 6.5',
  checkCircle: 'M21 12a9 9 0 1 1-3.2-6.9M8.5 12l2.5 2.5L17 8',
  chevR:       'M9 5l7 7-7 7',
  chevL:       'M15 5l-7 7 7 7',
  chevD:       'M5 9l7 7 7-7',
  plus:        'M12 5v14M5 12h14',
  x:           'M6 6l12 12M18 6 6 18',
  user:        'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20c0-3.3 3.1-6 7-6s7 2.7 7 6',
  clipboard:   'M9 4.5h6M8 4.5H6.5A1.5 1.5 0 0 0 5 6v13a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V6a1.5 1.5 0 0 0-1.5-1.5H16M9 3.5h6v2H9z',
  pill:        'M8 14.5 14.5 8a4.6 4.6 0 0 1 6.5 6.5L14.5 21a4.6 4.6 0 0 1-6.5-6.5ZM11 11l4 4',
  fileText:    'M13 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V9L13 3.5ZM13 3.5V9h5.5M8.5 13h7M8.5 16.5h5',
  download:    'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
  settings:    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  edit:        'M16.5 4.5l3 3M4 20l1-4L16 5l3 3L8 19l-4 1Z',
  sparkle:     'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z',
  warn:        'M12 4 21 19H3L12 4ZM12 10v4M12 17.5v.2',
  activity:    'M3 12h4l3 8 4-16 3 8h4',
  clock:       'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  arrowR:      'M5 12h14M13 6l6 6-6 6',
  refresh:     'M20 11a8 8 0 1 0-.8 4.5M20 6v5h-5',
  filter:      'M4 6h16l-6 7v6l-4-2v-4L4 6Z',
  trash:       'M5 7h14M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.7 12A1.5 1.5 0 0 0 8.7 20.5h6.6a1.5 1.5 0 0 0 1.5-1.4L17.5 7',
  copy:        'M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16M5.5 8h9A1.5 1.5 0 0 1 16 9.5v9A1.5 1.5 0 0 1 14.5 20h-9A1.5 1.5 0 0 1 4 18.5v-9A1.5 1.5 0 0 1 5.5 8Z',
  pulse:       'M22 12 18 12 15 21 9 3 6 12 2 12',
  search:      'M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0Z',
};

export function Icon({ name, size=20, stroke=2, fill='none', style, className }) {
  const d = MR_ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
      strokeLinejoin="round" style={{ flexShrink:0, ...style }} className={className}>
      {d.split('M').filter(Boolean).map((seg,i) => <path key={i} d={'M'+seg} />)}
    </svg>
  );
}
