import React, { useState, useEffect } from 'react';
import { Btn } from './ui.jsx';

// LoginGate: decide si mostrar la app o pedir inicio de sesión.
// - Si hay sesión activa → app.
// - Si la auth no está activada (dev sin usuarios) → app abierta.
// - Si la auth está activada y no hay sesión → formulario de login.
export function LoginGate({ children }) {
  const [state, setState] = useState('checking'); // checking | login | ready
  const [expired, setExpired] = useState(false);
  const check = async () => {
    try {
      const d = await (await fetch('/api/whoami')).json();
      if (d.user || !d.required) setState('ready');
      else setState('login');
    } catch { setState('login'); }
  };
  useEffect(() => { check(); }, []);

  // Si una llamada devuelve 401 (sesión caduca / server reiniciado) → volver a login.
  useEffect(() => {
    const onUnauth = () => { setExpired(true); setState('login'); };
    window.addEventListener('medrecord:unauthorized', onUnauth);
    return () => window.removeEventListener('medrecord:unauthorized', onUnauth);
  }, []);

  if (state === 'checking') return null;
  if (state === 'login') return <LoginScreen expired={expired} onDone={() => { setExpired(false); setState('ready'); }} />;
  return children;
}

function LoginScreen({ onDone, expired }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!username || !password || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) { setErr('Usuario o contraseña incorrectos.'); setBusy(false); return; }
      onDone();
    } catch { setErr('No se pudo conectar con el servidor.'); setBusy(false); }
  };

  const inp = {
    width: '100%', padding: '11px 13px', borderRadius: 8, fontSize: 14.5, fontFamily: 'inherit',
    border: '1px solid var(--border-mid)', outline: 'none', background: 'var(--surface)',
    color: 'var(--text)', boxSizing: 'border-box', transition: 'border-color 0.15s',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360,
        background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 14,
        padding: '32px 28px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 4 }}>MedRecord</div>
        <div style={{ fontSize: 13.5, color: 'var(--faint)', marginBottom: 24 }}>
          {expired ? 'Tu sesión expiró. Vuelve a iniciar sesión.' : 'Inicia sesión para continuar'}
        </div>

        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
          color: 'var(--faint)', display: 'block', marginBottom: 6 }}>Usuario</label>
        <input style={{ ...inp, marginBottom: 16 }} value={username} autoFocus
          onChange={e => setUsername(e.target.value)}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border-mid)'} />

        <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
          color: 'var(--faint)', display: 'block', marginBottom: 6 }}>Contraseña</label>
        <input style={{ ...inp, marginBottom: 20 }} type="password" value={password}
          onChange={e => setPassword(e.target.value)}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border-mid)'} />

        {err && <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 16 }}>{err}</div>}

        <Btn variant="primary" type="submit" disabled={busy || !username || !password}
          style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Entrando…' : 'Entrar'}
        </Btn>
      </form>
    </div>
  );
}

// Cierra sesión y recarga. Usable desde Ajustes.
export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* noop */ }
  location.reload();
}
