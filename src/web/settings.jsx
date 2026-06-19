import React, { useState, useEffect } from 'react';
import { Btn, IconBtn } from './ui.jsx';
import { Icon } from './icons.jsx';

export function SettingsView({ cfg, setCfg, dict, setDict }) {
  const [tab, setTab]   = useState('clinic');
  const [w, setW]       = useState('');
  const [r, setR]       = useState('');
  const [token, setToken]   = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  useEffect(() => { setToken(localStorage.getItem('medrecord.token') || ''); }, []);
  const saveToken = () => {
    const t = token.trim();
    if (t) localStorage.setItem('medrecord.token', t);
    else localStorage.removeItem('medrecord.token');
    setTokenSaved(true);
    setTimeout(() => setTokenSaved(false), 2000);
  };

  const upd = (k, v) => { const n={...cfg,[k]:v}; setCfg(n); };
  const addTerm = () => {
    if (w && r) { setDict([{wrong:w,right:r},...dict]); setW(''); setR(''); }
  };

  const lbl = { display:'block', fontSize:12, fontWeight:650, color:'var(--muted)', marginBottom:6,
    letterSpacing:'0.04em', textTransform:'uppercase' };
  const inp = { width:'100%', border:'1px solid var(--border-mid)', borderRadius:8, background:'var(--surface)',
    color:'var(--text)', fontFamily:'inherit', fontSize:14.5, padding:'9px 13px', outline:'none' };

  return (
    <div className="mr-scroll" style={{ flex:1, overflowY:'auto', padding:'28px 32px', background:'var(--bg)' }}>
      <div style={{ maxWidth:680 }}>
        <div style={{ fontSize:24, fontWeight:780, letterSpacing:'-0.025em', marginBottom:4 }}>Ajustes</div>
        <div style={{ fontSize:13.5, color:'var(--muted)', marginBottom:20, lineHeight:1.5 }}>
          Identidad de la clínica y diccionario de correcciones. Se guarda en este navegador.
        </div>

        {/* Tab bar */}
        <div style={{ display:'flex', background:'var(--surface-2)', borderRadius:8, padding:3, gap:2, marginBottom:20, width:'fit-content' }}>
          {[['clinic','Clínica y médico'],['dict','Diccionario médico']].map(([k,l])=>(
            <button key={k} type="button" onClick={()=>setTab(k)}
              style={{ padding:'5px 16px', border:'none', borderRadius:6, fontFamily:'inherit', fontSize:13.5,
                fontWeight:tab===k?600:400, cursor:'pointer',
                background:tab===k?'var(--surface)':'transparent',
                color:tab===k?'var(--text)':'var(--muted)',
                boxShadow:tab===k?'0 1px 3px rgba(28,25,23,0.08)':'none', transition:'all 0.12s' }}>
              {l}
            </button>
          ))}
        </div>

        {tab==='clinic' && (
          <div style={{ background:'var(--surface)', border:'1px solid var(--border-subtle)', borderRadius:12, padding:20, maxWidth:480 }}>
            <label style={lbl}>Nombre del médico</label>
            <input style={{ ...inp, marginBottom:16 }} value={cfg.doctorName||''} onChange={e=>upd('doctorName',e.target.value)}
              placeholder="Ej. Dr. Juan Pérez"
              onFocus={e=>e.target.style.borderColor='var(--accent)'}
              onBlur={e=>e.target.style.borderColor='var(--border-mid)'}/>
            <label style={lbl}>Nombre de la clínica / consultorio</label>
            <input style={inp} value={cfg.clinicName||''} onChange={e=>upd('clinicName',e.target.value)}
              placeholder="Ej. Consultorio San Juan"
              onFocus={e=>e.target.style.borderColor='var(--accent)'}
              onBlur={e=>e.target.style.borderColor='var(--border-mid)'}/>
            <div style={{ fontSize:12, color:'var(--faint)', marginTop:12, lineHeight:1.5 }}>
              Aparecen en el encabezado del PDF exportado.
            </div>
            <div style={{ marginTop:24, borderTop:'1px solid var(--border-subtle)', paddingTop:20 }}>
              <label style={lbl}>Clave de acceso</label>
              <div style={{ display:'flex', gap:8 }}>
                <input style={{ ...inp, flex:1 }} type="password" value={token} onChange={e=>setToken(e.target.value)}
                  placeholder="Dejar vacío = sin clave"
                  onFocus={e=>e.target.style.borderColor='var(--accent)'}
                  onBlur={e=>e.target.style.borderColor='var(--border-mid)'}
                  onKeyDown={e=>e.key==='Enter'&&saveToken()}/>
                <Btn onClick={saveToken} style={{ whiteSpace:'nowrap' }}>{tokenSaved ? 'Guardado' : 'Guardar'}</Btn>
              </div>
              <div style={{ fontSize:12, color:'var(--faint)', marginTop:8, lineHeight:1.5 }}>
                Debe coincidir con <code style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11 }}>MEDRECORD_TOKEN</code> en el servidor.
              </div>
            </div>
          </div>
        )}

        {tab==='dict' && (
          <div>
            <p style={{ fontSize:13.5, color:'var(--muted)', marginBottom:16, lineHeight:1.5 }}>
              Correcciones de términos médicos. <span style={{ color:'var(--faint)' }}>Se aplican al mostrar la transcripción y los campos.</span>
            </p>
            <div style={{ background:'var(--surface)', border:'1px solid var(--border-subtle)', borderRadius:12, overflow:'hidden' }}>
              {/* Add row */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 20px 1fr 40px', alignItems:'center', gap:10, padding:'12px 16px', background:'var(--surface-2)', borderBottom:'1px solid var(--border-subtle)' }}>
                <input style={{ ...inp, fontSize:13.5 }} placeholder="cómo se escucha" value={w} onChange={e=>setW(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&addTerm()}
                  onFocus={e=>e.target.style.borderColor='var(--accent)'}
                  onBlur={e=>e.target.style.borderColor='var(--border-mid)'}/>
                <Icon name="arrowR" size={14} style={{ color:'var(--faint)' }}/>
                <input style={{ ...inp, fontSize:13.5 }} placeholder="cómo debe quedar" value={r} onChange={e=>setR(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&addTerm()}
                  onFocus={e=>e.target.style.borderColor='var(--accent)'}
                  onBlur={e=>e.target.style.borderColor='var(--border-mid)'}/>
                <IconBtn name="plus" onClick={addTerm} size={38} ico={17}
                  style={{ background:'var(--accent-soft)', color:'var(--accent-strong)' }}/>
              </div>
              {dict.length===0 && <div style={{ padding:22, textAlign:'center', color:'var(--faint)', fontSize:13.5 }}>Aún no hay términos.</div>}
              {dict.map((t,i) => (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 20px 1fr 40px', alignItems:'center', gap:10, padding:'10px 16px', borderBottom:i<dict.length-1?'1px solid var(--border-subtle)':'none' }}>
                  <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13, color:'var(--muted)', textDecoration:'line-through' }}>{t.wrong}</span>
                  <Icon name="arrowR" size={13} style={{ color:'var(--faint)' }}/>
                  <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13, fontWeight:600 }}>{t.right}</span>
                  <IconBtn name="trash" size={34} ico={15} onClick={()=>setDict(dict.filter((_,j)=>j!==i))}/>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
