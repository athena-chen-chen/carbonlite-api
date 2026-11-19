import { createConnection, createServer, Socket } from 'node:net';

/** Local fault fixture: discard the server's COMMIT completion, not the COMMIT. */
export async function postgresAckProxy() {
  const sockets = new Set<Socket>(); let armed = false; let acknowledge!: () => void;
  const lost = new Promise<void>(resolve => { acknowledge = resolve; });
  const server = createServer(client => {
    const upstream = createConnection({ host: '127.0.0.1', port: 55447 });
    sockets.add(client); sockets.add(upstream);
    client.on('data', bytes => upstream.write(bytes));
    let pending = Buffer.alloc(0);
    upstream.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1) + 1;
        if (length < 5 || length > 4 * 1024 * 1024) { client.destroy(); upstream.destroy(); return; }
        if (pending.length < length) return;
        const frame = pending.subarray(0, length); pending = pending.subarray(length);
        if (armed && frame[0] === 67 && frame.subarray(5).toString() === 'COMMIT\0') {
          armed = false; acknowledge(); client.destroy(); upstream.destroy(); return;
        }
        client.write(frame);
      }
    });
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Proxy fixture unavailable');
  return { port: address.port, lost, arm: () => { armed = true; },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
