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
        const server = new PlutoServer({
            scheduler: new NoopScheduler(),
            processRunner: new NoopProcessRunner(),
            transportFactory: new NoopTransportFactory(),
            logger: () => {},
        });

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
