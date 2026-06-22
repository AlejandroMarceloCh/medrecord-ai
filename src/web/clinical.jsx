import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from './icons.jsx';
import { Btn, IconBtn, Spinner, Chip } from './ui.jsx';
import { FIELD_SECTIONS } from './constants.js';
import { recName, fmtDateTime, fmtDur, countEmpty, flattenFields, unflattenVals, applyDict, apiFetch } from './helpers.js';

// ── ClinicalField ────────────────────────────────────────────────────────────
// needsConfirm: campo poblado por IA que el médico aún no confirmó ni editó.
// Se resalta y exige una acción explícita antes de poder firmar (human-in-the-loop).
export function ClinicalField({ id, label, value, long, filterMode, onChange, onHover, hasSource, needsConfirm, onConfirm }) {
  const [focus, setFocus] = useState(false);
  const empty = !String(value||'').trim();
  const warn  = filterMode && empty;
  const flag  = needsConfirm && !warn;   // resalte de "confirmar IA"
  const Input = long ? 'textarea' : 'input';
  const pad = (warn || flag) ? '10px 8px' : '10px 0';
  return (
    <div
      onMouseEnter={hasSource ? () => onHover?.(id) : undefined}
      onMouseLeave={hasSource ? () => onHover?.(null) : undefined}
      style={{ padding: pad,
        margin: (warn || flag) ? '0 -8px' : 0, borderRadius: (warn || flag) ? 6 : 0,
        borderLeft: flag ? '2px solid var(--accent)' : undefined,
        borderBottom:`1px solid ${focus?'var(--accent)':warn?'var(--warn-border)':'var(--border-subtle)'}`,
        transition:'border-color 0.12s, background 0.12s',
        background: warn ? 'var(--warn-bg)' : flag ? 'var(--accent-soft)' : 'transparent' }}>
      <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:4 }}>
        {empty && <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--warn-dot)', flexShrink:0 }}/>}
        <label style={{ fontSize:10.5, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase',
          color:empty?'var(--warn)':'var(--faint)', cursor:hasSource?'help':'default' }}>{label}</label>
        {hasSource && <span title="Pasa el cursor para ver la fuente en la transcripción"
          style={{ width:5, height:5, borderRadius:'50%', background:'var(--accent)', flexShrink:0, opacity:0.7 }}/>}
        <div style={{ flex:1 }}/>
        {flag && (
          <button type="button" onClick={()=>onConfirm?.(id)}
            title="Marcar este campo como revisado"
            style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:5,
              background:'var(--accent)', color:'#fff', border:'none', cursor:'pointer',
              fontSize:10.5, fontWeight:700, fontFamily:'inherit', flexShrink:0 }}>
            <Icon name="check" size={11} stroke={3}/> Confirmar
          </button>
        )}
      </div>
      <Input value={value||''} onChange={e=>onChange(id,e.target.value)}
        onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)}
        placeholder={empty?'Sin datos…':''}
        rows={long?Math.max(2,Math.ceil((String(value||'').length||20)/72)):undefined}
        style={{ width:'100%', border:'none', outline:'none', background:'transparent', resize:'none',
          fontFamily:'inherit', fontSize:long?13.5:14.5, color:empty?'var(--faint)':'var(--text)',
          lineHeight:1.65, padding:0 }}/>
    </div>
  );
}

// ── FieldGroup ───────────────────────────────────────────────────────────────
export function FieldGroup({ icon, title, children, emptyCount, filterMode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:28 }}>
      <button type="button" onClick={()=>setOpen(v=>!v)}
        style={{ display:'flex', alignItems:'center', gap:8, background:'none', border:'none',
          cursor:'pointer', padding:'4px 0', marginBottom:open?4:0, width:'100%', textAlign:'left' }}>
        <Icon name="chevR" size={12} stroke={2.5}
          style={{ color:'var(--faint)', transform:open?'rotate(90deg)':'none', transition:'transform 0.18s', flexShrink:0 }}/>
        <div style={{ width:22, height:22, borderRadius:6, background:'var(--accent-soft)', color:'var(--accent-strong)',
          display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <Icon name={icon} size={11}/>
        </div>
        <span style={{ fontSize:11, fontWeight:800, letterSpacing:'0.07em', textTransform:'uppercase',
          color:'var(--muted)', flex:1 }}>{title}</span>
        {filterMode && emptyCount > 0 && (
          <span style={{ fontSize:11, fontWeight:650, color:'var(--warn)',
            background:'var(--warn-bg)', border:'1px solid var(--warn-border)',
            borderRadius:4, padding:'1px 7px', flexShrink:0 }}>
            {emptyCount} vacío{emptyCount>1?'s':''}
          </span>
        )}
      </button>
      {open && <div style={{ animation:'mr-fade 0.18s ease both' }}>{children}</div>}
    </div>
  );
}

// ── AiBanner ─────────────────────────────────────────────────────────────────
export function AiBanner({ rec, emptyCount, onReextract, reextracting, pendingConfirm }) {
  let bg, bd, fg, msg, spin=false, action=null;
  if (rec.status==='filling'||reextracting) {
    bg='var(--accent-soft)'; bd='var(--accent-line)'; fg='var(--accent-strong)';
    msg='Completando los campos con IA local…'; spin=true;
  } else if (rec.fieldsError) {
    bg='var(--warn-bg)'; bd='var(--warn-border)'; fg='var(--warn)';
    msg='El autollenado falló. Transcripción disponible, revisa a mano o reintenta.';
    action=<Btn variant="soft" size="sm" icon="refresh" onClick={onReextract}>Reintentar</Btn>;
  } else if (rec.fields) {
    bg='var(--accent-soft)'; bd='var(--accent-line)'; fg='var(--accent-strong)';
    msg = pendingConfirm > 0
      ? `${pendingConfirm} campo${pendingConfirm>1?'s':''} de IA por confirmar antes de firmar.`
      : (emptyCount>0 ? `Campos pre-llenados por IA. ${emptyCount} por completar.` : 'Campos de IA confirmados. Puedes firmar.');
  } else {
    bg='var(--warn-bg)'; bd='var(--warn-border)'; fg='var(--warn)';
    msg='Sin autollenado disponible. Completa los campos desde la transcripción.';
  }
  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
        borderRadius:10, background:bg, border:`1px solid ${bd}`, color:fg, fontSize:13 }}>
        {spin ? <Spinner size={14} color={fg}/> : <Icon name="sparkle" size={15} style={{ flexShrink:0 }}/>}
        <span style={{ flex:1 }}>{msg}</span>
        {action}
      </div>
      {/* Disclaimer clínico permanente: la responsabilidad es del médico que firma. */}
      <div style={{ display:'flex', alignItems:'center', gap:7, marginTop:8, padding:'0 4px',
        fontSize:11.5, color:'var(--faint)', lineHeight:1.5 }}>
        <Icon name="warn" size={12} style={{ flexShrink:0, color:'var(--warn)' }}/>
        <span>La IA puede equivocarse u omitir datos. Verifica cada campo contra la transcripción; al firmar, tú eres responsable del contenido.</span>
      </div>
    </div>
  );
}

// ── PrintDoc ─────────────────────────────────────────────────────────────────
export function PrintDoc({ rec, vals, cfg, dict }) {
  const name  = vals['filiacion.nombre']||recName(rec);
  const doc   = vals['filiacion.documento']||(rec.patient?.dni)||'';
  const fecha = vals['filiacion.fecha_consulta']||new Date(rec.createdAt).toLocaleDateString('es-PE',{day:'2-digit',month:'long',year:'numeric'});
  return (
    <div className="print-doc">
      <div style={{borderBottom:'2px solid #111',paddingBottom:10,marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'flex-end'}}>
        <div><div style={{fontSize:18,fontWeight:800}}>{cfg.clinicName||'Historia clínica'}</div><div style={{fontSize:12,color:'#444'}}>Historia clínica · {fecha}</div></div>
        {cfg.doctorName?<div style={{fontSize:12,textAlign:'right'}}>{cfg.doctorName}</div>:null}
      </div>
      <div style={{display:'flex',gap:24,marginBottom:14,fontSize:12}}>
        <div><strong>Paciente:</strong> {name}</div>{doc?<div><strong>Documento:</strong> {doc}</div>:null}
      </div>
      {FIELD_SECTIONS.map(sec=>{
        const rows=sec.fields.map(([fk,label])=>[label,vals[sec.key+'.'+fk]]).filter(([,v])=>String(v||'').trim());
        if(!rows.length)return null;
        return(<div key={sec.key} style={{marginBottom:14,breakInside:'avoid'}}>
          <div style={{fontSize:12.5,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:'1px solid #bbb',paddingBottom:3,marginBottom:6}}>{sec.title}</div>
          {rows.map(([label,v])=><div key={label} style={{marginBottom:5}}><span style={{fontWeight:700}}>{label}: </span><span>{v}</span></div>)}
        </div>);
      })}
      {rec.transcript&&<div style={{marginTop:18,breakInside:'avoid'}}>
        <div style={{fontSize:11,fontWeight:800,textTransform:'uppercase',color:'#666',borderTop:'1px solid #ddd',paddingTop:8}}>Anexo · Transcripción</div>
        <div style={{fontSize:10.5,color:'#444',whiteSpace:'pre-wrap',marginTop:4}}>{applyDict(rec.transcript, dict)}</div>
      </div>}
      {/* Atestación: el documento declara asistencia por IA y la firma del médico. */}
      <div style={{marginTop:18,paddingTop:8,borderTop:'1px solid #bbb',fontSize:10,color:'#555',breakInside:'avoid'}}>
        <div>Documento generado con asistencia de IA y revisado por el profesional.</div>
        {rec.reviewed
          ? <div style={{marginTop:2}}><strong>Revisado y firmado</strong>{cfg.doctorName?` por ${cfg.doctorName}`:''}{rec.reviewedAt?` · ${fmtDateTime(rec.reviewedAt)}`:''}.</div>
          : <div style={{marginTop:2,color:'#a00'}}><strong>BORRADOR sin firmar</strong> — no válido como historia clínica.</div>}
      </div>
    </div>
  );
}

// ── ClinicalFields (Column B) ─────────────────────────────────────────────────
export function ClinicalFields({ rec, cfg, dict, onHoverField, onSaved, onDelete, onRetry, onReextract, onSign, onPrev, onNext, onDirty, queuePos, pendingCount }) {
  const sources = rec?.sources || {};
  // Aplica el diccionario médico al aplanar los campos (queda corregido al firmar).
  const flat = (f) => { const o = flattenFields(f); for (const k in o) o[k] = applyDict(o[k], dict); return o; };

  const [vals,   setVals]   = useState(()=>flat(rec?.fields));
  const [save,   setSave]   = useState('idle');
  const [dirty,  setDirty]  = useState(false);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [confirmed, setConfirmed] = useState(()=>new Set());
  const touched = useRef({});

  // Campos que la IA pobló (no vacíos): son los que el médico debe confirmar o editar.
  const iaFlat = useMemo(()=>flat(rec?.fields_ia), [rec?.fields_ia]);
  const isAi = (id) => !!String(iaFlat[id]||'').trim();
  const aiIds = useMemo(()=>Object.keys(iaFlat).filter(k=>String(iaFlat[k]||'').trim()), [iaFlat]);
  const confirmField = (id) => setConfirmed(s => { const n = new Set(s); n.add(id); return n; });

  // Merge incoming LLM field updates without overwriting user edits
  useEffect(() => {
    if (!rec?.fields) return;
    const fresh = flat(rec.fields);
    setVals(prev => {
      const next = { ...prev };
      for (const k of Object.keys(fresh)) if (!touched.current[k] && fresh[k]) next[k] = fresh[k];
      return next;
    });
  }, [rec?.fields]);

  // Reset state on rec change. Una grabación ya revisada se considera toda confirmada.
  useEffect(() => {
    setVals(flat(rec?.fields));
    setSave('idle'); setDirty(false); setOnlyEmpty(false);
    touched.current = {};
    const already = (rec?.status==='reviewed'||rec?.reviewed) ? Object.keys(flat(rec?.fields_ia)) : (rec?.confirmed||[]);
    setConfirmed(new Set(already));
  }, [rec?.id]);

  useEffect(() => {
    if (reextracting && (rec?.status==='done'||rec?.status==='reviewed')) setReextracting(false);
  }, [rec?.status, rec?.fields]);

  // Reporta al padre si hay trabajo sin guardar (para avisar antes de cambiar de paciente).
  useEffect(() => { onDirty?.(dirty || save==='error'); }, [dirty, save]);
  useEffect(() => () => onDirty?.(false), []);   // al desmontar, ya no hay nada sin guardar aquí

  // Editar un campo de IA cuenta como confirmarlo (el médico lo está atendiendo).
  const setField = (id, v) => {
    touched.current[id]=true; setVals(s=>({...s,[id]:v})); setDirty(true); setSave('idle');
    if (isAi(id)) confirmField(id);
  };
  const { empty: emptyCount } = useMemo(() => countEmpty(vals), [vals]);

  // Campos de IA todavía sin confirmar ni editar → bloquean la firma.
  const pendingConfirm = useMemo(()=>aiIds.filter(id=>!confirmed.has(id)), [aiIds, confirmed]);

  const doSave = async (markReviewed=false) => {
    setSave('saving');
    try {
      const body = {
        fields: unflattenVals(vals),
        patient: { name:vals['filiacion.nombre']||(rec.patient?.name)||'', dni:vals['filiacion.documento']||(rec.patient?.dni)||'' },
        confirmed: aiIds.filter(id=>confirmed.has(id)),
        version: rec.version || 0,   // optimistic lock: el server rechaza si cambió de fondo
        ...(markReviewed ? { reviewed:true } : {}),
      };
      const r = await apiFetch(`/api/recordings/${rec.id}/fields`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (!r.ok) throw new Error('save');
      const updated = await r.json();
      setSave('saved'); setDirty(false);
      onSaved?.(updated);
      return updated;
    } catch { setSave('error'); return null; }
  };

  const doSign = async () => {
    if (pendingConfirm.length) { setSave('idle'); return; }   // guard de UI (el server revalida)
    const updated = await doSave(true);
    if (updated) onSign?.(updated);
  };

  const doReextract = async () => {
    setReextracting(true);
    try {
      const r = await apiFetch(`/api/recordings/${rec.id}/reextract`, { method:'POST' });
      if (!r.ok) setReextracting(false);   // 404/409 (p. ej. ya firmada): no dejar el spinner colgado
    } catch { setReextracting(false); }
  };

  const isReviewed = rec?.status === 'reviewed' || rec?.reviewed;
  const isError    = rec?.status === 'error';
  const isProc     = ['received','processing','filling'].includes(rec?.status);
  const patientKey = 'filiacion.nombre';
  const patientName = vals[patientKey] || recName(rec);

  const saveLabel   = save==='saving' ? 'Guardando…' : save==='error' ? 'Reintentar' : 'Guardar';
  const saveVariant = save==='error' ? 'danger' : 'ghost';

  if (!rec) return (
    <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--faint)', fontSize:14 }}>
      Selecciona un paciente
    </div>
  );

  return (
    <div style={{ flex:1, minWidth:0, background:'var(--surface)', display:'flex', flexDirection:'column', overflow:'hidden', borderRight:'1px solid var(--border-subtle)' }}>
      <PrintDoc rec={rec} vals={vals} cfg={cfg||{}} dict={dict}/>

      {/* Scroll area */}
      <div className="mr-scroll" style={{ flex:1, overflowY:'auto' }}>
        <div style={{ maxWidth:680, margin:'0 auto', padding:'36px 44px 60px' }}>

          {/* H1 editable */}
          <input value={vals[patientKey]||''} onChange={e=>setField(patientKey,e.target.value)}
            placeholder="Nombre del paciente"
            style={{ width:'100%', border:'none', outline:'none', background:'transparent',
              fontFamily:'inherit', fontSize:36, fontWeight:800, letterSpacing:'-0.03em',
              color:'var(--text)', lineHeight:1.15, marginBottom:8, padding:0,
              borderBottom:'2px dashed transparent', transition:'border-color 0.15s', cursor:'text' }}
            onFocus={e=>e.target.style.borderBottomColor='var(--border-mid)'}
            onBlur={e=>e.target.style.borderBottomColor='transparent'}/>

          {/* Metadata */}
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, color:'var(--faint)', marginBottom:24, lineHeight:1.6 }}>
            {fmtDateTime(rec.createdAt)}{rec.durationSec ? ` · ${fmtDur(rec.durationSec)}` : ''}{rec.patient?.dni ? ` · DNI ${rec.patient.dni}` : ''}
          </div>

          {isError ? (
            <div style={{ textAlign:'center', padding:'48px 0' }}>
              <div style={{ width:56,height:56,borderRadius:14,background:'var(--danger-bg)',color:'var(--danger)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px' }}>
                <Icon name="warn" size={28}/>
              </div>
              <div style={{ fontSize:17,fontWeight:720,marginBottom:8 }}>No se pudo procesar</div>
              <div style={{ fontSize:13.5,color:'var(--muted)',lineHeight:1.5,marginBottom:20,maxWidth:400,margin:'0 auto 20px' }}>{rec.error||'Error durante la transcripción.'}</div>
              <Btn icon="refresh" onClick={()=>onRetry?.(rec)}>Reintentar</Btn>
            </div>
          ) : isProc ? (
            <div style={{ textAlign:'center', padding:'48px 0' }}>
              <Spinner size={28}/><div style={{ marginTop:16,fontSize:14,color:'var(--muted)' }}>Procesando grabación…</div>
            </div>
          ) : (<>
            {!isReviewed && <AiBanner rec={rec} emptyCount={emptyCount} onReextract={doReextract} reextracting={reextracting} pendingConfirm={pendingConfirm.length}/>}
            {FIELD_SECTIONS.map(sec => {
              const shown = sec.fields.map(([fk,label,long]) => {
                const id = `${sec.key}.${fk}`;
                if (id===patientKey) return null;
                if (onlyEmpty && String(vals[id]||'').trim()) return null;
                return (
                  <ClinicalField key={id} id={id} label={label} long={long} value={vals[id]||''}
                    filterMode={onlyEmpty} onChange={setField}
                    onHover={onHoverField} hasSource={!!sources[id]}
                    needsConfirm={!isReviewed && isAi(id) && !confirmed.has(id)} onConfirm={confirmField}/>
                );
              }).filter(Boolean);
              if (!shown.length) return null;
              const secEmpty = sec.fields.filter(([fk])=>!String(vals[sec.key+'.'+fk]||'').trim()).length;
              return (
                <FieldGroup key={sec.key} icon={sec.icon} title={sec.title} emptyCount={secEmpty} filterMode={onlyEmpty}>
                  <div style={{ display:sec.cols===2?'grid':'flex', gridTemplateColumns:sec.cols===2?'1fr 1fr':undefined, flexDirection:'column', gap:0 }}>
                    {shown}
                  </div>
                </FieldGroup>
              );
            })}
          </>)}
        </div>
      </div>

      {/* Sticky footer */}
      <div style={{ height:60, borderTop:'1px solid var(--border-subtle)', padding:'0 28px',
        display:'flex', alignItems:'center', gap:8, flexShrink:0, background:'var(--surface)' }}>

        <IconBtn name="chevL" onClick={onPrev} disabled={queuePos<=1} title="Anterior (K)"/>

        {!isError && !isProc && (
          <button type="button" onClick={()=>setOnlyEmpty(v=>!v)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:6,
              background:onlyEmpty?'var(--warn-bg)':'transparent',
              border:`1px solid ${onlyEmpty?'var(--warn-border)':'var(--border-mid)'}`,
              color:onlyEmpty?'var(--warn)':'var(--faint)', cursor:'pointer',
              fontSize:11, fontWeight:550, fontFamily:'inherit', flexShrink:0, transition:'all 0.15s' }}>
            Solo vacíos
            {emptyCount > 0 && (
              <span style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:700,
                color:onlyEmpty?'var(--warn)':'var(--muted)' }}>{emptyCount}</span>
            )}
          </button>
        )}

        <div style={{ flex:1 }}/>

        {save==='error' && (
          <span style={{ fontSize:12.5, color:'var(--danger)', fontWeight:600 }}>No se pudo guardar</span>
        )}
        {!isError && !isProc && (<>
          {dirty && (
            <Btn variant={saveVariant} size="sm" onClick={()=>doSave(false)} disabled={save==='saving'}>{saveLabel}</Btn>
          )}
          {isReviewed
            ? <Chip tone="ok">Revisada</Chip>
            : <Btn variant="primary" size="sm" onClick={doSign} disabled={save==='saving'||pendingConfirm.length>0}
                title={pendingConfirm.length>0?`Confirma ${pendingConfirm.length} campo(s) de IA antes de firmar`:'Firmar'}>
                {pendingConfirm.length>0 ? `Confirma ${pendingConfirm.length}` : 'Firmar'}
              </Btn>
          }
        </>)}

        <IconBtn name="chevR" onClick={onNext} disabled={queuePos>=pendingCount} title="Siguiente (J)"/>
      </div>
    </div>
  );
}
