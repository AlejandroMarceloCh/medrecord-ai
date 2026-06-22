import { FIELD_SECTIONS } from './constants.js';

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now()-ts)/1000));
  if (s < 60)  return 'hace ' + s + ' s';
  const m = Math.round(s/60);
  if (m < 60)  return 'hace ' + m + ' min';
  const h = Math.round(m/60);
  if (h < 24)  return 'hace ' + h + ' h';
  return new Date(ts).toLocaleDateString('es-PE', { day:'2-digit', month:'short' });
}
export function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec/60), s = Math.round(sec%60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit', hour12:false });
}
export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('es-PE', { day:'numeric', month:'short', year:'numeric' });
}
export function fmtDateTime(ts) {
  return `${fmtDate(ts)} · ${fmtClock(ts)}`;
}

// Etiqueta de día para agrupar la cola (Hoy / Ayer / fecha)
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
export function dayKey(ts)   { const d=new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
export function dayLabel(ts) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return fmtDate(ts);
}

// Edad referida en la transcripción (pragmático: el LLM no la estructura aparte)
export function recAge(rec) {
  const m = (rec.transcript || '').match(/(\d{1,3})\s*a[ñn]os/i);
  return m ? `${m[1]} años` : null;
}

// Resumen para la tarjeta: motivo de consulta estructurado, si no la transcripción sin el prefijo redundante
export function recSummary(rec) {
  const motivo = rec.fields?.anamnesis?.motivo_consulta;
  if (motivo && motivo.trim()) return motivo.trim();
  const t = (rec.transcript || '').trim();
  if (!t) return null;
  return t.replace(/^paciente[^.]*\.\s*/i, '');
}

// Aplica el diccionario médico (correcciones mal→bien) a un texto, palabra completa, sin importar mayúsculas.
export function applyDict(text, dict) {
  if (!text || !dict || !dict.length) return text;
  let out = String(text);
  for (const { wrong, right } of dict) {
    if (!wrong || !right) continue;
    const esc = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), right);
  }
  return out;
}

// % de campos completados (discrimina mejor que "N vacíos")
export function recCompletion(rec) {
  let total = 0, filled = 0;
  for (const s of FIELD_SECTIONS) for (const [fk] of s.fields) {
    total++;
    if (String(rec.fields?.[s.key]?.[fk] || '').trim()) filled++;
  }
  return total ? Math.round(filled / total * 100) : 0;
}
export function fmtToday() {
  const s = new Date().toLocaleDateString('es-PE', { weekday:'long', day:'numeric', month:'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function recName(r) {
  const n = (r.fields?.filiacion?.nombre) || (r.patient?.name);
  if (n) return n;
  if (r.patient?.dni) return 'DNI ' + r.patient.dni;
  return 'Sin identificar';
}
export function recInitials(r) {
  const n = recName(r);
  if (n.startsWith('DNI') || n === 'Sin identificar') return '··';
  return n.split(' ').filter(Boolean).map(w => w[0]).slice(0,2).join('').toUpperCase();
}
export function countEmpty(vals) {
  let empty = 0, total = 0;
  for (const s of FIELD_SECTIONS) for (const [fk] of s.fields) {
    total++;
    if (!String(vals[s.key+'.'+fk]||'').trim()) empty++;
  }
  return { empty, total };
}
export function flattenFields(fields) {
  const o = {};
  for (const s of FIELD_SECTIONS) for (const [fk] of s.fields)
    o[s.key+'.'+fk] = (fields?.[s.key]?.[fk]) || '';
  return o;
}
export function unflattenVals(vals) {
  const out = {};
  for (const s of FIELD_SECTIONS) {
    out[s.key] = {};
    for (const [fk] of s.fields) out[s.key][fk] = String(vals[s.key+'.'+fk]||'');
  }
  return out;
}

// fetch wrapper: añade Authorization si hay token, y avisa cuando la sesión caduca.
// Un 401 (sesión expirada o server reiniciado) dispara un evento que devuelve a login,
// en vez de fallar en silencio y dejar al médico en un bucle de "Reintentar".
export function apiFetch(url, opts = {}) {
  let finalOpts = opts;
  const token = typeof localStorage !== 'undefined' && localStorage.getItem('medrecord.token');
  if (token) {
    const headers = new Headers(opts.headers || {});
    headers.set('Authorization', 'Bearer ' + token);
    finalOpts = { ...opts, headers };
  }
  return fetch(url, finalOpts).then(res => {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('medrecord:unauthorized'));
    }
    return res;
  });
}

// Deterministic avatar color — warm palette, no purple, no Claude defaults
const AVATAR_PALETTE = ['#0D9488','#B45309','#0369A1','#7C2D12','#166534','#9D174D'];
export function avatarColor(initials) {
  const sum = [...(initials||'··')].reduce((a,c) => a + c.charCodeAt(0), 0);
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
}
