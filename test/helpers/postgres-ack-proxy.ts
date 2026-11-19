import { createConnection, createServer, Socket } from 'node:net';

/** Local fault fixture: discard the server's COMMIT completion, not the COMMIT. */
export async function postgresAckProxy(options: { beforeCommit?: boolean; upstreamPort?: number } = {}) {
  const sockets = new Set<Socket>(); let armed = false; let acknowledge!: () => void;
  const lost = new Promise<void>(resolve => { acknowledge = resolve; });
  const server = createServer(client => {
    const upstream = createConnection({ host: '127.0.0.1', port: options.upstreamPort ?? 55447 });
    sockets.add(client); sockets.add(upstream);
    let commands = Buffer.alloc(0);
    client.on('data', bytes => {
      if (!armed || !options.beforeCommit) { upstream.write(bytes); return; }
      commands = Buffer.concat([commands, bytes]);
      while (commands.length >= 5) {
        const size = commands.readInt32BE(1) + 1;
        if (size < 5 || size > 4 * 1024 * 1024) { client.destroy(); upstream.destroy(); return; }
        if (commands.length < size) return;
        const frame = commands.subarray(0, size); commands = commands.subarray(size);
        if (frame.includes(Buffer.from('COMMIT'))) { armed = false; acknowledge(); client.destroy(); upstream.destroy(); return; }
        upstream.write(frame);
      }
    });
    let pending = Buffer.alloc(0);
    upstream.on('data', bytes => {
      // Local PostgreSQL refuses SSL negotiation; forward that byte before
      // parsing normal protocol frames. This fixture never terminates real TLS.
      if (!pending.length && bytes.length === 1 && bytes[0] === 78) { client.write(bytes); return; }
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
  return { port: address.port, lost, arm: () => { armed = true; }, interrupt: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
