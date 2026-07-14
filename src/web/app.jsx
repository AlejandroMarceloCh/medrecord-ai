import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from './icons.jsx';
import { WsChip, IconBtn, Btn, StatusChip, SkeletonListing } from './ui.jsx';
import { loadConfig, saveConfig, loadDict, saveDict } from './constants.js';
import { recName, avatarColor, apiFetch, dayKey } from './helpers.js';
import { ClinicalFields } from './clinical.jsx';
import { TranscriptPanel } from './transcript.jsx';
import { SettingsView }    from './settings.jsx';
import { ListingView }     from './listing.jsx';

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ toast, onDismiss, onOpen, onRetry }) {
  const err = toast.kind === 'error';
  // Los errores NO se auto-descartan: si el médico no estaba mirando, el aviso de que una
  // consulta falló se perdía para siempre. Los éxitos sí, a los 4 s.
  useEffect(() => {
    if (err) return;
    const id = setTimeout(onDismiss, 4000);
    return () => clearTimeout(id);
  }, [err]);

  return (
    <div role="status" aria-live="polite"
      style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'12px 16px', marginBottom:8,
      borderRadius:12, background:err?'var(--danger-bg)':'var(--ok-bg)',
      border:`1px solid ${err?'var(--danger-border)':'var(--ok-border)'}`,
      boxShadow:'0 4px 24px rgba(28,25,23,0.14)', minWidth:300, maxWidth:380,
      animation:'mr-slide-right 0.25s ease-out' }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13.5, fontWeight:650, color:err?'var(--danger)':'var(--ok)' }}>
          {toast.title || (err ? 'No se pudo procesar la consulta' : 'Consulta lista para revisar')}
        </div>
        <div style={{ fontSize:12.5, color:'var(--muted)', marginTop:2, lineHeight:1.45 }}>
          {recName(toast.rec)}
          {/* La CAUSA. Antes el toast decía solo "no se pudo transcribir": sin motivo y sin
              salida, el médico se quedaba mirando una tarjeta roja sin saber qué hacer. */}
          {toast.msg ? <><br/><span style={{ color:'var(--danger)' }}>{toast.msg}</span></> : null}
        </div>
        {err && onRetry && (
          <div style={{ marginTop:8 }}>
            <Btn variant="soft" size="sm" icon="refresh" onClick={()=>onRetry(toast.rec)}>Reintentar</Btn>
          </div>
        )}
      </div>
      {!err && <Btn variant="primary" size="sm" onClick={onOpen}>Abrir</Btn>}
      <button type="button" onClick={onDismiss} aria-label="Descartar aviso"
        style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, display:'flex', flexShrink:0 }}>
        <Icon name="x" size={13}/>
      </button>
    </div>
  );
}

// ── AllDoneScreen ─────────────────────────────────────────────────────────────
function AllDoneScreen({ reviewedCount, processingCount, pastPendingCount, onHistorial, onIncludePast }) {
  const ghostBtn = { display:'inline-flex', alignItems:'center', gap:6, height:34, padding:'0 14px',
    border:'1px solid var(--border-mid)', borderRadius:8, background:'transparent',
    cursor:'pointer', color:'var(--muted)', fontFamily:'inherit', fontSize:13, transition:'color 0.12s' };
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      background:'var(--bg)', gap:8 }}>
      <div style={{ width:48, height:48, borderRadius:12, background:'var(--ok-bg)',
        border:'1px solid var(--ok-border)', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <Icon name="checkCircle" size={24} style={{ color:'var(--ok)' }}/>
      </div>
      <div style={{ fontSize:18, fontWeight:720, letterSpacing:'-0.02em', marginTop:4 }}>Todo al día</div>
      <div style={{ fontSize:13.5, color:'var(--muted)' }}>
        {processingCount > 0
          ? `${processingCount} consulta${processingCount>1?'s':''} en proceso…`
          : 'Sin pendientes de hoy.'}
      </div>
      <div style={{ display:'flex', gap:8, marginTop:8 }}>
        {pastPendingCount > 0 && (
          <button type="button" onClick={onIncludePast} style={ghostBtn}
            onMouseEnter={e=>e.currentTarget.style.color='var(--text)'}
            onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
            Incluir anteriores ({pastPendingCount})
          </button>
        )}
        {reviewedCount > 0 && (
          <button type="button" onClick={onHistorial} style={ghostBtn}
            onMouseEnter={e=>e.currentTarget.style.color='var(--text)'}
            onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
            Ver revisadas ({reviewedCount})
          </button>
        )}
      </div>
    </div>
  );
}

// ── AppHeader ─────────────────────────────────────────────────────────────────
// Salud del pipeline. /health existía desde el sprint 1 y la web NUNCA lo llamaba: si
// Ollama se caía a mitad de turno, el médico se enteraba historia por historia, viendo
// fallar el autollenado doce veces. Un chip y se acabó.
function useHealth() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let vivo = true;
    const check = async () => {
      try {
        const r = await apiFetch('/health');
        if (vivo) setHealth(r.ok ? await r.json() : null);
      } catch { if (vivo) setHealth(null); }
    };
    check();
    const t = setInterval(check, 60000);
    return () => { vivo = false; clearInterval(t); };
  }, []);
  return health;
}

function HealthChip({ health }) {
  if (!health) return null;
  const caidos = [];
  if (!health.whisper) caidos.push('transcripción');
  if (!health.llm)     caidos.push('autollenado');
  if (!caidos.length) return null;

  const soloLlm = caidos.length === 1 && !health.llm;
  return (
    <div title={soloLlm
        ? 'Las consultas se transcriben, pero los campos no se llenan solos. Puedes escribirlos con la transcripción al lado.'
        : 'Revisa que Whisper y Ollama estén corriendo en el servidor.'}
      style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:6,
        background:'var(--warn-bg)', border:'1px solid var(--warn-border)', color:'var(--warn)',
        fontSize:12, fontWeight:600, whiteSpace:'nowrap' }}>
      <Icon name="warn" size={13}/>
      {soloLlm ? 'Autollenado caído' : `Sin ${caidos.join(' ni ')}`}
    </div>
  );
}

function AppHeader({ cfg, view, onViewChange, wsStatus, onRefresh, health }) {
  const initials = cfg.doctorName
    ? cfg.doctorName.replace(/^(Dr|Dra)\.?\s*/i,'').split(' ').filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()
    : 'MR';
  const color = avatarColor(initials);
  return (
    <header style={{ height:60, background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)',
      display:'flex', alignItems:'center', padding:'0 20px', gap:14, flexShrink:0, zIndex:10 }}>

      {/* Logo */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginRight:4 }}>
        <div style={{ width:34, height:34, borderRadius:9, background:'var(--accent)',
          display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
          boxShadow:'0 2px 10px rgba(13,148,136,0.3)' }}>
          <Icon name="pulse" size={18} stroke={2.2} style={{ color:'#fff' }}/>
        </div>
        <span style={{ fontSize:15.5, fontWeight:700, letterSpacing:'-0.03em' }}>
          MedRecord <span style={{ color:'var(--accent)' }}>AI</span>
        </span>
      </div>

      {/* Nav */}
      <div style={{ display:'flex', background:'var(--surface-2)', borderRadius:8, padding:3, gap:2 }}>
        {[['listing','Consultas'],['settings','Ajustes']].map(([k,l])=>(
          <button key={k} type="button" onClick={()=>onViewChange(k)}
            style={{ padding:'5px 14px', border:'none', borderRadius:6, fontFamily:'inherit', fontSize:13,
              fontWeight:500, cursor:'pointer',
              background:(view===k||view==='workbench'&&k==='listing')?'var(--surface)':'transparent',
              color:(view===k||view==='workbench'&&k==='listing')?'var(--text)':'var(--muted)',
              boxShadow:(view===k||view==='workbench'&&k==='listing')?'0 1px 3px rgba(28,25,23,0.08)':'none',
              transition:'all 0.1s' }}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ flex:1 }}/>

      <HealthChip health={health}/>
      <WsChip status={wsStatus} onClick={onRefresh}/>

      {/* Identidad: clickeable hacia Ajustes */}
      {cfg.doctorName ? (
        <button type="button" onClick={()=>onViewChange('settings')} title="Editar en Ajustes"
          style={{ display:'flex', alignItems:'center', gap:9, paddingLeft:4, background:'none',
            border:'none', cursor:'pointer', fontFamily:'inherit', borderRadius:8 }}>
          <div style={{ width:32, height:32, borderRadius:'50%', flexShrink:0,
            background:color+'22', border:`1.5px solid ${color+'44'}`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:12, fontWeight:720, color:color }}>
            {initials}
          </div>
          <div style={{ minWidth:0, textAlign:'left' }}>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:140 }}>
              {cfg.doctorName}
            </div>
            <div style={{ fontSize:11.5, color:'var(--faint)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:140 }}>
              {cfg.clinicName||'Sin clínica'}
            </div>
          </div>
        </button>
      ) : (
        <button type="button" onClick={()=>onViewChange('settings')}
          style={{ display:'inline-flex', alignItems:'center', gap:7, height:34, padding:'0 14px',
            background:'var(--accent-soft)', border:'1px solid var(--accent-line)', borderRadius:8,
            color:'var(--accent-strong)', cursor:'pointer', fontFamily:'inherit', fontSize:13, fontWeight:600,
            transition:'filter 0.12s' }}
          onMouseEnter={e=>e.currentTarget.style.filter='brightness(0.97)'}
          onMouseLeave={e=>e.currentTarget.style.filter=''}>
          <Icon name="user" size={14}/>
          Configura tu nombre
        </button>
      )}
    </header>
  );
}

// ── WorkbenchBar — back + identidad del paciente (sticky) + estado ───────────────
function WorkbenchBar({ rec, reviewedCount, onBack, queuePos, queueLen }) {
  return (
    <div style={{ height:48, background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)',
      display:'flex', alignItems:'center', padding:'0 16px 0 10px', gap:12, flexShrink:0 }}>
      <button type="button" onClick={onBack} title="Ver historial (Esc)"
        style={{ display:'inline-flex', alignItems:'center', gap:5, height:32, padding:'0 11px 0 7px',
          border:'1px solid var(--border-mid)', borderRadius:8, background:'transparent',
          cursor:'pointer', color:'var(--muted)', fontFamily:'inherit', fontSize:13,
          transition:'color 0.12s', flexShrink:0 }}
        onMouseEnter={e=>e.currentTarget.style.color='var(--text)'}
        onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
        <Icon name="chevL" size={15} stroke={2.2}/>
        Revisadas{reviewedCount > 0 ? ` (${reviewedCount})` : ''}
      </button>

      <div style={{ width:1, height:20, background:'var(--border-subtle)', flexShrink:0 }}/>

      <span style={{ fontSize:13.5, fontWeight:650, color:'var(--text)', minWidth:0,
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
        {recName(rec)}
      </span>

      <div style={{ flex:1 }}/>

      {(rec.status==='done' || rec.status==='reviewed') && (
        <button type="button" onClick={() => window.print()} title="Exportar como PDF (imprimir)"
          style={{ display:'inline-flex', alignItems:'center', gap:6, height:32, padding:'0 12px',
            border:'1px solid var(--border-mid)', borderRadius:8, background:'transparent',
            cursor:'pointer', color:'var(--muted)', fontFamily:'inherit', fontSize:13,
            transition:'color 0.12s', flexShrink:0 }}
          onMouseEnter={e=>e.currentTarget.style.color='var(--text)'}
          onMouseLeave={e=>e.currentTarget.style.color='var(--muted)'}>
          <Icon name="download" size={15}/>
          Exportar
        </button>
      )}

      {queueLen > 0 && (
        <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11.5, color:'var(--faint)', flexShrink:0 }}>
          {queueLen} por revisar
        </span>
      )}
      <StatusChip status={rec.status}/>
    </div>
  );
}

// ── WebRoot ───────────────────────────────────────────────────────────────────
export function WebRoot() {
  const health = useHealth();
  const [cfg,        setCfg]        = useState(loadConfig);
  const [dict,       setDict]       = useState(loadDict);
  const [view,       setView]       = useState('listing');
  const [wsStatus,   setWsStatus]   = useState('connecting');
  const [recs,       setRecs]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [toasts,     setToasts]     = useState([]);
  // Tope de 3: si fallan 12 consultas se acumulaban 12 toasts y tapaban la pantalla entera.
  const pushToast = (t) => setToasts(ts =>
    [...ts, { id: Math.random().toString(36).slice(2), ...t }].slice(-3));
  const [activeTab,   setActiveTab]   = useState('pending');
  const [listSort,    setListSort]    = useState('newest');
  const [hovFieldId,  setHovFieldId]  = useState(null);
  const [includePast, setIncludePast] = useState(false);
  const [loadError,   setLoadError]   = useState(false);
  const dirtyRef = useRef(false);   // ¿hay edits sin guardar en el visor? (lo reporta ClinicalFields)

  const upsert    = rec => setRecs(list => { const i=list.findIndex(r=>r.id===rec.id); if(i===-1)return[rec,...list]; const c=[...list]; c[i]=rec; return c; });
  const removeRec = id  => setRecs(list => list.filter(r=>r.id!==id));

  const isToday = ts => dayKey(ts) === dayKey(Date.now());

  // Auto-open first TODAY's pending on load — backlog no interrumpe
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (loading || didAutoSelect.current) return;
    didAutoSelect.current = true;
    const first = recs.find(r => (r.status==='done'||r.status==='error') && isToday(r.createdAt));
    setSelectedId(first ? first.id : null);
    setView('workbench');
  }, [loading]);

  const refetch = useRef(() => {});
  refetch.current = async () => {
    try {
      const res = await apiFetch('/api/recordings');
      if (!res.ok) throw new Error('http ' + res.status);   // 401 ya lo maneja LoginGate
      const d = await res.json();
      setRecs(d); setLoadError(false); setLoading(false);
    } catch { setLoadError(true); setLoading(false); }
  };

  // WebSocket
  useEffect(() => {
    let stopped=false, backoff=1000, ws=null;
    const connect = () => {
      if (stopped) return;
      setWsStatus(s => s==='connected'?'reconnecting':s==='reconnecting'?'reconnecting':'connecting');
      const proto = location.protocol==='https:'?'wss':'ws';
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen  = () => { setWsStatus('connected'); backoff=1000; refetch.current(); };
      ws.onmessage = e => {
        let msg; try { msg=JSON.parse(e.data); } catch { return; }
        if (msg.type==='recording:deleted') { removeRec(msg.id); return; }
        if (msg.recording) {
          upsert(msg.recording);
          if (msg.type==='recording:transcribed') setToasts(ts=>[...ts,{id:Date.now(),kind:'ok',rec:msg.recording}]);
          if (msg.type==='recording:error')       setToasts(ts=>[...ts,{id:Date.now(),kind:'error',rec:msg.recording}]);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = () => { if(stopped)return; setWsStatus('reconnecting'); setTimeout(connect,backoff); backoff=Math.min(10000,backoff*2); };
    };
    refetch.current();
    connect();
    return () => { stopped=true; try { ws?.close(); } catch {} };
  }, []);

  // Queue for workbench navigation — matches active tab + sort
  const TAB_FILTER = {
    pending:    r => r.status==='done'||r.status==='error',
    processing: r => ['received','processing','filling'].includes(r.status),
    reviewed:   r => r.status==='reviewed',
  };
  const activeQueue = useMemo(() => {
    const fn = TAB_FILTER[activeTab] || TAB_FILTER.pending;
    let filtered = recs.filter(fn);
    if (activeTab === 'pending' && !includePast) filtered = filtered.filter(r => isToday(r.createdAt));
    return [...filtered].sort((a,b) => listSort==='newest' ? b.createdAt-a.createdAt : a.createdAt-b.createdAt);
  }, [recs, activeTab, listSort, includePast]);

  const liveRec       = selectedId ? recs.find(r=>r.id===selectedId)||null : null;
  const queuePos      = activeQueue.findIndex(r=>r.id===selectedId) + 1;
  const reviewedCount    = useMemo(() => recs.filter(r=>r.status==='reviewed').length, [recs]);
  const processingCount  = useMemo(() => recs.filter(r=>['received','processing','filling'].includes(r.status)).length, [recs]);
  const pastPendingCount = useMemo(() => recs.filter(r=>(r.status==='done'||r.status==='error')&&!isToday(r.createdAt)).length, [recs]);

  const onIncludePast = () => {
    setIncludePast(true);
    const first = recs.find(r => (r.status==='done'||r.status==='error') && !isToday(r.createdAt));
    if (first) { setSelectedId(first.id); setView('workbench'); }
  };

  // Handlers
  const handleViewChange = v => {
    setView(v);
    if (v !== 'workbench') setSelectedId(null);
  };

  const handleSelect = id => {
    if (id !== selectedId && !confirmLeave()) return;
    setSelectedId(id);
    setView('workbench');
  };

  const handleDelete = async rec => {
    if (!confirm(`¿Descartar la consulta de ${recName(rec)}?\n\nSe borra el audio y la transcripción. No se puede deshacer.\n\n(Una historia ya firmada no se puede borrar.)`)) return;
    try {
      const r = await apiFetch(`/api/recordings/${rec.id}`, { method:'DELETE' });
      if (!r.ok) {
        // 409 = historia firmada: tiene valor legal y no se destruye.
        const d = await r.json().catch(() => ({}));
        pushToast({ kind:'error', rec, msg: d.error || 'No se pudo descartar la consulta.' });
        return;
      }
      // Borrado optimista SOLO tras confirmar: antes se quitaba de la lista primero y, si el
      // DELETE fallaba, la consulta reaparecía al siguiente refresco como si nada.
      removeRec(rec.id);
      setSelectedId(null);
      setView('listing');
    } catch {
      pushToast({ kind:'error', rec, msg:'No se pudo conectar con el servidor. Revisa la conexión.' });
    }
  };

  const handleRetry = async rec => {
    try {
      const r = await apiFetch(`/api/recordings/${rec.id}/retry`, { method:'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        pushToast({ kind:'error', rec, msg: d.error || 'No se pudo reintentar.' });
      }
    } catch {
      // Antes esto era un catch vacío: el clic no hacía absolutamente nada y el médico
      // volvía a apretar cinco veces sin entender por qué no pasaba nada.
      pushToast({ kind:'error', rec, msg:'No se pudo conectar con el servidor. Revisa la conexión.' });
    }
  };

  const handleCfg  = newCfg  => { setCfg(newCfg);  saveConfig(newCfg); };
  const handleDict = newDict => { setDict(newDict); saveDict(newDict); };

  const onSign = updated => {
    upsert(updated);
    const remaining = activeQueue.filter(r => r.id!==selectedId && r.status!=='reviewed');
    if (remaining.length > 0) {
      setSelectedId(remaining[0].id);
    } else {
      setSelectedId(null);
      setView('workbench');
    }
  };

  // No cambiar de paciente con edits sin guardar sin avisar (se perderían en silencio).
  const confirmLeave = () => !dirtyRef.current ||
    window.confirm('Tienes cambios sin guardar en esta consulta.\n\nAceptar = salir sin guardar.\nCancelar = quedarte y guardar.');
  const onPrev = () => {
    if (!confirmLeave()) return;
    const idx = activeQueue.findIndex(r=>r.id===selectedId);
    if (idx > 0) setSelectedId(activeQueue[idx-1].id);
  };
  const onNext = () => {
    if (!confirmLeave()) return;
    const idx = activeQueue.findIndex(r=>r.id===selectedId);
    if (idx < activeQueue.length-1) setSelectedId(activeQueue[idx+1].id);
  };

  // Keyboard shortcuts (workbench only)
  useEffect(() => {
    if (view !== 'workbench') return;
    const onKey = e => {
      if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
      if (e.key==='j') onNext();
      if (e.key==='k') onPrev();
      if (e.key==='Escape') onBack();   // mismo destino que el botón, y pasa por confirmLeave
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, activeQueue, selectedId]);

  const onBack = () => { if (!confirmLeave()) return; setActiveTab('reviewed'); setSelectedId(null); setView('listing'); };

  useEffect(() => { setHovFieldId(null); }, [selectedId]);

  if (loading) return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'var(--bg)' }}>
      <div style={{ height:60, background:'var(--surface)', borderBottom:'1px solid var(--border-subtle)' }}/>
      <SkeletonListing/>
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <AppHeader cfg={cfg} view={view} onViewChange={handleViewChange}
        wsStatus={wsStatus} onRefresh={()=>refetch.current()} health={health}/>

      {view==='settings' ? (
        <SettingsView cfg={cfg} setCfg={handleCfg} dict={dict} setDict={handleDict}/>

      ) : view==='workbench' && liveRec ? (
        <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
          <WorkbenchBar rec={liveRec} reviewedCount={reviewedCount} onBack={onBack}
            reviewPos={queuePos} queueLen={activeQueue.length}/>
          <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
            <ClinicalFields
              rec={liveRec} cfg={cfg} dict={dict} onHoverField={setHovFieldId}
              onSaved={upsert} onDelete={handleDelete} onRetry={handleRetry}
              onSign={onSign} onPrev={onPrev} onNext={onNext}
              onDirty={(d)=>{ dirtyRef.current = d; }}
              reviewPos={queuePos} pendingCount={activeQueue.length}/>
            <TranscriptPanel rec={liveRec} dict={dict} hovFieldId={hovFieldId}/>
          </div>
        </div>

      ) : view==='workbench' && loadError && recs.length===0 ? (
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, color:'var(--muted)' }}>
          <div style={{ fontSize:15, fontWeight:650 }}>No se pudieron cargar las consultas</div>
          <div style={{ fontSize:13, color:'var(--faint)' }}>Revisa la conexión con el servidor.</div>
          <Btn onClick={()=>{ setLoadError(false); refetch.current(); }}>Reintentar</Btn>
        </div>

      ) : view==='workbench' ? (
        <AllDoneScreen reviewedCount={reviewedCount} processingCount={processingCount}
          pastPendingCount={pastPendingCount} onIncludePast={onIncludePast}
          onHistorial={()=>{ setActiveTab('reviewed'); setView('listing'); }}/>

      ) : (
        <ListingView loadError={loadError} onRetry={()=>refetch.current()}
          recs={recs} tab={activeTab} setTab={setActiveTab}
          sort={listSort} setSort={setListSort}
          onSelect={handleSelect}/>
      )}

      {/* Toast stack */}
      <div style={{ position:'fixed', bottom:24, right:24, zIndex:1000 }}>
        {toasts.map(tt => (
          <Toast key={tt.id} toast={tt}
            onDismiss={()=>setToasts(ts=>ts.filter(x=>x.id!==tt.id))}
            onOpen={()=>{ handleSelect(tt.rec.id); setToasts(ts=>ts.filter(x=>x.id!==tt.id)); }}
            onRetry={(rec)=>{ handleRetry(rec); setToasts(ts=>ts.filter(x=>x.id!==tt.id)); }}/>
        ))}
      </div>
    </div>
  );
}
