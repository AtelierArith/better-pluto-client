import * as assert from 'assert';
import { PlutoServer, type Scheduler, type ProcessRunner, type KernelTransportFactory, type KernelTransport } from '../PlutoServer';

class NoopScheduler implements Scheduler {
    setTimeout(_handler: () => void, _ms: number): NodeJS.Timeout { return 1 as unknown as NodeJS.Timeout; }
    clearTimeout(_handle: NodeJS.Timeout): void {}
    setInterval(_handler: () => void, _ms: number): NodeJS.Timeout { return 1 as unknown as NodeJS.Timeout; }
    clearInterval(_handle: NodeJS.Timeout): void {}
}

class NoopProcessRunner implements ProcessRunner {
    spawnJulia(_juliaCode: string) {
        return {
            stdout: undefined,
            stderr: undefined,
            on: () => undefined,
            kill: () => true,
        } as unknown as import('child_process').ChildProcess;
    }
}

class NoopTransport implements KernelTransport {
    onOpen(_handler: () => void): void {}
    onMessage(_handler: (data: Buffer | ArrayBuffer) => void): void {}
    onError(_handler: (error: Error) => void): void {}
    onClose(_handler: () => void): void {}
    send(_data: Buffer): void {}
    close(): void {}
    readyState(): number { return 0; }
}

class NoopTransportFactory implements KernelTransportFactory {
    async create(_url: string): Promise<KernelTransport> {
        return new NoopTransport();
    }
}

/**
 * A controllable scheduler that captures scheduled callbacks for manual triggering.
 */
class ControllableScheduler implements Scheduler {
    private timeouts = new Map<NodeJS.Timeout, { handler: () => void; ms: number }>();
    private nextId = 100;

    setTimeout(handler: () => void, ms: number): NodeJS.Timeout {
        const id = this.nextId++ as unknown as NodeJS.Timeout;
        this.timeouts.set(id, { handler, ms });
        return id;
    }
    clearTimeout(handle: NodeJS.Timeout): void {
        this.timeouts.delete(handle);
    }
    setInterval(_handler: () => void, _ms: number): NodeJS.Timeout {
        return this.nextId++ as unknown as NodeJS.Timeout;
    }
    clearInterval(_handle: NodeJS.Timeout): void {}

    /** Fire all pending timeouts (useful for simulating timer expiry). */
    fireAll(): void {
        const entries = Array.from(this.timeouts.entries());
        this.timeouts.clear();
        for (const [, { handler }] of entries) {
            handler();
        }
    }

    /** Fire timeouts registered with a specific ms value. */
    fireByMs(ms: number): void {
        for (const [id, entry] of this.timeouts.entries()) {
            if (entry.ms === ms) {
                this.timeouts.delete(id);
                entry.handler();
            }
        }
    }

    get pendingCount(): number {
        return this.timeouts.size;
    }
}

/**
 * A process runner that tracks whether kill() was called.
 */
class TrackingProcessRunner implements ProcessRunner {
    killed = false;
    errorHandler: ((err: Error) => void) | null = null;
    exitHandler: ((code: number | null) => void) | null = null;
    stdoutDataHandler: ((data: Buffer) => void) | null = null;
    stderrDataHandler: ((data: Buffer) => void) | null = null;

    spawnJulia(_juliaCode: string) {
        const self = this;
        return {
            stdout: {
                on(event: string, handler: (data: Buffer) => void) {
                    if (event === 'data') { self.stdoutDataHandler = handler; }
                },
            },
            stderr: {
                on(event: string, handler: (data: Buffer) => void) {
                    if (event === 'data') { self.stderrDataHandler = handler; }
                },
            },
            on(event: string, handler: (...args: unknown[]) => void) {
                if (event === 'error') { self.errorHandler = handler as (err: Error) => void; }
                if (event === 'exit') { self.exitHandler = handler as (code: number | null) => void; }
            },
            kill() { self.killed = true; return true; },
        } as unknown as import('child_process').ChildProcess;
    }
}

/**
 * A controllable transport that lets tests trigger onOpen / onError / onClose.
 */
class ControllableTransport implements KernelTransport {
    private openHandler: (() => void) | null = null;
    private errorHandler: ((err: Error) => void) | null = null;
    private closeHandler: (() => void) | null = null;
    closed = false;

    onOpen(handler: () => void): void { this.openHandler = handler; }
    onMessage(_handler: (data: Buffer | ArrayBuffer) => void): void {}
    onError(handler: (error: Error) => void): void { this.errorHandler = handler; }
    onClose(handler: () => void): void { this.closeHandler = handler; }
    send(_data: Buffer): void {}
    close(): void { this.closed = true; }
    readyState(): number { return 1; }

    triggerOpen(): void { this.openHandler?.(); }
    triggerError(err: Error): void { this.errorHandler?.(err); }
    triggerClose(): void { this.closeHandler?.(); }
}

/** Yield to the microtask queue so that awaited promises inside start() can proceed. */
function tick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

suite('PlutoServer startup error cleanup (#71)', () => {
    test('timeout kills the Julia process', async () => {
        const scheduler = new ControllableScheduler();
        const processRunner = new TrackingProcessRunner();

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
            portFinder: async () => 9999,
        });

        const startPromise = server.start('/fake/notebook.jl');

        // Let portFinder resolve and start() register its callbacks
        await tick();

        // Simulate startup timeout (120000ms)
        scheduler.fireByMs(120000);

        await assert.rejects(startPromise, /timeout/i);
        assert.strictEqual(processRunner.killed, true, 'Julia process should be killed on timeout');

        server.stop();
    });

    test('process error kills the Julia process', async () => {
        const scheduler = new ControllableScheduler();
        const processRunner = new TrackingProcessRunner();

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
            portFinder: async () => 9999,
        });

        // Add error listener to prevent EventEmitter from throwing
        server.on('error', () => {});

        const startPromise = server.start('/fake/notebook.jl');

        // Let portFinder resolve
        await tick();

        // Simulate process error
        processRunner.errorHandler?.(new Error('spawn failed'));

        await assert.rejects(startPromise, /spawn failed/);
        assert.strictEqual(processRunner.killed, true, 'Julia process should be killed on process error');

        server.stop();
    });
});

suite('PlutoServer WebSocket settled flag (#72)', () => {
    test('error after open+resolve does not reject the promise', async () => {
        const scheduler = new ControllableScheduler();
        const transport = new ControllableTransport();
        const processRunner = new TrackingProcessRunner();
        const logs: string[] = [];

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: {
                async create(_url: string) { return transport; },
            },
            logger: (msg) => { logs.push(msg); },
            portFinder: async () => 9999,
        });

        const startPromise = server.start('/fake/notebook.jl');

        // Let portFinder resolve
        await tick();

        // Simulate: stdout emits NOTEBOOK_ID, stderr emits HTTP ready
        processRunner.stdoutDataHandler?.(Buffer.from('NOTEBOOK_ID=abc-123\n'));
        processRunner.stderrDataHandler?.(Buffer.from('Go to http://127.0.0.1:1234\n'));

        // Fire the connect delay timeout (1000ms) – this calls connectWebSocket()
        scheduler.fireByMs(1000);

        // connectWebSocket is async – let it resolve transportFactory.create()
        await tick();

        // Now the transport's onOpen handler should have been registered
        transport.triggerOpen();

        // Fire the resetSharedState timeout (500ms) to resolve the inner promise
        scheduler.fireByMs(500);

        await startPromise; // Should resolve successfully

        // Now trigger an error after the promise is already resolved
        // This should NOT throw or cause unhandled rejection
        transport.triggerError(new Error('late connection reset'));

        // Verify the error was logged instead of rejecting
        const hasLateErrorLog = logs.some(l => l.includes('after connection settled'));
        assert.strictEqual(hasLateErrorLog, true, 'Late WebSocket error should be logged');

        server.stop();
    });
});

suite('PlutoServer connection timeout race (#74)', () => {
    test('timeout during connect delay still rejects and cleans up', async () => {
        const scheduler = new ControllableScheduler();
        const processRunner = new TrackingProcessRunner();

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
            portFinder: async () => 9999,
        });

        const startPromise = server.start('/fake/notebook.jl');
        await tick();

        // Simulate stdout/stderr ready signals to trigger tryConnect
        processRunner.stdoutDataHandler?.(Buffer.from('NOTEBOOK_ID=abc-123\n'));
        processRunner.stderrDataHandler?.(Buffer.from('Go to http://127.0.0.1:9999\n'));

        // At this point connectDelayTimeout (1000ms) is pending.
        // Fire the startup timeout (120000ms) before the connect delay fires.
        scheduler.fireByMs(120000);

        await assert.rejects(startPromise, /timeout/i);
        assert.strictEqual(processRunner.killed, true, 'Julia process should be killed');

        // The connect delay timer should have been cleared by settle()
        // Firing it now should be a no-op (timer was already cleared)
        scheduler.fireByMs(1000);

        server.stop();
    });

    test('process error during connect delay rejects once', async () => {
        const scheduler = new ControllableScheduler();
        const processRunner = new TrackingProcessRunner();

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
            portFinder: async () => 9999,
        });

        server.on('error', () => {});

        const startPromise = server.start('/fake/notebook.jl');
        await tick();

        // Trigger tryConnect
        processRunner.stdoutDataHandler?.(Buffer.from('NOTEBOOK_ID=abc-123\n'));
        processRunner.stderrDataHandler?.(Buffer.from('Go to http://127.0.0.1:9999\n'));

        // Process error while connectDelay is pending
        processRunner.errorHandler?.(new Error('julia crashed'));

        await assert.rejects(startPromise, /julia crashed/);
        assert.strictEqual(processRunner.killed, true);

        // Firing remaining timers should be no-ops
        scheduler.fireAll();

        server.stop();
    });
});

suite('PlutoServer EventEmitter cleanup (#76)', () => {
    test('stop() removes all listeners', () => {
        const server = new PlutoServer({
            scheduler: new NoopScheduler(),
            processRunner: new NoopProcessRunner(),
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
        });

        let called = false;
        server.on('ready', () => { called = true; });
        server.on('error', () => { called = true; });
        server.on('closed', () => { called = true; });

        assert.ok(server.listenerCount('ready') > 0, 'should have ready listener');
        assert.ok(server.listenerCount('error') > 0, 'should have error listener');
        assert.ok(server.listenerCount('closed') > 0, 'should have closed listener');

        server.stop();

        assert.strictEqual(server.listenerCount('ready'), 0, 'ready listeners should be removed');
        assert.strictEqual(server.listenerCount('error'), 0, 'error listeners should be removed');
        assert.strictEqual(server.listenerCount('closed'), 0, 'closed listeners should be removed');
        assert.strictEqual(called, false, 'no listeners should have been invoked');
    });

    test('start/stop cycle does not accumulate listeners', async () => {
        const scheduler = new ControllableScheduler();
        const transport = new ControllableTransport();
        const processRunner = new TrackingProcessRunner();

        const server = new PlutoServer({
            scheduler,
            processRunner,
            transportFactory: { async create() { return transport; } },
            logger: () => {},
            portFinder: async () => 9999,
        });

        // Simulate a full start cycle
        const startPromise = server.start('/fake/notebook.jl');
        await tick();
        processRunner.stdoutDataHandler?.(Buffer.from('NOTEBOOK_ID=abc-123\n'));
        processRunner.stderrDataHandler?.(Buffer.from('Go to http://127.0.0.1:9999\n'));
        scheduler.fireByMs(1000);
        await tick();
        transport.triggerOpen();
        scheduler.fireByMs(500);
        await startPromise;

        // Add external listener
        server.on('cellState', () => {});
        const listenersBeforeStop = server.listenerCount('cellState');
        assert.strictEqual(listenersBeforeStop, 1);

        // Stop should clear all listeners
        server.stop();
        assert.strictEqual(server.listenerCount('cellState'), 0, 'cellState listener should be removed after stop');
    });
});

/**
 * A transport that records sent messages (decoded from MessagePack).
 */
class RecordingTransport implements KernelTransport {
    sentMessages: Record<string, unknown>[] = [];

    onOpen(_handler: () => void): void {}
    onMessage(_handler: (data: Buffer | ArrayBuffer) => void): void {}
    onError(_handler: (error: Error) => void): void {}
    onClose(_handler: () => void): void {}
    send(data: Buffer): void {
        const msgpack = require('@msgpack/msgpack');
        this.sentMessages.push(msgpack.decode(new Uint8Array(data)) as Record<string, unknown>);
    }
    close(): void {}
    readyState(): number { return 1; } // OPEN
}

/** Helper: create a PlutoServer with a RecordingTransport directly injected */
function createServerWithTransport(transport: RecordingTransport): PlutoServer {
    const server = new PlutoServer({
        scheduler: new NoopScheduler(),
        processRunner: new NoopProcessRunner(),
        transportFactory: new NoopTransportFactory(),
        logger: () => {},
    });
    // Inject transport directly so sendMessage works without calling start()
    (server as any).transport = transport;
    return server;
}

suite('PlutoServer state mutation after send (#75)', () => {
    test('addCell sends message with pre-mutation cell order', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b']);
        transport.sentMessages = [];

        await server.addCell('c', 1, 'x = 1');

        assert.strictEqual(transport.sentMessages.length, 1);
        const msg = transport.sentMessages[0];
        const body = msg.body as { updates: Array<{ path: string[]; value?: unknown }> };
        const orderUpdate = body.updates.find(u => u.path[0] === 'cell_order');
        assert.ok(orderUpdate, 'should have cell_order update');
        assert.deepStrictEqual(orderUpdate!.value, ['a', 'c', 'b']);

        assert.deepStrictEqual(server.getCellOrder(), ['a', 'c', 'b']);
        assert.strictEqual(server.isKnownCell('c'), true);
    });

    test('deleteCell sends message with post-removal cell order', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b', 'c']);
        transport.sentMessages = [];

        await server.deleteCell('b', 1);

        assert.strictEqual(transport.sentMessages.length, 1);
        const msg = transport.sentMessages[0];
        const body = msg.body as { updates: Array<{ path: string[]; value?: unknown }> };
        const orderUpdate = body.updates.find(u => u.path[0] === 'cell_order');
        assert.ok(orderUpdate, 'should have cell_order update');
        assert.deepStrictEqual(orderUpdate!.value, ['a', 'c']);

        assert.deepStrictEqual(server.getCellOrder(), ['a', 'c']);
        assert.strictEqual(server.isKnownCell('b'), false);
    });

    test('addCell does not mutate state when send fails', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b']);

        // Close the transport so sendMessage returns false
        transport.readyState = () => 0;

        await server.addCell('c', 1, 'x = 1');

        // Send failed, so local state should be unchanged
        assert.deepStrictEqual(server.getCellOrder(), ['a', 'b']);
        assert.strictEqual(server.isKnownCell('c'), false);
    });

    test('deleteCell does not mutate state when send fails', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b', 'c']);
        await server.addCell('b', 1); // Ensure b is in knownCellIds

        // Close the transport
        transport.readyState = () => 0;

        await server.deleteCell('b', 1);

        assert.ok(server.getCellOrder().includes('b'), 'b should still be in cell order');
        assert.strictEqual(server.isKnownCell('b'), true);
    });

    test('deleteCellOnly does not mutate state when send fails', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b', 'c']);
        await server.addCell('b', 1); // Ensure b is in knownCellIds

        // Close the transport
        transport.readyState = () => 0;

        await server.deleteCellOnly('b');

        assert.ok(server.getCellOrder().includes('b'), 'b should still be in cell order');
        assert.strictEqual(server.isKnownCell('b'), true);
    });

    test('deleteCellOnly removes cell from local state after send', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b', 'c']);
        transport.sentMessages = [];

        await server.deleteCellOnly('b');

        assert.strictEqual(transport.sentMessages.length, 1);
        const msg = transport.sentMessages[0];
        const body = msg.body as { updates: Array<{ path: string[]; op: string }> };
        const removeUpdate = body.updates.find(u => u.op === 'remove');
        assert.ok(removeUpdate, 'should have remove update');
        assert.deepStrictEqual(removeUpdate!.path, ['cell_inputs', 'b']);

        assert.deepStrictEqual(server.getCellOrder(), ['a', 'c']);
        assert.strictEqual(server.isKnownCell('b'), false);
    });
});

suite('PlutoServer public API behavior', () => {
    test('new server has empty order and unknown cell', () => {
        const server = new PlutoServer({
            scheduler: new NoopScheduler(),
            processRunner: new NoopProcessRunner(),
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
        });

        assert.deepStrictEqual(server.getCellOrder(), []);
        assert.strictEqual(server.isKnownCell('cell-1'), false);
    });

    test('addCell and deleteCell keep local known/order tracking', async () => {
        const transport = new RecordingTransport();
        const server = createServerWithTransport(transport);

        await server.updateCellOrder(['a', 'b']);
        await server.addCell('c', 1, 'x = 1');

        assert.deepStrictEqual(server.getCellOrder(), ['a', 'c', 'b']);
        assert.strictEqual(server.isKnownCell('c'), true);

        await server.deleteCell('c', 1);
        assert.deepStrictEqual(server.getCellOrder(), ['a', 'b']);
        assert.strictEqual(server.isKnownCell('c'), false);
    });

    test('updateCellOrder keeps internal order copy-safe', async () => {
        const server = new PlutoServer({
            scheduler: new NoopScheduler(),
            processRunner: new NoopProcessRunner(),
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
        });

        const input = ['x', 'y'];
        await server.updateCellOrder(input);
        input.push('z');

        assert.deepStrictEqual(server.getCellOrder(), ['x', 'y']);
    });
});
