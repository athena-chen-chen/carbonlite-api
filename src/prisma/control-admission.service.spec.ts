import { ControlAdmissionService } from './control-admission.service';

describe('control admission ownership', () => {
  function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
  it('admits one request and never queues a second', () => {
    const service = new ControlAdmissionService(), permit = service.acquire();
    expect(() => service.acquire()).toThrow(); permit.endResponse(); service.acquire().endResponse();
  });
  it('retains admission after a timed-out response until underlying work settles', async () => {
    const service = new ControlAdmissionService(), permit = service.acquire(), gate = barrier();
    permit.track(gate.promise); permit.endResponse();
    expect(() => service.acquire()).toThrow(); gate.release(); await permit.done;
    service.acquire().endResponse();
  });
  it('observes rejected work without leaking a permit', async () => {
    const service = new ControlAdmissionService(), permit = service.acquire();
    permit.track(Promise.reject(new Error('synthetic failure'))); permit.endResponse(); await permit.done;
    service.acquire().endResponse();
  });
  it('shutdown rejects admission and waits for in-flight work', async () => {
    const service = new ControlAdmissionService(), permit = service.acquire(), gate = barrier();
    permit.track(gate.promise); permit.endResponse(); let drained = false;
    const closing = service.close().then(() => { drained = true; });
    expect(() => service.acquire()).toThrow(); expect(drained).toBe(false);
    gate.release(); await closing; expect(drained).toBe(true);
  });
});
