import React from 'react';
import { Icon } from './icons.jsx';

export function Btn({ children, variant='primary', size='md', icon, iconR, onClick, disabled, style, full, type, title }) {
  const sz = size==='sm'?{h:34,fs:13,px:12,g:5}:size==='lg'?{h:48,fs:15.5,px:20,g:8}:{h:40,fs:14,px:14,g:7};
  const V = {
    primary: { background:'var(--accent)', color:'#fff', border:'1px solid transparent' },
    soft:    { background:'var(--accent-soft)', color:'var(--accent-strong)', border:'1px solid var(--accent-line)' },
    ghost:   { background:'transparent', color:'var(--text)', border:'1px solid var(--border-mid)' },
    quiet:   { background:'transparent', color:'var(--muted)', border:'1px solid transparent' },
    danger:  { background:'transparent', color:'var(--danger)', border:'1px solid var(--danger-border)' },
  };
  return (
    <button type={type||'button'} onClick={onClick} disabled={disabled} title={title}
      style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', gap:sz.g,
        height:sz.h, fontSize:sz.fs, padding:`0 ${sz.px}px`, fontFamily:'inherit',
        fontWeight:600, letterSpacing:'-0.01em', borderRadius:'var(--r-btn)',
        width:full?'100%':undefined, opacity:disabled?0.45:1,
        cursor:disabled?'not-allowed':'pointer', whiteSpace:'nowrap',
        transition:'filter 0.12s, transform 0.06s', userSelect:'none', ...V[variant], ...style }}
      onMouseEnter={e=>!disabled&&(e.currentTarget.style.filter='brightness(1.05)')}
      onMouseLeave={e=>(e.currentTarget.style.filter='')}
      onMouseDown={e=>!disabled&&(e.currentTarget.style.transform='scale(0.98)')  }
      onMouseUp={e=>(e.currentTarget.style.transform='')}>
      {icon && <Icon name={icon} size={sz.fs+2} stroke={2}/>}
      {children}
      {iconR && <Icon name={iconR} size={sz.fs+2} stroke={2}/>}
    </button>
  );
}

export function IconBtn({ name, onClick, active, disabled, size=36, ico=17, title, style }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      style={{ width:size, height:size, display:'inline-flex', alignItems:'center', justifyContent:'center',
        borderRadius:'var(--r-btn)', cursor:disabled?'default':'pointer', border:'none', padding:0,
        background:active?'var(--accent-soft)':'transparent',
        color:active?'var(--accent-strong)':'var(--muted)',
        opacity:disabled?0.35:1,
        transition:'background 0.12s, color 0.12s', flexShrink:0, ...style }}
      onMouseEnter={e=>!disabled&&(e.currentTarget.style.background=active?'var(--accent-soft)':'var(--surface-3)')}
      onMouseLeave={e=>!disabled&&(e.currentTarget.style.background=active?'var(--accent-soft)':'transparent')}>
      <Icon name={name} size={ico}/>
    </button>
  );
}

export function Avatar({ initials, size=34, color, style }) {
  const bg = color ? color+'22' : 'color-mix(in oklch, var(--accent) 16%, var(--surface))';
  const fg = color ? color       : 'color-mix(in oklch, var(--accent) 78%, var(--text))';
  return (
    <div style={{ width:size, height:size, borderRadius:size*0.28, flexShrink:0,
      background:bg, color:fg, border:`1.5px solid ${color ? color+'44' : 'color-mix(in oklch, var(--accent) 26%, transparent)'}`,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontWeight:720, fontSize:size*0.35, letterSpacing:'0.02em', ...style }}>
      {initials}
    </div>
  );
}

export function Chip({ children, tone='neutral', size='md' }) {
  const T = {
    neutral:{ bg:'var(--surface-3)', fg:'var(--muted)',  bd:'var(--border-mid)' },
    accent: { bg:'var(--accent-soft)', fg:'var(--accent-strong)', bd:'var(--accent-line)' },
    ok:     { bg:'var(--ok-bg)',  fg:'var(--ok)',  bd:'var(--ok-border)' },
    warn:   { bg:'var(--warn-bg)',fg:'var(--warn)',bd:'var(--warn-border)' },
    danger: { bg:'var(--danger-bg)',fg:'var(--danger)',bd:'var(--danger-border)' },
  }[tone];
  const sm = size==='sm';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5,
      background:T.bg, color:T.fg, border:`1px solid ${T.bd}`, borderRadius:999,
      padding:sm?'2px 8px':'3px 10px', fontSize:sm?11:12.5, fontWeight:550, lineHeight:1.4, whiteSpace:'nowrap' }}>
      {children}
    </span>
  );
}

export function Spinner({ size=16, color='var(--accent)' }) {
  return (
    <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%',
      border:`2px solid var(--border-mid)`, borderTopColor:color,
      animation:'mr-spin 0.8s linear infinite', flexShrink:0 }}/>
  );
}

// StatusChip con bg+border por estado — usado en la barra del workbench
const SC = {
  received:   { label:'Recibido',           c:'var(--faint)',         bg:'var(--surface-2)', b:'var(--border-mid)',  spin:true  },
  processing: { label:'Transcribiendo',     c:'var(--accent-strong)', bg:'var(--accent-soft)',b:'var(--accent-line)', spin:true  },
  filling:    { label:'Completando campos', c:'var(--accent-strong)', bg:'var(--accent-soft)',b:'var(--accent-line)', spin:true  },
  done:       { label:'Por revisar',        c:'var(--warn)',          bg:'var(--warn-bg)',   b:'var(--warn-border)', spin:false },
  reviewed:   { label:'Revisada',           c:'var(--ok)',            bg:'var(--ok-bg)',     b:'var(--ok-border)',   spin:false, check:true },
  error:      { label:'Error',              c:'var(--danger)',        bg:'var(--danger-bg)', b:'var(--danger-border)',spin:false },
};
export function StatusChip({ status }) {
  const cfg = SC[status]||SC.received;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px',
      background:cfg.bg, border:`1px solid ${cfg.b}`, borderRadius:6,
      color:cfg.c, fontSize:12, fontWeight:550, whiteSpace:'nowrap', flexShrink:0 }}>
      {cfg.spin
        ? <Spinner size={8} color={cfg.c}/>
        : <span style={{ width:6, height:6, borderRadius:'50%', background:cfg.c, flexShrink:0 }}/>}
      {cfg.label}
      {cfg.check && <Icon name="check" size={10} stroke={2.5}/>}
    </span>
  );
}

// WsChip — dot estático, texto breve
const WSC = {
  connected:   { label:'Conectado',   dot:'var(--ok)',       c:'var(--ok)',   bg:'var(--ok-bg)',    b:'var(--ok-border)'   },
  connecting:  { label:'Conectando',  dot:'var(--faint)',    c:'var(--muted)',bg:'var(--surface-2)',b:'var(--border-mid)'  },
  reconnecting:{ label:'Reconectando',dot:'var(--warn-dot)', c:'var(--warn)', bg:'var(--warn-bg)', b:'var(--warn-border)' },
  disconnected:{ label:'Sin señal',   dot:'var(--faint)',    c:'var(--faint)',bg:'var(--surface-2)',b:'var(--border-mid)'  },
};
export function WsChip({ status='connecting', onClick }) {
  const cfg = WSC[status]||WSC.disconnected;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag type={onClick?'button':undefined} onClick={onClick}
      title={onClick?'Actualizar':undefined}
      style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'5px 11px',
        background:cfg.bg, border:`1px solid ${cfg.b}`, borderRadius:8,
        color:cfg.c, fontSize:12, fontWeight:550, whiteSpace:'nowrap',
        cursor:onClick?'pointer':'default', fontFamily:'inherit',
        transition:'filter 0.12s' }}
      onMouseEnter={onClick?e=>e.currentTarget.style.filter='brightness(0.96)':undefined}
      onMouseLeave={onClick?e=>e.currentTarget.style.filter='':undefined}>
      <span style={{ width:6, height:6, borderRadius:'50%', background:cfg.dot, flexShrink:0 }}/>
      {cfg.label}
    </Tag>
  );
}

export function SkeletonBar({ w='100%', h=16, r=6, style }) {
  return <div style={{ width:w, height:h, borderRadius:r,
    background:'linear-gradient(90deg, var(--surface-3) 25%, var(--surface-2) 37%, var(--surface-3) 63%)',
    backgroundSize:'800px 100%', animation:'mr-shimmer 1.4s linear infinite', ...style }}/>;
}

// Calca el listing: barra de tabs + grid de tarjetas
export function SkeletonListing() {
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', height:'100%' }}>
      {/* tab bar */}
      <div style={{ height:52, background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)',
        padding:'0 28px', display:'flex', alignItems:'center', gap:24 }}>
        <SkeletonBar w={90} h={16} r={4}/><SkeletonBar w={80} h={16} r={4}/><SkeletonBar w={80} h={16} r={4}/>
        <div style={{ flex:1 }}/>
        <SkeletonBar w={120} h={30} r={8}/><SkeletonBar w={180} h={30} r={8}/>
      </div>
      {/* grid */}
      <div style={{ flex:1, padding:'24px 28px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:16 }}>
          {[0,1,2,3,4,5,6,7].map(i => (
            <div key={i} style={{ background:'var(--surface)', borderRadius:12, padding:16,
              border:'1px solid var(--border-subtle)', display:'flex', flexDirection:'column', gap:10,
              opacity:1-i*0.08 }}>
              <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                <SkeletonBar w={36} h={36} r={10}/>
                <div style={{ flex:1 }}>
                  <SkeletonBar w="70%" h={14} r={4} style={{ marginBottom:6 }}/>
                  <SkeletonBar w="50%" h={10} r={4}/>
                </div>
              </div>
              <SkeletonBar h={12} r={4}/><SkeletonBar w="80%" h={12} r={4}/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
