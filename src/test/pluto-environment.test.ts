import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    PlutoEnvironment,
    type CommandResult,
    type JuliaCommandRunner,
} from '../pluto-environment';

class RecordingRunner implements JuliaCommandRunner {
    readonly calls: Array<{ executable: string; args: string[] }> = [];
    private readonly results: CommandResult[];

    constructor(...results: CommandResult[]) {
        this.results = [...results];
    }

    async run(executable: string, args: string[]): Promise<CommandResult> {
        this.calls.push({ executable, args });
        const result = this.results.shift();
        if (!result) {
            throw new Error('No command result configured');
        }
        return result;
    }
}

class BlockingSetupRunner implements JuliaCommandRunner {
    readonly calls: string[][] = [];
    private setupStartedResolve!: () => void;
    private releaseSetupResolve!: () => void;
    readonly setupStarted = new Promise<void>(resolve => { this.setupStartedResolve = resolve; });
    readonly setupReleased = new Promise<void>(resolve => { this.releaseSetupResolve = resolve; });

    releaseSetup(): void {
        this.releaseSetupResolve();
    }

    async run(_executable: string, args: string[]): Promise<CommandResult> {
        this.calls.push(args);
        if (args.some(arg => arg.includes('Pkg.add(name="Pluto", version="1")'))) {
            this.setupStartedResolve();
            await this.setupReleased;
        }
        const isSetup = args.some(arg => arg.includes('Pkg.add(name="Pluto", version="1")'));
        return isSetup || this.calls.length > 2
            ? { exitCode: 0, stdout: 'PLUTO_VERSION=1.0.4\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' };
    }
}

function tempEnvironmentPath(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'better-pluto-env-test-'));
}

suite('PlutoEnvironment', () => {
    test('a delayed stale-lock reclaimer preserves a replacement owner', async () => {
        const environmentPath = tempEnvironmentPath();
        const lockPath = path.join(environmentPath, '.better-pluto-client.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'replacement' }));
        try {
            const environment = new PlutoEnvironment({ environmentPath }) as unknown as {
                reclaimStaleLock(lockPath: string): Promise<void>;
            };
            await Promise.all([environment.reclaimStaleLock(lockPath), environment.reclaimStaleLock(lockPath)]);
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'replacement');
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });
    test('uses an existing Pluto 1.x environment without reinstalling it', async () => {
        const environmentPath = tempEnvironmentPath();
        const runner = new RecordingRunner({
            exitCode: 0,
            stdout: 'PLUTO_VERSION=1.0.4\n',
            stderr: '',
        });

        try {
            const environment = new PlutoEnvironment({
                environmentPath,
                juliaExecutable: '/opt/julia/bin/julia',
                runner,
            });

            const info = await environment.ensure();

            assert.strictEqual(info.version, '1.0.4');
            assert.strictEqual(info.projectPath, environmentPath);
            assert.strictEqual(runner.calls.length, 1);
            assert.ok(runner.calls[0].args.some(arg => arg.includes('append!(LOAD_PATH, ["@", "@stdlib"])')));
            assert.strictEqual(runner.calls[0].executable, '/opt/julia/bin/julia');
            assert.deepStrictEqual(runner.calls[0].args.slice(0, 2), [
                '--startup-file=no',
                `--project=${environmentPath}`,
            ]);
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });

    test('installs Pluto 1.x into the shared environment when validation fails', async () => {
        const environmentPath = tempEnvironmentPath();
        const runner = new RecordingRunner(
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
            { exitCode: 0, stdout: '', stderr: '' },
            { exitCode: 0, stdout: 'PLUTO_VERSION=1.0.4\n', stderr: '' },
        );

        try {
            const environment = new PlutoEnvironment({
                environmentPath,
                runner,
            });

            const info = await environment.ensure();

            assert.strictEqual(info.version, '1.0.4');
            assert.strictEqual(runner.calls.length, 4);
            assert.ok(runner.calls[2].args.some(arg => arg.includes('Pkg.add(name="Pluto", version="1")')));
            assert.ok(runner.calls[2].args.includes(environmentPath));
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });

    test('serializes setup across environment managers sharing one path', async () => {
        const environmentPath = tempEnvironmentPath();
        const firstRunner = new BlockingSetupRunner();
        const secondRunner = new RecordingRunner(
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
            { exitCode: 0, stdout: 'PLUTO_VERSION=1.0.4\n', stderr: '' },
        );

        try {
            const first = new PlutoEnvironment({
                environmentPath,
                juliaExecutable: '/opt/julia/first',
                runner: firstRunner,
            });
            const second = new PlutoEnvironment({
                environmentPath,
                juliaExecutable: '/opt/julia/second',
                runner: secondRunner,
            });

            const firstPromise = first.ensure();
            await firstRunner.setupStarted;
            const secondPromise = second.ensure();

            await new Promise(resolve => setTimeout(resolve, 20));
            assert.strictEqual(secondRunner.calls.length, 1, 'second manager must wait for the lock');

            firstRunner.releaseSetup();
            await Promise.all([firstPromise, secondPromise]);
            assert.strictEqual(secondRunner.calls.length, 2);
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });

    test('reclaims a lock owned by a dead process', async () => {
        const environmentPath = tempEnvironmentPath();
        const lockPath = path.join(environmentPath, '.better-pluto-client.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: Number.MAX_SAFE_INTEGER }));
        const staleTime = new Date(Date.now() - 11 * 60 * 1000);
        fs.utimesSync(lockPath, staleTime, staleTime);
        const runner = new RecordingRunner(
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
            { exitCode: 0, stdout: 'PLUTO_VERSION=1.0.4\n', stderr: '' },
        );

        try {
            const environment = new PlutoEnvironment({ environmentPath, runner });
            const info = await environment.ensure();
            assert.strictEqual(info.version, '1.0.4');
            assert.strictEqual(runner.calls.length, 2);
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });

    test('does not reclaim a lock while its owner metadata is still being written', async () => {
        const environmentPath = tempEnvironmentPath();
        const lockPath = path.join(environmentPath, '.better-pluto-client.lock');
        fs.mkdirSync(lockPath);
        const runner = new RecordingRunner(
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
            { exitCode: 1, stdout: '', stderr: 'Package Pluto not found' },
        );

        try {
            const environment = new PlutoEnvironment({
                environmentPath,
                runner,
                lockTimeoutMs: 20,
            });

            await assert.rejects(environment.ensure(), /lock/i);
            assert.strictEqual(fs.existsSync(lockPath), true);
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });

    test('fails instead of waiting forever when Julia does not respond', async () => {
        const environmentPath = tempEnvironmentPath();
        const runner: JuliaCommandRunner = {
            run: async (_executable, _args, timeoutMs = 0) => new Promise<CommandResult>((_, reject) => {
                setTimeout(() => reject(new Error(`Julia command timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        };

        try {
            const environment = new PlutoEnvironment({
                environmentPath,
                runner,
                timeoutMs: 10,
            });

            await assert.rejects(environment.ensure(), /timed out/i);
        } finally {
            fs.rmSync(environmentPath, { recursive: true, force: true });
        }
    });
});
