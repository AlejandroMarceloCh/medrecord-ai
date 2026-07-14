// level.js — nivel de audio REAL del micrófono.
//
// Antes la onda de la pantalla de grabación era una animación CSS (`@keyframes mr-wave`) y
// el cronómetro un `setInterval`: ninguno de los dos tocaba el micrófono. Si iOS le quitaba
// el micro a la app —una llamada entrante basta—, la pantalla seguía diciendo "Grabando
// 14:32" con la onda bailando, y el médico terminaba la consulta convencido de que grabó.
//
// Una onda que miente es peor que no tener onda. Esta lee el stream de verdad: si no se
// mueve, es que no está entrando sonido.
export function crearMedidor(stream, { bars = 28 } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  let ctx;
  try { ctx = new Ctx(); } catch { return null; }

  // El AudioContext nace SUSPENDIDO en móvil (política de autoplay de Safari y Chrome).
  // Sin este resume() el analizador devuelve silencio constante y la onda queda plana —
  // o sea, volveríamos a tener una onda que miente, justo lo que este sprint arregla.
  // Estamos dentro del gesto del usuario (tocó "Iniciar grabación"), así que se permite.
  if (ctx.state === 'suspended') ctx.resume().catch(() => { /* noop */ });

  const fuente = ctx.createMediaStreamSource(stream);
  const analizador = ctx.createAnalyser();
  analizador.fftSize = 1024;
  analizador.smoothingTimeConstant = 0.75;
  fuente.connect(analizador);

  const datos = new Uint8Array(analizador.frequencyBinCount);
  const niveles = new Array(bars).fill(0);
  let raf = null, mudoDesde = null;

  return {
    // Llama a fn(niveles[], rms, segundosEnSilencio) en cada frame.
    escuchar(fn) {
      const tick = () => {
        analizador.getByteTimeDomainData(datos);
        // RMS sobre la forma de onda (128 = silencio en Uint8 time-domain).
        let suma = 0;
        for (let i = 0; i < datos.length; i++) {
          const v = (datos[i] - 128) / 128;
          suma += v * v;
        }
        const rms = Math.sqrt(suma / datos.length);

        // Las barras se desplazan: la voz "corre" hacia la izquierda como un sismógrafo.
        niveles.shift();
        niveles.push(Math.min(1, rms * 4.5));   // 4.5 = ganancia para que una voz normal llene la barra

        // Umbral de silencio: por debajo de esto no hay voz, solo ruido de fondo.
        const HAY_VOZ = 0.015;
        if (rms < HAY_VOZ) {
          if (mudoDesde === null) mudoDesde = performance.now();
        } else {
          mudoDesde = null;
        }
        const silencioSeg = mudoDesde === null ? 0 : (performance.now() - mudoDesde) / 1000;

        fn(niveles.slice(), rms, silencioSeg);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },
    detener() {
      if (raf) cancelAnimationFrame(raf);
      try { fuente.disconnect(); } catch { /* noop */ }
      try { ctx.close(); } catch { /* noop */ }
    },
  };
}
