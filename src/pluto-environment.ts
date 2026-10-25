import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

export interface CommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export interface JuliaCommandRunner {
    run(executable: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
}

export interface PlutoEnvironmentInfo {
    juliaExecutable: string;
    projectPath: string;
    version: string;
}

export interface PlutoEnvironmentManager {
    ensure(): Promise<PlutoEnvironmentInfo>;
}

export interface PlutoEnvironmentOptions {
    environmentPath?: string;
    juliaExecutable?: string;
    runner?: JuliaCommandRunner;
    logger?: (message: string) => void;
    timeoutMs?: number;
    lockTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;
const LOCK_FILE_NAME = '.better-pluto-client.lock';

const defaultRunner: JuliaCommandRunner = {
    run(executable, args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const child = spawn(executable, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            let timedOut = false;
            let forceKillTimeout: NodeJS.Timeout | undefined;
            const timeout = setTimeout(() => {
                timedOut = true;
                stderr += `\nJulia command timed out after ${timeoutMs}ms`;
                child.kill('SIGTERM');
                forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 1000);
            }, timeoutMs);

            const finish = (result: CommandResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKillTimeout) {
                    clearTimeout(forceKillTimeout);
                }
                resolve(result);
            };

            child.stdout.on('data', data => { stdout += data.toString(); });
            child.stderr.on('data', data => { stderr += data.toString(); });
            child.on('error', error => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (forceKillTimeout) {
                    clearTimeout(forceKillTimeout);
                }
                reject(error);
            });
            child.on('close', exitCode => finish({
                exitCode: timedOut ? null : exitCode,
                stdout,
                stderr,
            }));
        });
    },
};

const validateScript = `
empty!(LOAD_PATH)
append!(LOAD_PATH, ["@", "@stdlib"])
import Pluto
version = Base.pkgversion(Pluto)
version.major == 1 || error("Pluto 1.x is required, found $(version)")
println("PLUTO_VERSION=", version)
`;

const setupScript = `
empty!(LOAD_PATH)
append!(LOAD_PATH, ["@", "@stdlib"])
import Pkg
environment_path = ARGS[1]
Pkg.activate(environment_path)
Pkg.add(name="Pluto", version="1")
Pkg.instantiate()
import Pluto
version = Base.pkgversion(Pluto)
version.major == 1 || error("Pluto 1.x is required, found $(version)")
println("PLUTO_VERSION=", version)
`;

const inFlightEnsures = new Map<string, Promise<PlutoEnvironmentInfo>>();

export function defaultSharedPlutoEnvironmentPath(): string {
    return path.join(os.homedir(), '.julia', 'environments', 'better-pluto-client');
}

export class PlutoEnvironment implements PlutoEnvironmentManager {
    private readonly environmentPath: string;
    private readonly juliaExecutable: string;
    private readonly runner: JuliaCommandRunner;
    private readonly logger: (message: string) => void;
    private readonly timeoutMs: number;
    private readonly lockTimeoutMs: number;

    constructor(options: PlutoEnvironmentOptions = {}) {
        this.environmentPath = resolveEnvironmentPath(options.environmentPath || defaultSharedPlutoEnvironmentPath());
        this.juliaExecutable = options.juliaExecutable || 'julia';
        this.runner = options.runner || defaultRunner;
        this.logger = options.logger || (() => undefined);
        this.timeoutMs = options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
        this.lockTimeoutMs = options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
    }

    ensure(): Promise<PlutoEnvironmentInfo> {
        const key = `${this.juliaExecutable}\0${this.environmentPath}`;
        const existing = inFlightEnsures.get(key);
        if (existing) {
            return existing;
        }

        const promise = this.ensureOnce().finally(() => {
            if (inFlightEnsures.get(key) === promise) {
                inFlightEnsures.delete(key);
            }
        });
        inFlightEnsures.set(key, promise);
        return promise;
    }

    private async ensureOnce(): Promise<PlutoEnvironmentInfo> {
        await fs.promises.mkdir(this.environmentPath, { recursive: true });

        const validation = await this.runJulia([
            '--startup-file=no',
            `--project=${this.environmentPath}`,
            '-e',
            validateScript,
        ]);
        const validatedVersion = this.readVersion(validation);
        if (validation.exitCode === 0 && validatedVersion && this.isPluto1(validatedVersion)) {
            return this.info(validatedVersion);
        }

        if (validation.exitCode === null) {
            throw new Error(this.commandFailure('validate Pluto 1.x', validation));
        }

        return this.withEnvironmentLock(async () => {
            const lockedValidation = await this.runJulia([
                '--startup-file=no',
                `--project=${this.environmentPath}`,
                '-e',
                validateScript,
            ]);
            const lockedVersion = this.readVersion(lockedValidation);
            if (lockedValidation.exitCode === 0 && lockedVersion && this.isPluto1(lockedVersion)) {
                return this.info(lockedVersion);
            }
            if (lockedValidation.exitCode === null) {
                throw new Error(this.commandFailure('validate Pluto 1.x', lockedValidation));
            }

            this.logger(`[BetterPlutoEnvironment] Installing Pluto 1.x into ${this.environmentPath}`);
            const setup = await this.runJulia([
                '--startup-file=no',
                '-e',
                setupScript,
                this.environmentPath,
            ]);
            if (setup.exitCode !== 0) {
                throw new Error(this.commandFailure('install Pluto 1.x', setup));
            }

            const finalValidation = await this.runJulia([
                '--startup-file=no',
                `--project=${this.environmentPath}`,
                '-e',
                validateScript,
            ]);
            const version = this.readVersion(finalValidation);
            if (finalValidation.exitCode !== 0 || !version || !this.isPluto1(version)) {
                throw new Error(this.commandFailure('validate Pluto 1.x', finalValidation));
            }
            return this.info(version);
        });
    }

    private async runJulia(args: string[]): Promise<CommandResult> {
        try {
            return await this.runner.run(this.juliaExecutable, args, this.timeoutMs);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not run Julia executable '${this.juliaExecutable}': ${message}`);
        }
    }

    private async withEnvironmentLock<T>(action: () => Promise<T>): Promise<T> {
        const release = await this.acquireEnvironmentLock();
        try {
            return await action();
        } finally {
            await release();
        }
    }

    private async acquireEnvironmentLock(): Promise<() => Promise<void>> {
        const lockPath = path.join(this.environmentPath, LOCK_FILE_NAME);
        const deadline = Date.now() + this.lockTimeoutMs;

        while (true) {
            try {
                await fs.promises.mkdir(lockPath);
                const ownerToken = randomUUID();
                const ownerPath = path.join(lockPath, 'owner.json');
                const temporaryOwnerPath = `${ownerPath}.${ownerToken}.tmp`;
                try {
                    await fs.promises.writeFile(
                        temporaryOwnerPath,
                        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: ownerToken }),
                        'utf8'
                    );
                    await fs.promises.rename(temporaryOwnerPath, ownerPath);
                } catch (error) {
                    await fs.promises.rm(temporaryOwnerPath, { force: true });
                    await fs.promises.rm(lockPath, { recursive: true, force: true });
                    throw error;
                }
                return async () => {
                    try {
                        const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')) as { token?: string };
                        if (owner.token !== ownerToken) {
                            return;
                        }
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            return;
                        }
                        throw error;
                    }
                    await fs.promises.rm(lockPath, { recursive: true, force: true });
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }

                if (await this.isStaleLock(lockPath)) {
                    await this.reclaimStaleLock(lockPath);
                    continue;
                }

                if (Date.now() >= deadline) {
                    throw new Error(`Timed out waiting for Pluto environment lock at ${lockPath}`);
                }
                await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
            }
        }
    }

    private async isStaleLock(lockPath: string, inspectedStats?: fs.Stats): Promise<boolean> {
        try {
            const stats = await fs.promises.stat(lockPath);
            const modifiedAt = inspectedStats && inspectedStats.ino === stats.ino && inspectedStats.dev === stats.dev
                ? inspectedStats.mtimeMs : stats.mtimeMs;
            let contents: string;
            try {
                contents = await fs.promises.readFile(path.join(lockPath, 'owner.json'), 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return Date.now() - modifiedAt > LOCK_STALE_AFTER_MS;
                }
                throw error;
            }
            try {
                const lockInfo = JSON.parse(contents) as { pid?: number };
                if (lockInfo.pid) {
                    try {
                        process.kill(lockInfo.pid, 0);
                        return false;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                            return true;
                        }
                    }
                }
            } catch {
                // Fall back to the lock age for malformed lock files.
            }
            return Date.now() - modifiedAt > LOCK_STALE_AFTER_MS;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return true;
            }
            throw error;
        }
    }

    private async reclaimStaleLock(lockPath: string): Promise<void> {
        // Serialize reclaimers inside the directory itself. A delayed contender
        // must revalidate after acquiring this gate, including on a replacement lock.
        const gatePath = path.join(lockPath, '.reclaim');
        let inspectedStats: fs.Stats;
        try {
            inspectedStats = await fs.promises.stat(lockPath);
            await fs.promises.mkdir(gatePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EEXIST') {
                return;
            }
            throw error;
        }
        if (await this.isStaleLock(lockPath, inspectedStats)) {
            await fs.promises.rm(lockPath, { recursive: true, force: true });
        } else {
            await fs.promises.rmdir(gatePath);
        }
    }

    private info(version: string): PlutoEnvironmentInfo {
        return {
            juliaExecutable: this.juliaExecutable,
            projectPath: this.environmentPath,
            version,
        };
    }

    private readVersion(result: CommandResult): string | undefined {
        const match = `${result.stdout}\n${result.stderr}`.match(/PLUTO_VERSION=([^\s]+)/);
        return match?.[1];
    }

    private isPluto1(version: string): boolean {
        return /^1(?:\.|$)/.test(version);
    }

    private commandFailure(action: string, result: CommandResult): string {
        const details = `${result.stdout}\n${result.stderr}`.trim();
        const suffix = details ? `\n${details.slice(-4000)}` : '';
        return `Failed to ${action} in ${this.environmentPath} (exit code ${result.exitCode ?? 'unknown'}).${suffix}`;
    }
}

function resolveEnvironmentPath(environmentPath: string): string {
    if (environmentPath === '~') {
        return os.homedir();
    }
    if (environmentPath.startsWith('~/')) {
        return path.join(os.homedir(), environmentPath.slice(2));
    }
    return path.resolve(environmentPath);
}
