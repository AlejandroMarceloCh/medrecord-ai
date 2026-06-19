import React, { useRef, useEffect } from 'react';
import { WaveformPlayer } from './waveform.jsx';
import { applyDict } from './helpers.js';

const PARA = { fontSize:13.5, lineHeight:1.65, marginBottom:12, color:'var(--muted)' };

export function TranscriptPanel({ rec, dict, hovFieldId }) {
  const markRef = useRef(null);

  const text  = applyDict(rec?.transcript || '', dict);
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // Evidencia real: la cita textual que el LLM verificó como fuente de este campo.
  const quoteRaw = hovFieldId && rec?.sources ? rec.sources[hovFieldId] : '';
  const quote = quoteRaw ? applyDict(quoteRaw, dict) : '';

  useEffect(() => {
    if (quote && markRef.current) markRef.current.scrollIntoView({ block:'center', behavior:'smooth' });
  }, [hovFieldId]);

  function renderPara(p, i) {
    const idx = quote ? p.indexOf(quote) : -1;
    if (idx === -1) return <p key={i} style={PARA}>{p}</p>;
    return (
      <p key={i} style={PARA}>
        {p.slice(0, idx)}
        <mark ref={markRef} style={{ background:'var(--accent-soft)', color:'var(--text)',
          boxShadow:'0 0 0 1px var(--accent-line)', borderRadius:3, padding:'1px 2px' }}>
          {p.slice(idx, idx + quote.length)}
        </mark>
        {p.slice(idx + quote.length)}
      </p>
    );
  }

  return (
    <div style={{ width:340, flexShrink:0, background:'var(--surface-2)',
      borderLeft:'1px solid var(--border-subtle)', display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'14px 20px 12px', borderBottom:'1px solid var(--border-subtle)',
        display:'flex', alignItems:'center', flexShrink:0 }}>
        <span style={{ fontSize:14, fontWeight:600 }}>Transcripción</span>
      </div>

      {/* Audio player */}
      <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--border-subtle)', flexShrink:0 }}>
        <WaveformPlayer recId={rec?.id} durationSec={rec?.durationSec}/>
      </div>

      {/* Transcript text */}
      <div className="mr-scroll" style={{ flex:1, overflowY:'auto', padding:'14px 20px' }}>
        {paras.length === 0 ? (
          <div style={{ textAlign:'center', padding:'32px 0', color:'var(--faint)', fontSize:13 }}>
            Sin transcripción disponible
          </div>
        ) : paras.map(renderPara)}
      </div>
    </div>
  );
}
