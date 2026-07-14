import React, { useState, useMemo } from 'react';
import { Icon } from './icons.jsx';
import { Avatar, Spinner, Btn } from './ui.jsx';
import {
  recName, recInitials, avatarColor, fmtDur, fmtDate, fmtClock,
  recAge, recSummary, recCompletion, dayKey, dayLabel,
} from './helpers.js';

const TABS = [
  { key:'pending',    label:'Por revisar',  filter: r => r.status==='done'||r.status==='error' },
  { key:'processing', label:'En proceso',   filter: r => ['received','queued','processing','filling'].includes(r.status) },
  { key:'reviewed',   label:'Revisadas',    filter: r => r.status==='reviewed' },
];

function RecCard({ rec, onClick, showDate }) {
  const [hov, setHov] = useState(false);
  const name     = recName(rec);
  const initials = recInitials(rec);
  const color    = avatarColor(initials);
  const age      = recAge(rec);
  const isError  = rec.status === 'error';
  const isProc   = ['received','queued','processing','filling'].includes(rec.status);
  const isReviewed = rec.status === 'reviewed';
  const pct      = recCompletion(rec);
  const summary  = recSummary(rec);

  return (
    <div onClick={onClick}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{ background:'var(--surface)', borderRadius:12, padding:'14px 16px',
        border:`1px solid ${isError ? 'var(--danger-border)' : hov ? 'var(--border-mid)' : 'var(--border-subtle)'}`,
        boxShadow: hov ? 'var(--shadow)' : '0 1px 2px rgba(28,25,23,0.04)',
        transform: hov ? 'translateY(-2px)' : 'none',
        transition:'transform 0.15s, box-shadow 0.15s, border-color 0.12s',
        cursor:'pointer', display:'flex', flexDirection:'column', gap:10 }}>

      {/* Header row */}
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        {isProc
          ? <div style={{ width:36, height:36, borderRadius:10, flexShrink:0, background:'var(--accent-soft)',
              border:'1.5px solid var(--accent-line)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Spinner size={15} color="var(--accent)"/>
            </div>
          : <Avatar initials={initials} color={color} size={36}/>}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:7 }}>
            <span style={{ fontSize:14, fontWeight:650, color:'var(--text)', lineHeight:1.3, minWidth:0,
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {name}
            </span>
            {age && (
              <span style={{ flexShrink:0, fontFamily:"'JetBrains Mono',monospace", fontSize:10.5, fontWeight:600,
                color:'var(--muted)', background:'var(--surface-3)', borderRadius:5, padding:'1px 6px' }}>
                {age}
              </span>
            )}
          </div>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'var(--faint)', marginTop:2 }}>
            {showDate ? `${fmtDate(rec.createdAt)} · ` : ''}{fmtClock(rec.createdAt)}{rec.durationSec ? ` · ${fmtDur(rec.durationSec)}` : ''}
          </div>
        </div>
        {/* Badge */}
        {isError
          ? <span style={{ flexShrink:0, display:'inline-flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600,
              color:'var(--danger)', background:'var(--danger-bg)', border:'1px solid var(--danger-border)',
              borderRadius:6, padding:'2px 8px' }}>
              <Icon name="warn" size={11}/> Error
            </span>
          : isReviewed
            ? <span style={{ fontSize:14, color:'var(--ok)', fontWeight:700, flexShrink:0 }}>✓</span>
            : null}
      </div>

      {/* Summary */}
      {isError
        ? <p style={{ margin:0, fontSize:12.5, color:'var(--danger)', lineHeight:1.6 }}>
            No se pudo transcribir. Abre la consulta para reintentar.
          </p>
        : summary
          ? <p style={{ margin:0, fontSize:12.5, color:'var(--muted)', lineHeight:1.55,
              display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>
              {summary}
            </p>
          : <p style={{ margin:0, fontSize:12.5, color:'var(--faint)', lineHeight:1.6 }}>
              {isProc ? 'Procesando audio…' : 'Sin transcripción disponible.'}
            </p>}

      {/* Completion bar */}
      {!isError && !isProc && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ flex:1, height:4, background:'var(--surface-3)', borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:pct+'%', borderRadius:2,
              background: pct===100 ? 'var(--ok)' : 'var(--accent)' }}/>
          </div>
          <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10.5,
            color: pct===100 ? 'var(--ok)' : 'var(--faint)', fontWeight:600, flexShrink:0 }}>
            {pct}%
          </span>
        </div>
      )}
    </div>
  );
}

function DayHeader({ label, count }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, margin:'4px 0 12px' }}>
      <span style={{ fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--faint)' }}>
        {label}
      </span>
      <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'var(--faint)' }}>{count}</span>
      <div style={{ flex:1, height:1, background:'var(--border-subtle)' }}/>
    </div>
  );
}

const GRID = { display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:16 };

// ── Fila densa ───────────────────────────────────────────────────────────────
// "Por revisar" es la cola de trabajo del día. Con cards de 280px caben ~6 pacientes por
// pantalla; con filas, 25. Con 12-30 consultas diarias, esa es la diferencia entre ver el
// día completo de un vistazo o descubrirlo bajando por un scroll.
function RecRow({ rec, onClick }) {
  const [hov, setHov] = useState(false);
  const name    = recName(rec);
  const isError = rec.status === 'error';
  const isProc  = ['received','queued','processing','filling'].includes(rec.status);
  const pct     = recCompletion(rec);
  const summary = recSummary(rec);
  const dudosos = (rec.dudosos?.length || 0) + (rec.sinEvidencia?.length || 0);

  return (
    <button type="button" onClick={onClick}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{ width:'100%', display:'flex', alignItems:'center', gap:12, textAlign:'left',
        padding:'9px 12px', minHeight:44, cursor:'pointer', fontFamily:'inherit',
        background: hov ? 'var(--surface-2)' : 'transparent',
        border:'none', borderBottom:'1px solid var(--border-subtle)',
        borderLeft:`2px solid ${isError ? 'var(--danger)' : 'transparent'}`,
        transition:'background 0.1s' }}>

      <span style={{ width:8, height:8, borderRadius:'50%', flexShrink:0,
        background: isError ? 'var(--danger)' : isProc ? 'var(--accent)' : 'var(--warn-dot)' }}/>

      <span style={{ flex:'0 0 190px', fontSize:14, fontWeight:640, color:'var(--text)',
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>

      <span style={{ flex:1, minWidth:0, fontSize:13, color:'var(--muted)',
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
        {isProc ? 'Procesando…' : isError ? (rec.error || 'No se pudo procesar') : summary}
      </span>

      {dudosos > 0 && !isProc && !isError && (
        <span title={`${dudosos} campo(s) que revisar primero`}
          style={{ flexShrink:0, display:'inline-flex', alignItems:'center', gap:4, padding:'1px 7px',
            borderRadius:999, fontSize:11, fontWeight:700, color:'var(--warn)',
            background:'var(--warn-bg)', border:'1px solid var(--warn-border)' }}>
          {dudosos} dudoso{dudosos>1?'s':''}
        </span>
      )}

      <span style={{ flexShrink:0, width:52, textAlign:'right',
        fontFamily:"'JetBrains Mono',monospace", fontSize:11.5,
        color: pct >= 80 ? 'var(--ok)' : 'var(--muted)' }}>
        {isProc || isError ? '—' : pct + '%'}
      </span>

      <span style={{ flexShrink:0, width:56, textAlign:'right',
        fontFamily:"'JetBrains Mono',monospace", fontSize:11.5, color:'var(--faint)' }}>
        {fmtClock(rec.createdAt)}
      </span>
    </button>
  );
}

export function ListingView({ recs, tab, setTab, sort, setSort, onSelect, loadError, onRetry }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const counts = useMemo(() => ({
    pending:    recs.filter(r => r.status==='done'||r.status==='error').length,
    processing: recs.filter(r => ['received','queued','processing','filling'].includes(r.status)).length,
    reviewed:   recs.filter(r => r.status==='reviewed').length,
  }), [recs]);

  // Progreso global del día
  const reviewedN = counts.reviewed;
  const totalN    = recs.length;
  const prog      = totalN > 0 ? Math.round(reviewedN/totalN*100) : 0;

  const items = useMemo(() => {
    const active = TABS.find(t => t.key===tab) || TABS[0];
    let list = recs.filter(active.filter);
    if (q) list = list.filter(r => recName(r).toLowerCase().includes(q) || (recSummary(r)||'').toLowerCase().includes(q));
    return [...list].sort((a,b) => sort==='newest' ? b.createdAt-a.createdAt : a.createdAt-b.createdAt);
  }, [recs, tab, q, sort]);

  // "Por revisar" es la cola del día: densidad. El resto (en proceso, revisadas) son
  // grupos chicos donde una card se lee mejor.
  const denso = tab === 'pending';

  // Agrupar por día (solo sin búsqueda activa)
  const groups = useMemo(() => {
    if (q) return null;
    const map = new Map();
    for (const r of items) {
      const k = dayKey(r.createdAt);
      if (!map.has(k)) map.set(k, { key:k, label:dayLabel(r.createdAt), items:[] });
      map.get(k).items.push(r);
    }
    return [...map.values()];
  }, [items, q]);

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg)' }}>

      {/* Tab bar + controls en una sola linea */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)',
        padding:'0 28px', display:'flex', alignItems:'stretch', flexShrink:0 }}>
        {TABS.map(t => (
          <button key={t.key} type="button"
            onClick={()=>{ setTab(t.key); setQuery(''); }}
            style={{ padding:'0 20px', height:52, border:'none', background:'none', cursor:'pointer',
              fontFamily:'inherit', fontSize:13.5,
              fontWeight: tab===t.key ? 650 : 400,
              color: tab===t.key ? 'var(--text)' : 'var(--muted)',
              borderBottom: `2px solid ${tab===t.key ? 'var(--accent)' : 'transparent'}`,
              transition:'all 0.12s', display:'inline-flex', alignItems:'center', gap:7, flexShrink:0 }}>
            {t.label}
            <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, fontWeight:600,
              background: tab===t.key ? 'var(--accent-soft)' : 'var(--surface-3)',
              color: tab===t.key ? 'var(--accent-strong)' : 'var(--faint)',
              border: `1px solid ${tab===t.key ? 'var(--accent-line)' : 'var(--border-subtle)'}`,
              borderRadius:4, padding:'1px 6px' }}>
              {counts[t.key]}
            </span>
          </button>
        ))}

        <div style={{ flex:1 }}/>

        <div style={{ display:'flex', alignItems:'center', gap:8, borderLeft:'1px solid var(--border-subtle)', paddingLeft:16 }}>
          <button type="button" onClick={()=>setSort(s=>s==='newest'?'oldest':'newest')}
            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'6px 12px',
              border:'1px solid var(--border-mid)', borderRadius:8, background:'transparent',
              cursor:'pointer', fontSize:12.5, color:'var(--muted)', fontFamily:'inherit', transition:'color 0.12s' }}
            onMouseEnter={e=>e.currentTarget.style.color='var(--text)'}
            onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
            <Icon name="clock" size={13}/>
            {sort==='newest' ? 'Más reciente' : 'Más antiguo'}
          </button>

          <div style={{ position:'relative', display:'flex', alignItems:'center' }}>
            <Icon name="search" size={13} style={{ position:'absolute', left:9, color:'var(--faint)', pointerEvents:'none' }}/>
            <input value={query} onChange={e=>setQuery(e.target.value)}
              placeholder="Buscar nombre o motivo…"
              style={{ border:'1px solid var(--border-mid)', borderRadius:8,
                padding:'6px 28px 6px 28px', fontFamily:'inherit', fontSize:13,
                background:'var(--surface)', color:'var(--text)', outline:'none',
                width:200, transition:'border-color 0.12s, width 0.18s' }}
              onFocus={e=>{ e.target.style.borderColor='var(--accent)'; e.target.style.width='240px'; }}
              onBlur={e=>{  e.target.style.borderColor='var(--border-mid)'; e.target.style.width='200px'; }}/>
            {query && (
              <button onClick={()=>setQuery('')} type="button"
                style={{ position:'absolute', right:8, background:'none', border:'none',
                  cursor:'pointer', color:'var(--faint)', fontSize:14, lineHeight:1, padding:2 }}>×</button>
            )}
          </div>
        </div>
      </div>

      {/* Progreso del día */}
      {totalN > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 28px',
          background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)', flexShrink:0 }}>
          <span style={{ fontSize:12, color:'var(--muted)', flexShrink:0 }}>
            <strong style={{ color:'var(--text)', fontVariantNumeric:'tabular-nums' }}>{reviewedN}</strong> de {totalN} revisadas
          </span>
          <div style={{ flex:1, maxWidth:280, height:4, background:'var(--surface-3)', borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:prog+'%', background:'var(--accent)', borderRadius:2, transition:'width 400ms ease' }}/>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="mr-scroll" style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>
        {/* Un servidor caído NO es "no hay consultas". Antes el médico leía "Sin consultas en
            esta sección" y cerraba la laptop creyendo que había terminado el día, con las
            historias sin firmar. Un vacío solo es legítimo si la carga tuvo éxito. */}
        {loadError ? (
          <div style={{ textAlign:'center', paddingTop:72 }}>
            <div style={{ width:48, height:48, borderRadius:12, background:'var(--danger-bg)',
              color:'var(--danger)', display:'flex', alignItems:'center', justifyContent:'center',
              margin:'0 auto 14px' }}>
              <Icon name="warn" size={24}/>
            </div>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>No se pudieron cargar las consultas</div>
            <div style={{ fontSize:13.5, color:'var(--muted)', lineHeight:1.5, maxWidth:380,
              margin:'0 auto 18px' }}>
              No sabemos si tienes pendientes. Revisa que el servidor esté encendido y vuelve a intentar.
            </div>
            <Btn icon="refresh" onClick={onRetry}>Reintentar</Btn>
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign:'center', paddingTop:80, color:'var(--faint)' }}>
            <Icon name="clipboard" size={32} style={{ marginBottom:12, opacity:0.35 }}/>
            <div style={{ fontSize:14, fontWeight:600, color:'var(--muted)', marginBottom:6 }}>
              {q ? `Sin resultados para "${query}"` : 'Aún no hay consultas'}
            </div>
            {q ? (
              <button type="button" onClick={()=>setQuery('')}
                style={{ fontSize:12.5, color:'var(--accent-strong)', background:'none', border:'none',
                  cursor:'pointer', fontFamily:'inherit', textDecoration:'underline' }}>
                Limpiar búsqueda
              </button>
            ) : (
              // El acto que corresponde no está acá: está en el celular.
              <div style={{ fontSize:13, color:'var(--muted)', lineHeight:1.55, maxWidth:320, margin:'0 auto' }}>
                Abre MedRecord en tu celular para grabar la primera consulta.
              </div>
            )}
          </div>
        ) : groups ? (
          groups.map(g => (
            <div key={g.key} style={{ marginBottom:24 }}>
              <DayHeader label={g.label} count={g.items.length}/>
              {denso
                ? <div>{g.items.map(r => <RecRow key={r.id} rec={r} onClick={()=>onSelect(r.id)}/>)}</div>
                : <div style={GRID}>{g.items.map(r => <RecCard key={r.id} rec={r} onClick={()=>onSelect(r.id)}/>)}</div>}
            </div>
          ))
        ) : denso ? (
          <div>{items.map(r => <RecRow key={r.id} rec={r} onClick={()=>onSelect(r.id)}/>)}</div>
        ) : (
          <div style={GRID}>
            {items.map(r => <RecCard key={r.id} rec={r} onClick={()=>onSelect(r.id)} showDate/>)}
          </div>
        )}
      </div>
    </div>
  );
}
