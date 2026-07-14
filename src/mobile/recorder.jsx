import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Icon, Btn, Spinner, SectionLabel, ConfirmDestructivo } from './ui.jsx';
import { MRQueue } from './queue.js';
import { crearMedidor } from './level.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;

// MediaRecorder entrega un trozo cada TROZO_MS y lo escribimos a IndexedDB al vuelo.
// Sin esto, 20 minutos de consulta viven en RAM y si iOS mata la pestaña se pierde todo.
const TROZO_MS = 5000;
const MAX_TRIES = 6;
const AVISO_DURACION_MIN = 45;   // grabación olvidada corriendo

export function apiFetch(url, opts = {}) {
  const token = localStorage.getItem('medrecord.token');
  if (!token) return fetch(url, { credentials: 'same-origin', ...opts });
  const headers = new Headers(opts.headers || {});
  headers.set('Authorization', 'Bearer ' + token);
  return fetch(url, { credentials: 'same-origin', ...opts, headers });
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const c of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
function extFor(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('aac')) return 'aac';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

const PHASE = {
  queued:       { c: 'var(--muted)',         t: 'En cola…',                   spin: true },
  uploading:    { c: 'var(--muted)',         t: 'Subiendo…',                  spin: true },
  transcribing: { c: 'var(--accent-strong)', t: 'Transcribiendo…',            spin: true },
  filling:      { c: 'var(--accent-strong)', t: 'Completando campos…',        spin: true },
  ready:        { c: 'var(--ok)',            t: 'Listo · revísalo en la web', spin: false, icon: 'checkCircle' },
  upload_error: { c: 'var(--danger)',        t: 'No se pudo subir',           spin: false },
  proc_error:   { c: 'var(--danger)',        t: 'No se pudo procesar',        spin: false },
};
const STATUS_PHASE = { received: 'transcribing', queued: 'transcribing', processing: 'transcribing',
  filling: 'filling', done: 'ready', reviewed: 'ready', error: 'proc_error' };
const TERMINAL = new Set(['ready', 'proc_error']);

const RECENT_KEY = 'mr.recentPatients';
function loadRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function pushRecent(p) {
  if (!p.name) return;
  const list = loadRecent().filter(x => !(x.name === p.name && x.dni === p.dni));
  list.unshift({ name: p.name, dni: p.dni || '' });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch { /* noop */ }
}

function PhaseRow({ phase }) {
  const s = PHASE[phase] || PHASE.uploading;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5,
      fontWeight: 600, color: s.c, flexShrink: 0 }}>
      {s.spin && <Spinner size={13} />}
      {s.icon && <Icon name={s.icon} size={15} />}
      {s.t}
    </span>
  );
}

// Onda REAL: cada barra es el nivel medido del micrófono, no una animación.
function Waveform({ niveles, pausado }) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 5, height: 130, color: 'color-mix(in oklch, var(--accent) 80%, #fff)', opacity: pausado ? 0.3 : 1 }}>
      {niveles.map((n, i) => (
        <div key={i} style={{ width: 4, borderRadius: 4, background: 'currentColor',
          height: Math.max(4, n * 120), transition: 'height 60ms linear' }} />
      ))}
    </div>
  );
}

export function MRecorder() {
  const [name, setName] = useState('');
  const [dni, setDni] = useState('');
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState('idle');          // idle | recording
  const [pausado, setPausado] = useState(false);
  const [sec, setSec] = useState(0);
  const [niveles, setNiveles] = useState(() => new Array(28).fill(0));
  const [sinSonido, setSinSonido] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(navigator.onLine !== false);
  const [recent, setRecent] = useState(loadRecent);
  const [confirmarDescarte, setConfirmarDescarte] = useState(false);
  const [recuperado, setRecuperado] = useState(null);   // borrador huérfano encontrado al abrir

  const recRef = useRef(null);
  const streamRef = useRef(null);
  const metaRef = useRef(null);
  const medidorRef = useRef(null);
  const draftRef = useRef(null);      // id del borrador en curso
  const seqRef = useRef(0);
  const descartarRef = useRef(false); // el usuario pidió descartar: al parar, no encolar
  const cortadoRef = useRef('');      // motivo del corte (micrófono perdido): sobrevive al encolado
  const cerrandoRef = useRef(false);  // guard: 'Detener' y la caída del micro pueden dispararse a la vez
  const t0Ref = useRef(0);
  const wakeRef = useRef(null);
  const wsRef = useRef(null);
  const wsBackoff = useRef(1000);
  const wsStop = useRef(false);
  const timers = useRef({});
  const itemsRef = useRef([]);
  itemsRef.current = items;

  const dniValid = dni === '' || dni.length === 8;
  // Para grabar solo hace falta el consentimiento. El nombre se puede poner después:
  // el flujo real es "entra el paciente → grabo", no "tipeo el nombre completo con el
  // paciente esperando". La web ya tolera consultas sin identificar.
  const canRecord = consent && dniValid;
  const secure = typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  const pendientes = items.filter(it => !TERMINAL.has(it.phase)).length;

  // El cronómetro cuenta tiempo REAL transcurrido, no ticks de setInterval (que iOS
  // throttlea en segundo plano y haría que el contador mienta sobre la duración).
  useEffect(() => {
    if (phase !== 'recording' || pausado) return;
    const id = setInterval(() => setSec((Date.now() - t0Ref.current) / 1000), 250);
    return () => clearInterval(id);
  }, [phase, pausado]);

  const acquireWake = async () => {
    try { if (navigator.wakeLock) wakeRef.current = await navigator.wakeLock.request('screen'); }
    catch { /* noop */ }
  };
  const releaseWake = () => {
    try { wakeRef.current && wakeRef.current.release(); } catch { /* noop */ }
    wakeRef.current = null;
  };
  useEffect(() => {
    const onVis = () => { if (phase === 'recording' && document.visibilityState === 'visible') acquireWake(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [phase]);

  const syncItem     = useCallback((localId, patch)  => setItems(l => l.map(it => it.localId === localId ? { ...it, ...patch } : it)), []);
  const syncByServer = useCallback((serverId, patch) => setItems(l => l.map(it => it.serverId === serverId ? { ...it, ...patch } : it)), []);

  const syncStatusOnce = useCallback(async (serverId) => {
    try {
      const r = await apiFetch('/api/recordings/' + serverId);
      if (!r.ok) return;
      const d = await r.json();
      const ph = STATUS_PHASE[d.status];
      if (!ph) return;
      syncByServer(serverId, { phase: ph, msg: d.error || '' });
      if (TERMINAL.has(ph)) {
        const it = itemsRef.current.find(x => x.serverId === serverId);
        if (it) MRQueue.del(it.localId).catch(() => {});
      }
    } catch { /* noop */ }
  }, [syncByServer]);

  const ensureWs = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === 0 || wsRef.current.readyState === 1)) return;
    let ws;
    const tk = localStorage.getItem('medrecord.token');
    const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host
      + (tk ? '?token=' + encodeURIComponent(tk) : '');
    try { ws = new WebSocket(url); } catch { return; }
    wsRef.current = ws;
    ws.onopen = () => {
      wsBackoff.current = 1000;
      for (const it of itemsRef.current) if (it.serverId && !TERMINAL.has(it.phase)) syncStatusOnce(it.serverId);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const r = m.recording; if (!r || !r.id) return;
      const ph = STATUS_PHASE[r.status]; if (!ph) return;
      syncByServer(r.id, { phase: ph, msg: r.error || '' });
      if (TERMINAL.has(ph)) {
        const it = itemsRef.current.find(x => x.serverId === r.id);
        if (it) MRQueue.del(it.localId).catch(() => {});
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    ws.onclose = () => {
      wsRef.current = null;
      if (wsStop.current) return;
      setTimeout(ensureWs, wsBackoff.current);
      wsBackoff.current = Math.min(10000, wsBackoff.current * 2);
    };
  }, [syncByServer, syncStatusOnce]);

  const tryUpload = useCallback(async (localId) => {
    let rec; try { rec = await MRQueue.get(localId); } catch { return; }
    if (!rec) return;
    if (rec.uploaded) { ensureWs(); syncStatusOnce(rec.serverId); return; }
    if (navigator.onLine === false) { syncItem(localId, { phase: 'queued', msg: 'sin conexión' }); return; }

    syncItem(localId, { phase: 'uploading', msg: '' });
    try {
      const fd = new FormData();
      fd.append('patientName', rec.meta.name);
      fd.append('patientDni', rec.meta.dni);
      fd.append('consent', rec.meta.consent ? 'true' : 'false');
      fd.append('durationSec', String(Math.round(rec.dur)));
      fd.append('audio', rec.blob, `consulta.${extFor(rec.type)}`);
      const res = await apiFetch('/api/recordings', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('upload');
      const data = await res.json().catch(() => ({}));
      const serverId = data.id || localId;
      await MRQueue.put({ ...rec, blob: undefined, uploaded: true, serverId }).catch(() => {});
      syncItem(localId, { serverId, phase: 'transcribing', msg: '' });
      ensureWs(); syncStatusOnce(serverId);
    } catch {
      const tries = (rec.tries || 0) + 1;
      await MRQueue.put({ ...rec, tries }).catch(() => {});
      if (tries < MAX_TRIES && navigator.onLine !== false) {
        const delay = Math.min(30000, 1000 * Math.pow(2, tries - 1));
        // El médico tiene que ver que estamos reintentando y cuántas veces van.
        syncItem(localId, { phase: 'queued', msg: `reintentando… (${tries} de ${MAX_TRIES})` });
        clearTimeout(timers.current[localId]);
        timers.current[localId] = setTimeout(() => tryUpload(localId), delay);
      } else {
        syncItem(localId, { phase: 'upload_error', msg: 'toca Reintentar' });
      }
    }
  }, [ensureWs, syncItem, syncStatusOnce]);

  const enqueue = useCallback(async (blob, type, meta, dur, draftId = null) => {
    const localId = 'L' + Date.now() + Math.floor(Math.random() * 1000);
    const rec = { localId, serverId: null, uploaded: false, blob, type, meta, dur, draftId,
      createdAt: Date.now(), tries: 0 };
    try { await MRQueue.put(rec); } catch { /* noop */ }
    setItems(l => [{ localId, serverId: null, displayName: meta.name || 'Sin identificar',
      dur, phase: 'queued', msg: '' }, ...l]);
    pushRecent(meta); setRecent(loadRecent());
    tryUpload(localId);
  }, [tryUpload]);

  const resumeAll = useCallback(async () => {
    let recs; try { recs = await MRQueue.all(); } catch { return; }
    if (!recs || !recs.length) return;
    recs.sort((a, b) => b.createdAt - a.createdAt);
    setItems(l => {
      const known = new Set(l.map(i => i.localId));
      const restored = recs.filter(r => !known.has(r.localId)).map(r => ({
        localId: r.localId, serverId: r.serverId || null,
        displayName: r.meta.name || 'Sin identificar',
        dur: r.dur, phase: r.uploaded ? 'transcribing' : 'queued', msg: '',
      }));
      return [...restored, ...l];
    });
    for (const r of recs) {
      if (r.uploaded) { ensureWs(); syncStatusOnce(r.serverId); }
      else tryUpload(r.localId);
    }
  }, [ensureWs, syncStatusOnce, tryUpload]);

  // Al abrir: ¿quedó una grabación a medias? (la app se cerró o iOS la mató grabando)
  const buscarBorradores = useCallback(async () => {
    try {
      // Primero la basura: trozos de consultas que YA se encolaron (la app murió entre el
      // enqueue y el borrado). Si no, el audio de cada consulta se acumula para siempre en
      // el teléfono, y es PII de paciente.
      await MRQueue.limpiarHuerfanos().catch(() => {});
      const ds = await MRQueue.drafts();
      const d = ds.find(x => x.chunks.length > 0);
      if (d) setRecuperado(d);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    wsStop.current = false;
    ensureWs();
    resumeAll();
    buscarBorradores();
    const onOnline  = () => { setOnline(true); resumeAll(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      wsStop.current = true;
      try { wsRef.current && wsRef.current.close(); } catch { /* noop */ }
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, []); // eslint-disable-line

  // Cierra la grabación: limpia medidor, tracks y wake lock. Devuelve el blob ensamblado.
  const cerrarGrabacion = useCallback(async (draftId, type) => {
    if (medidorRef.current) { medidorRef.current.detener(); medidorRef.current = null; }
    (streamRef.current ? streamRef.current.getTracks() : []).forEach(t => t.stop());
    streamRef.current = null;
    releaseWake();
    const chunks = await MRQueue.chunksOf(draftId);
    return new Blob(chunks.map(c => c.blob), { type });
  }, []);

  const detenerYEncolar = useCallback(async () => {
    // "Detener" y la caída del micrófono pueden dispararse casi a la vez (el paciente
    // cuelga una llamada justo cuando el médico termina). Sin este guard, las dos rutas
    // ensamblaban el mismo audio y lo encolaban DOS VECES: dos consultas duplicadas en la
    // web, ambas transcritas por separado. El chequeo va antes de cualquier await.
    if (cerrandoRef.current) return;
    cerrandoRef.current = true;

    const draftId = draftRef.current;
    if (!draftId) { cerrandoRef.current = false; return; }
    draftRef.current = null;

    const rec = recRef.current;
    const type = (rec && rec.mimeType) || 'audio/webm';
    const dur = (Date.now() - t0Ref.current) / 1000;
    const meta = metaRef.current;
    setPhase('idle'); setPausado(false); setSinSonido(false);

    const blob = await cerrarGrabacion(draftId, type);
    await MRQueue.delChunks(draftId).catch(() => {});

    if (descartarRef.current) {
      descartarRef.current = false; cortadoRef.current = ''; cerrandoRef.current = false;
      setSec(0); return;
    }

    // Un blob vacío NO se descarta en silencio: antes la UI volvía al formulario limpio,
    // idéntica a un éxito, y el médico se iba creyendo que la consulta se había enviado.
    if (!blob || blob.size === 0) {
      setError('La grabación quedó vacía y no se envió. Revisa el micrófono y vuelve a grabar.');
      setSec(0);
      cerrandoRef.current = false;
      return;   // el nombre y el consentimiento se conservan: puede reintentar de una
    }
    enqueue(blob, type, meta, dur, draftId);
    setName(''); setDni(''); setConsent(false); setSec(0);
    // Si la grabación se cortó sola (micrófono perdido), el aviso TIENE que sobrevivir al
    // encolado: antes lo borraba este mismo setError('') y el médico se quedaba sin saber
    // por qué terminó, viendo solo un audio más corto de lo que esperaba.
    setError(cortadoRef.current || '');
    cortadoRef.current = '';
    cerrandoRef.current = false;
  }, [cerrarGrabacion, enqueue]);

  const startRecording = async () => {
    setError(''); setSinSonido(false); cortadoRef.current = ''; cerrandoRef.current = false;
    if (!secure) {
      setError('La grabación necesita una conexión segura (https). Abre la app por el enlace https en tu celular.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);

      const draftId = 'D' + Date.now();
      draftRef.current = draftId;
      seqRef.current = 0;
      descartarRef.current = false;
      metaRef.current = { name: name.trim(), dni: dni.trim(), consent: true };

      // Cada trozo va a IndexedDB apenas llega. Si la app muere, esto es lo que queda.
      const tipoReal = rec.mimeType || mime || 'audio/webm';
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) {
          MRQueue.putChunk(draftId, seqRef.current++, e.data, metaRef.current, tipoReal).catch(() => {});
        }
      };
      // El micrófono se puede caer sin avisarle a la UI: una llamada entrante, otra app que
      // lo toma, el usuario revocando el permiso. Antes nadie escuchaba estos eventos y la
      // pantalla seguía diciendo "Grabando" sobre el vacío.
      rec.onerror = () => {
        cortadoRef.current = 'Se interrumpió la grabación. Lo grabado hasta ahora se guardó; vuelve a grabar el resto.';
        detenerYEncolar();
      };
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          cortadoRef.current = 'Se cortó el micrófono (¿una llamada entrante?). Lo grabado hasta ahora se guardó.';
          detenerYEncolar();
        };
      }
      rec.onpause  = () => setPausado(true);
      rec.onresume = () => setPausado(false);

      t0Ref.current = Date.now();
      setSec(0);
      rec.start(TROZO_MS);
      recRef.current = rec;
      setPhase('recording');
      acquireWake();

      // La onda ahora sale del micrófono. Si no se mueve, no está entrando sonido.
      const medidor = crearMedidor(stream);
      medidorRef.current = medidor;
      if (medidor) {
        medidor.escuchar((ns, _rms, silencioSeg) => {
          setNiveles(ns);
          setSinSonido(silencioSeg > 6);   // 6 s sin una sola voz: algo está mal
        });
      }
    } catch (err) {
      setError(err && err.name === 'NotAllowedError'
        ? 'Denegaste el permiso del micrófono. Actívalo en los ajustes del navegador y vuelve a intentar.'
        : 'No se pudo acceder al micrófono. Cierra otras apps que lo estén usando e intenta de nuevo.');
    }
  };

  const togglePausa = () => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      if (rec.state === 'recording') { rec.pause(); t0Ref.current = Date.now() - sec * 1000; }
      else if (rec.state === 'paused') { rec.resume(); t0Ref.current = Date.now() - sec * 1000; }
    } catch { /* noop */ }
  };

  const stopRecording = () => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') { rec.onstop = () => detenerYEncolar(); rec.stop(); }
    else detenerYEncolar();
  };

  const descartar = () => {
    descartarRef.current = true;
    setConfirmarDescarte(false);
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') { rec.onstop = () => detenerYEncolar(); rec.stop(); }
    else detenerYEncolar();
  };

  useEffect(() => {
    const h = (e) => { if (phase === 'recording') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [phase]);

  // ── Pantalla de grabación ──
  if (phase === 'recording') {
    const largo = sec > AVISO_DURACION_MIN * 60;
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#0c0e12', color: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '100%', display: 'flex', justifyContent: 'center',
          padding: 'calc(env(safe-area-inset-top, 0px) + 40px) 18px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: 0.85 }}>
            <span className={pausado ? '' : 'mr-dot'} style={{ width: 8, height: 8, borderRadius: 8,
              background: pausado ? 'rgba(255,255,255,0.4)' : 'oklch(0.62 0.2 25)' }} />
            <span style={{ fontSize: 13, letterSpacing: '0.04em', color: 'rgba(255,255,255,0.75)' }}>
              {pausado ? 'En pausa' : 'Grabando'}
            </span>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 26 }}>
          <div style={{ fontSize: 18, fontWeight: 650 }}>{name.trim() || 'Sin identificar'}</div>
          <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>Consulta en curso</div>
        </div>

        {sinSonido && !pausado && (
          <div role="alert" style={{ marginTop: 16, padding: '10px 14px', borderRadius: 10, fontSize: 13,
            maxWidth: 330, textAlign: 'center', display: 'flex', alignItems: 'center', gap: 8,
            background: 'oklch(0.62 0.13 65 / 0.22)', color: '#fff' }}>
            <Icon name="warn" size={16} />
            No estamos captando sonido. Revisa el micrófono.
          </div>
        )}
        {largo && (
          <div style={{ marginTop: 12, padding: '9px 14px', borderRadius: 10, fontSize: 12.5,
            background: 'rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.85)' }}>
            Llevas más de {AVISO_DURACION_MIN} minutos grabando. ¿Sigue la consulta?
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', width: '100%' }}>
          <Waveform niveles={niveles} pausado={pausado} />
          <div className="mono" style={{ fontSize: 30, fontWeight: 500, marginTop: 30, letterSpacing: '0.02em' }}>
            {fmt(sec)}
          </div>
        </div>

        <div style={{ paddingBottom: 'calc(40px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', alignItems: 'center', gap: 22 }}>
          <button type="button" onClick={() => setConfirmarDescarte(true)} aria-label="Descartar grabación"
            style={{ width: 56, height: 56, borderRadius: 999, border: '1px solid rgba(255,255,255,0.22)',
              background: 'transparent', color: 'rgba(255,255,255,0.75)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Icon name="trash" size={21} />
          </button>

          <button type="button" onClick={stopRecording} aria-label="Terminar y enviar"
            style={{ width: 78, height: 78, borderRadius: 999, border: '5px solid rgba(255,255,255,0.16)',
              background: 'oklch(0.58 0.2 25)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer' }}>
            <Icon name="stop" size={30} fill="#fff" stroke={0} style={{ color: '#fff' }} />
          </button>

          <button type="button" onClick={togglePausa} aria-label={pausado ? 'Reanudar' : 'Pausar'}
            style={{ width: 56, height: 56, borderRadius: 999, border: '1px solid rgba(255,255,255,0.22)',
              background: 'transparent', color: 'rgba(255,255,255,0.9)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Icon name={pausado ? 'play' : 'pause'} size={21} />
          </button>
        </div>
        <div style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))', marginTop: -22 }}>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)' }}>Toca el cuadrado para terminar y enviar</span>
        </div>

        {confirmarDescarte && (
          <ConfirmDestructivo
            titulo="¿Descartar esta grabación?"
            detalle={`Se elimina el audio de ${name.trim() || 'esta consulta'} (${fmt(sec)}). No se puede deshacer y no se enviará a la historia clínica.`}
            textoBoton="Descartar"
            onConfirmar={descartar}
            onCancelar={() => setConfirmarDescarte(false)}
          />
        )}
      </div>
    );
  }

  // ── Pantalla principal ──
  return (
    <div className="mr-scroll" style={{ position: 'absolute', inset: 0, overflowY: 'auto',
      display: 'flex', flexDirection: 'column' }}>
      <div style={{ width: '100%', maxWidth: 480, margin: '0 auto', padding: '0 18px',
        display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ height: 'max(40px, calc(env(safe-area-inset-top, 0px) + 16px))', flexShrink: 0 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 20 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="activity" size={22} stroke={2.4} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 19, fontWeight: 760, letterSpacing: '-0.02em', lineHeight: 1.1 }}>Grabar consulta</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>MedRecord AI</div>
          </div>
          {/* Lo que está en cola tiene que verse ARRIBA, no enterrado bajo el botón. */}
          {pendientes > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px',
              borderRadius: 999, fontSize: 12.5, fontWeight: 650,
              background: 'color-mix(in oklch, var(--warn) 14%, transparent)', color: 'var(--warn)',
              border: '1px solid color-mix(in oklch, var(--warn) 30%, transparent)' }}>
              <Spinner size={11} />
              {pendientes} por subir
            </div>
          )}
        </div>

        {!online && (
          <div style={{ marginBottom: 14, padding: '10px 13px', borderRadius: 11, fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'color-mix(in oklch, var(--warn) 12%, transparent)', color: 'var(--warn)',
            border: '1px solid color-mix(in oklch, var(--warn) 30%, transparent)' }}>
            <Icon name="warn" size={15} />
            Sin conexión. Tus grabaciones se guardan y se suben solas al volver.
          </div>
        )}

        {recuperado && (
          <div className="mr-card" style={{ marginBottom: 14, padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 680, marginBottom: 4 }}>Se encontró una grabación a medias</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45, marginBottom: 12 }}>
              La app se cerró mientras grababas a {recuperado.meta?.name || 'un paciente'}. El audio se guardó.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn full style={{ height: 44, fontSize: 14 }} onClick={async () => {
                // El mimeType sale de los propios trozos: en iPhone esto es mp4, no webm.
                // Hardcodearlo subía bytes mp4 con extensión .webm y Whisper recibía un
                // contenedor renombrado — audio intranscribible, justo el que veníamos a salvar.
                const type = recuperado.type || 'audio/webm';
                const blob = new Blob(recuperado.chunks.map(c => c.blob), { type });
                const dur = recuperado.dur || 0;
                const meta = recuperado.meta;
                await MRQueue.delChunks(recuperado.draftId).catch(() => {});
                setRecuperado(null);
                // Sin consentimiento registrado NO se sube: fabricarlo aquí sería inventar
                // la base legal del procesamiento. El servidor lo rechaza igual (400).
                if (!meta || !meta.consent) {
                  setError('Esa grabación no tiene el consentimiento registrado y no se puede procesar.');
                  return;
                }
                if (blob.size > 0) enqueue(blob, type, meta, dur, recuperado.draftId);
              }}>Enviar lo grabado</Btn>
              <Btn variant="ghost" full style={{ height: 44, fontSize: 14 }} onClick={async () => {
                await MRQueue.delChunks(recuperado.draftId).catch(() => {});
                setRecuperado(null);
              }}>Descartar</Btn>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl} htmlFor="mr-name">
              Nombre del paciente <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input id="mr-name" className="mr-input" value={name} onChange={e => setName(e.target.value)}
              autoCapitalize="words" autoComplete="off" autoCorrect="off" placeholder="Ej. María Pérez" />
            {recent.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {recent.map((p, i) => (
                  <button key={i} type="button" onClick={() => { setName(p.name); setDni(p.dni || ''); }}
                    style={{ height: 44, padding: '0 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                      cursor: 'pointer', background: 'var(--surface-3)', color: 'var(--muted)',
                      border: '1px solid var(--border-2)', maxWidth: '100%', whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label style={lbl} htmlFor="mr-dni">
              DNI <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input id="mr-dni" className="mr-input" value={dni}
              onChange={e => setDni(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric" maxLength={8} placeholder="Ej. 70123456" />
            {dni !== '' && !dniValid && (
              <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 6 }}>El DNI peruano tiene 8 dígitos.</div>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 14, padding: '12px 14px', borderRadius: 12, fontSize: 13.5,
            lineHeight: 1.45, background: 'color-mix(in oklch, var(--danger) 10%, transparent)',
            color: 'var(--danger)', border: '1px solid color-mix(in oklch, var(--danger) 28%, transparent)' }}>
            {error}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 18,
          cursor: 'pointer', minHeight: 44, padding: '8px 0' }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}
            style={{ width: 24, height: 24, marginTop: 0, flexShrink: 0, accentColor: 'var(--accent)' }} />
          <span style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--text)' }}>
            El paciente dio su consentimiento para grabar la consulta y procesarla con fines de documentación clínica.
          </span>
        </label>

        <Btn full icon="mic" onClick={startRecording} disabled={!canRecord}
          style={{ marginTop: 12, borderRadius: 'var(--radius-lg)', height: 56 }}>
          Iniciar grabación
        </Btn>
        {!canRecord && !error && (
          <div style={{ fontSize: 12.5, color: 'var(--faint)', textAlign: 'center', marginTop: 8 }}>
            {!consent ? 'Marca el consentimiento del paciente para empezar.' : 'Revisa el DNI.'}
          </div>
        )}

        {items.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <SectionLabel>Audios de esta sesión</SectionLabel>
            {items.map(it => (
              <div key={it.localId} className="mr-card" style={{ display: 'flex', alignItems: 'center',
                gap: 12, padding: 13, marginBottom: 8 }}>
                <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--accent-soft)',
                  color: 'var(--accent-strong)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="activity" size={20} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden',
                    textOverflow: 'ellipsis' }}>{it.displayName}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {fmt(it.dur)} de audio{it.msg ? ' · ' + it.msg : ''}
                  </div>
                </div>
                {it.phase === 'upload_error'
                  ? <button type="button" onClick={() => tryUpload(it.localId)} className="mr-btn"
                      style={{ height: 44, padding: '0 14px', gap: 6, fontSize: 13.5, background: 'transparent',
                        color: 'var(--accent-strong)', border: '1px solid var(--accent-line)' }}>
                      <Icon name="refresh" size={15} /> Reintentar
                    </button>
                  : <PhaseRow phase={it.phase} />}
              </div>
            ))}
          </div>
        )}
        <div style={{ height: 'calc(40px + env(safe-area-inset-bottom, 0px))' }} />
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 };
