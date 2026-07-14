import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MRecorder, apiFetch } from './recorder.jsx';
import { MRQueue } from './queue.js';
import { Btn, Icon, Spinner } from './ui.jsx';

// La cola queda accesible desde `window`: es el punto por el que el arnés de "una grabación
// nunca se pierde" (test/sprint1_mobile_recovery) inspecciona y manipula IndexedDB. Al pasar
// el móvil a módulos compilados, MRQueue dejó de ser global y esa suite quedó ciega —
// pasaba 1/9 sin que nadie lo notara, porque no corría en `npm test`. Ahora sí corre.
if (typeof window !== 'undefined') window.MRQueue = MRQueue;

function computeTheme() {
  const a = 'oklch(0.52 0.20 277)', strong = 'oklch(0.46 0.20 277)', h = 270, c = 0.008;
  const L = (l, ch = c) => `oklch(${l} ${ch} ${h})`;
  return {
    '--accent': a, '--accent-strong': strong,
    '--radius': '8px', '--radius-lg': '11px', '--fs': '15.5px',
    '--bg': L(0.975), '--surface': '#ffffff', '--surface-2': L(0.982), '--surface-3': L(0.965),
    '--border': L(0.915, c * 1.2), '--border-2': L(0.86, c * 1.4),
    '--text': L(0.27, c * 2.4), '--muted': L(0.5, c * 1.8), '--faint': L(0.62, c * 1.4),
    '--ok': 'oklch(0.55 0.13 155)', '--warn': 'oklch(0.62 0.13 65)', '--danger': 'oklch(0.55 0.20 25)',
    '--on-accent': '#ffffff',
    '--accent-soft': `color-mix(in oklch, ${a} 11%, #ffffff)`,
    '--accent-line': `color-mix(in oklch, ${a} 28%, #ffffff)`,
  };
}

// Login del móvil. Sin sesión, el audio se subía con el token de device y quedaba con
// ownerId null: un médico que no sea admin NUNCA veía en la web las grabaciones que él
// mismo acababa de hacer. Con cookie de sesión, el dueño sale correcto.
function Login({ onEntrar }) {
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const entrar = async (e) => {
    e.preventDefault();
    setError(''); setEnviando(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usuario, password: clave }),
      });
      if (r.ok) { onEntrar(); return; }
      if (r.status === 429) setError('Demasiados intentos. Espera un momento y vuelve a probar.');
      else setError('Usuario o contraseña incorrectos.');
    } catch {
      setError('No se pudo conectar con el servidor. Revisa la conexión.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
      <form onSubmit={entrar} style={{ width: '100%', maxWidth: 400, margin: '0 auto',
        padding: 'max(64px, calc(env(safe-area-inset-top,0px) + 48px)) 18px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 26 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="activity" size={22} stroke={2.4} />
          </div>
          <div>
            <div style={{ fontSize: 19, fontWeight: 760, letterSpacing: '-0.02em', lineHeight: 1.1 }}>MedRecord AI</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Entra para grabar consultas</div>
          </div>
        </div>

        <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}
          htmlFor="mr-user">Usuario</label>
        <input id="mr-user" className="mr-input" value={usuario} onChange={e => setUsuario(e.target.value)}
          autoCapitalize="none" autoComplete="username" autoCorrect="off" />

        <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)',
          margin: '14px 0 6px' }} htmlFor="mr-pass">Contraseña</label>
        <input id="mr-pass" className="mr-input" type="password" value={clave}
          onChange={e => setClave(e.target.value)} autoComplete="current-password" />

        {error && (
          <div role="alert" style={{ marginTop: 14, padding: '11px 13px', borderRadius: 10, fontSize: 13,
            background: 'color-mix(in oklch, var(--danger) 10%, transparent)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 28%, transparent)' }}>{error}</div>
        )}

        <button type="submit" className="mr-btn" disabled={enviando || (!usuario && !clave)}
          style={{ height: 52, width: '100%', marginTop: 18, fontSize: 16, gap: 9,
            background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid transparent',
            borderRadius: 'var(--radius-lg)', opacity: (enviando || (!usuario && !clave)) ? 0.45 : 1,
            cursor: enviando ? 'wait' : 'pointer' }}>
          {enviando ? <><Spinner size={15} color="#fff" /> Entrando…</> : 'Entrar'}
        </button>
      </form>
    </div>
  );
}

function MobileRoot() {
  const [estado, setEstado] = useState('checking');   // checking | login | listo

  const revisar = async () => {
    try {
      const r = await apiFetch('/api/whoami');
      const d = await r.json();
      // Sin auth configurada (dev), o ya hay sesión/dispositivo autorizado → directo a grabar.
      if (!d.required || d.user || d.device) setEstado('listo');
      else setEstado('login');
    } catch {
      // Sin red no podemos preguntar. La app tiene que abrir igual: la cola offline es su
      // razón de ser, y bloquear la grabación por no poder validar sería el peor resultado.
      setEstado('listo');
    }
  };
  useEffect(() => { revisar(); }, []);

  const vars = computeTheme();
  return (
    <div className="mr-root" style={{ ...vars, height: '100dvh', width: '100%', overflow: 'hidden',
      position: 'relative', background: 'var(--bg)' }}>
      {estado === 'checking' ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={22} color="var(--faint)" />
        </div>
      ) : estado === 'login' ? (
        <Login onEntrar={() => setEstado('listo')} />
      ) : (
        <MRecorder />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<MobileRoot />);

// Service worker: cachea el shell para que la app ABRA sin conexión. Antes prometía
// "tus grabaciones se suben solas al volver" pero, sin red, la app ni siquiera cargaba:
// React y Babel venían de unpkg, así que la pantalla salía en blanco.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin SW la app sigue funcionando online */ });
  });
}
