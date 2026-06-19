import React, { useState, useEffect, useRef } from 'react';

const BARS = Array.from({ length:80 }, (_,i) =>
  Math.max(4, Math.min(44, 6 + Math.abs(Math.sin(i*2.3+1.7)*Math.cos(i*0.7+.5)*Math.sin(i*.31))*40))
);

function fmtT(s) { return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

export function WaveformPlayer({ recId, durationSec }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time,    setTime]    = useState(0);
  const total = durationSec || 0;
  const prog  = total > 0 ? time / total : 0;

  // Sync time with audio element
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime  = () => setTime(a.currentTime);
    const onEnded = () => { setPlaying(false); setTime(0); };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnded);
    return () => { a.removeEventListener('timeupdate', onTime); a.removeEventListener('ended', onEnded); };
  }, [recId]);

  // Reset on rec change
  useEffect(() => { setPlaying(false); setTime(0); }, [recId]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play().catch(()=>{}); setPlaying(true); }
  };
  const seek = frac => {
    const a = audioRef.current;
    if (!a || !total) return;
    a.currentTime = frac * total;
    setTime(frac * total);
  };

  return (
    <div>
      {/* Hidden real audio */}
      <audio ref={audioRef} src={`/api/recordings/${recId}/audio`} preload="metadata" style={{ display:'none' }}/>

      {/* SVG Waveform */}
      <div style={{ cursor:'pointer', userSelect:'none', marginBottom:6 }}
        onClick={e => { const r=e.currentTarget.getBoundingClientRect(); seek((e.clientX-r.left)/r.width); }}>
        <svg width="100%" height="44" viewBox="0 0 320 44" preserveAspectRatio="none">
          {BARS.map((h,i) => (
            <rect key={i} x={i*4+0.5} y={(44-h)/2} width={3} height={h} rx={1.5}
              fill={(i/BARS.length) <= prog ? 'var(--accent)' : 'rgba(28,25,23,0.12)'}
              style={{ transition:'fill 0.05s' }}/>
          ))}
          {total > 0 && <line x1={prog*320} y1={0} x2={prog*320} y2={44} stroke="var(--accent)" strokeWidth={1.5}/>}
        </svg>
      </div>

      {/* Controls row */}
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <button onClick={togglePlay}
          style={{ width:28, height:28, borderRadius:'50%', border:'1px solid var(--border-mid)',
            background:'var(--surface)', cursor:'pointer', display:'flex', alignItems:'center',
            justifyContent:'center', color:'var(--text)', flexShrink:0, transition:'all 0.1s' }}
          onMouseEnter={e=>{ e.currentTarget.style.background='var(--accent)'; e.currentTarget.style.color='#fff'; e.currentTarget.style.borderColor='var(--accent)'; }}
          onMouseLeave={e=>{ e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.color='var(--text)'; e.currentTarget.style.borderColor='var(--border-mid)'; }}>
          {playing
            ? <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><rect x="0" y="0" width="3" height="12" rx="1"/><rect x="7" y="0" width="3" height="12" rx="1"/></svg>
            : <svg width="10" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,0 12,6 2,12"/></svg>}
        </button>
        <div style={{ flex:1, display:'flex', justifyContent:'space-between',
          fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'var(--faint)' }}>
          <span>{fmtT(time)}</span>
          <span>{total ? fmtT(total) : '--:--'}</span>
        </div>
      </div>
    </div>
  );
}
