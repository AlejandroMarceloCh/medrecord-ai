import React from 'react';

const MR_ICON_PATHS = {
  mic: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
  stop: 'M7.5 7.5h9v9h-9z',
  pause: 'M9 6.5v11M15 6.5v11',
  play: 'M8 5.5l11 6.5-11 6.5z',
  check: 'M5 12.5 10 17.5 19 6.5',
  checkCircle: 'M21 12a9 9 0 1 1-3.2-6.9M8.5 12l2.5 2.5L17 8',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  arrowR: 'M5 12h14M13 6l6 6-6 6',
  refresh: 'M20 11a8 8 0 1 0-.8 4.5M20 6v5h-5',
  warn: 'M12 4 21 19H3L12 4ZM12 10v4M12 17.5v.2',
  trash: 'M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13',
  x: 'M6 6l12 12M18 6 6 18',
};

export function Icon({ name, size = 20, stroke = 2, fill = 'none', style }) {
  const d = MR_ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

export function Btn({ children, onClick, disabled, full, style, icon, variant = 'primary' }) {
  const paleta = variant === 'ghost'
    ? { background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border-2)' }
    : { background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid transparent' };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="mr-btn"
      style={{ height: 52, fontSize: 16, padding: '0 22px', gap: 9, width: full ? '100%' : undefined,
        ...paleta, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer', ...style }}>
      {icon && <Icon name={icon} size={19} />}{children}
    </button>
  );
}

export function Spinner({ size = 16, color = 'currentColor' }) {
  return <span className="mr-spin" style={{ width: size, height: size, border: '2px solid ' + color,
    borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />;
}

export function SectionLabel({ children }) {
  return <div style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: '0.07em', textTransform: 'uppercase',
    color: 'var(--faint)', marginBottom: 10 }}>{children}</div>;
}

// Diálogo destructivo: dice exactamente QUÉ se elimina y que no hay vuelta atrás.
export function ConfirmDestructivo({ titulo, detalle, textoBoton, onConfirmar, onCancelar }) {
  return (
    <div role="dialog" aria-modal="true"
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(12,14,18,0.55)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16,
        paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}>
      <div className="mr-card mr-fade" style={{ width: '100%', maxWidth: 420, padding: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 720, marginBottom: 6, color: 'var(--text)' }}>{titulo}</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>{detalle}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Btn variant="ghost" full onClick={onCancelar} style={{ height: 48 }}>Cancelar</Btn>
          <Btn full onClick={onConfirmar} style={{ height: 48, background: 'var(--danger)', color: '#fff' }}>
            {textoBoton}
          </Btn>
        </div>
      </div>
    </div>
  );
}
