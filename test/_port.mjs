// Puerto libre pedido al sistema operativo.
//
// Los tests usaban puertos fijos (3408, 3441…). Dos suites seguidas colisionaban con el
// puerto en TIME_WAIT y una fallaba sin motivo aparente: un test que falla por su propia
// infraestructura es peor que no tener test, porque enseña a ignorar el rojo.
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
