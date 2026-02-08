/**
 * PlutoServer - Connect to Pluto.jl server for reactive execution
 */

import { spawn, ChildProcess } from 'child_process';
import { encode, decode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';
import { log } from './extension';
import {
    type ProtocolLogEntry,
    type ProtocolCellState,
    processNotebookDiff,
} from './pluto-protocol';

export type LogEntry = ProtocolLogEntry;
export type CellState = ProtocolCellState;

export interface PlutoServerEvents {
    ready: () => void;
    cellState: (cellId: string, state: CellState) => void;
    notebookState: (cells: Record<string, CellState>) => void;
    error: (error: Error) => void;
    closed: () => void;
}

export interface Scheduler {
    setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
    clearTimeout(handle: NodeJS.Timeout): void;
    setInterval(handler: () => void, ms: number): NodeJS.Timeout;
    clearInterval(handle: NodeJS.Timeout): void;
}

export interface ProcessRunner {
    spawnJulia(juliaCode: string): ChildProcess;
}

export interface KernelTransport {
    onOpen(handler: () => void): void;
    onMessage(handler: (data: Buffer | ArrayBuffer) => void): void;
    onError(handler: (error: Error) => void): void;
    onClose(handler: () => void): void;
    send(data: Buffer): void;
    close(): void;
    readyState(): number;
}

export interface KernelTransportFactory {
    create(url: string): Promise<KernelTransport>;
}

export interface PlutoServerOptions {
    scheduler?: Scheduler;
    processRunner?: ProcessRunner;
    transportFactory?: KernelTransportFactory;
    logger?: (message: string) => void;
    idGenerator?: () => string;
    portFinder?: () => Promise<number>;
}

const defaultScheduler: Scheduler = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle),
};

const defaultProcessRunner: ProcessRunner = {
    spawnJulia: (juliaCode: string) => spawn('julia', ['--project=@.', '-e', juliaCode]),
};

const defaultLogger = (message: string): void => {
    log(message);
};

const defaultIdGenerator = (): string => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

const defaultPortFinder = async (): Promise<number> => {
    const net = await import('net');
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                server.close(() => resolve(port));
            } else {
                reject(new Error('Could not get port'));
            }
        });
        server.on('error', reject);
    });
};

const defaultTransportFactory: KernelTransportFactory = {
    async create(url: string): Promise<KernelTransport> {
        const wsModule = await import('ws');
        const WS = wsModule.default || wsModule.WebSocket || wsModule;
        const socket = new WS(url);

        return {
            onOpen: (handler) => socket.on('open', handler),
            onMessage: (handler) => socket.on('message', (data: Buffer) => handler(data)),
            onError: (handler) => socket.on('error', handler),
            onClose: (handler) => socket.on('close', handler),
            send: (data: Buffer) => socket.send(data),
            close: () => socket.close(),
            readyState: () => socket.readyState,
        };
    },
};

export class PlutoServer extends EventEmitter {
    private process: ChildProcess | null = null;
    private transport: KernelTransport | null = null;
    private port = 0;
    private notebookId = '';
    private clientId = '';
    private isReady = false;

    private cellOutputs: Map<string, { body?: string; mime?: string }> = new Map();
    private knownCellIds = new Set<string>();
    private cellOrder: string[] = [];
    private pendingCellIds = new Set<string>();

    private startupTimeout: NodeJS.Timeout | null = null;
    private connectDelayTimeout: NodeJS.Timeout | null = null;
    private resetSharedStateTimeout: NodeJS.Timeout | null = null;

    private vscodeToPlutoId = new Map<string, string>();
    private plutoToVscodeId = new Map<string, string>();
    private waitTimers = new Set<NodeJS.Timeout>();

    private readonly scheduler: Scheduler;
    private readonly processRunner: ProcessRunner;
    private readonly transportFactory: KernelTransportFactory;
    private readonly logger: (message: string) => void;
    private readonly idGenerator: () => string;
    private readonly portFinder: () => Promise<number>;

    constructor(options: PlutoServerOptions = {}) {
        super();
        this.scheduler = options.scheduler || defaultScheduler;
        this.processRunner = options.processRunner || defaultProcessRunner;
        this.transportFactory = options.transportFactory || defaultTransportFactory;
        this.logger = options.logger || defaultLogger;
        this.idGenerator = options.idGenerator || defaultIdGenerator;
        this.portFinder = options.portFinder || defaultPortFinder;

        this.clientId = this.idGenerator();
    }

    getCellOrder(): string[] {
        return [...this.cellOrder];
    }

    isKnownCell(cellId: string): boolean {
        return this.knownCellIds.has(cellId) || this.pendingCellIds.has(cellId);
    }

    async start(notebookPath: string): Promise<void> {
        this.port = await this.portFinder();

        this.logger(`[BetterPlutoServer] Starting on port ${this.port}`);

        const juliaCode = `
            import Pluto

            session = Pluto.ServerSession(;
                options = Pluto.Configuration.from_flat_kwargs(;
                    launch_browser = false,
                    port = ${this.port},
                    require_secret_for_access = false,
                    require_secret_for_open_links = false,
                    disable_writing_notebook_files = true,
                    auto_reload_from_file = true,
                )
            )

            notebook = Pluto.SessionActions.open(session, "${notebookPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"; run_async=true)

            println("PLUTO_READY")
            println("NOTEBOOK_ID=", notebook.notebook_id)
            flush(stdout)

            Pluto.run(session)
        `;

        return new Promise((resolve, reject) => {
            this.process = this.processRunner.spawnJulia(juliaCode);

            let outputBuffer = '';
            let stderrBuffer = '';
            let resolved = false;
            let notebookIdFound = false;
            let httpReady = false;

            const tryConnect = (): void => {
                if (resolved || !notebookIdFound || !httpReady) {
                    return;
                }
                resolved = true;
                this.logger('[BetterPlutoServer] HTTP server and notebook ID are ready, connecting WebSocket...');

                this.connectDelayTimeout = this.scheduler.setTimeout(async () => {
                    this.connectDelayTimeout = null;
                    try {
                        await this.connectWebSocket();
                        if (this.startupTimeout) {
                            this.scheduler.clearTimeout(this.startupTimeout);
                            this.startupTimeout = null;
                        }
                        this.isReady = true;
                        this.emit('ready');
                        resolve();
                    } catch (err) {
                        this.killProcess();
                        reject(err);
                    }
                }, 1000);
            };

            this.process.stdout?.on('data', (data) => {
                const text = data.toString();
                outputBuffer += text;

                if (!notebookIdFound) {
                    const match = outputBuffer.match(/NOTEBOOK_ID=([a-fA-F0-9-]+)/);
                    if (match) {
                        this.notebookId = match[1];
                        notebookIdFound = true;
                        this.logger(`[BetterPlutoServer] Notebook ID: ${this.notebookId}`);
                        tryConnect();
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                const text = data.toString();
                stderrBuffer += text;

                if (!resolved && (stderrBuffer.includes('Go to http://localhost') || stderrBuffer.includes('Go to http://127.0.0.1'))) {
                    httpReady = true;
                    tryConnect();
                }
            });

            this.process.on('error', (err) => {
                if (!resolved) {
                    this.killProcess();
                    reject(err);
                }
                this.emit('error', err as Error);
            });

            this.process.on('exit', (code) => {
                this.logger(`[BetterPlutoServer] Process exited with code ${code}`);
                this.isReady = false;
                this.emit('closed');
            });

            this.startupTimeout = this.scheduler.setTimeout(() => {
                this.startupTimeout = null;
                if (!resolved) {
                    this.killProcess();
                    reject(new Error('Pluto server startup timeout'));
                }
            }, 120000);
        });
    }

    private async connectWebSocket(): Promise<void> {
        const url = `ws://127.0.0.1:${this.port}/`;
        this.logger(`[BetterPlutoServer] Connecting to ${url}`);

        this.transport = await this.transportFactory.create(url);

        return new Promise((resolve, reject) => {
            if (!this.transport) {
                reject(new Error('WebSocket transport not initialized'));
                return;
            }

            let settled = false;

            this.transport.onOpen(() => {
                this.logger('[BetterPlutoServer] WebSocket connected');

                this.sendMessage('connect', {
                    notebook_id: this.notebookId,
                });

                this.resetSharedStateTimeout = this.scheduler.setTimeout(() => {
                    this.resetSharedStateTimeout = null;
                    this.sendMessage('reset_shared_state', {
                        notebook_id: this.notebookId,
                    });
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                }, 500);
            });

            this.transport.onMessage((data) => {
                this.handleMessage(data);
            });

            this.transport.onError((err) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`WebSocket connection failed: ${err.message}`));
                } else {
                    this.logger(`[BetterPlutoServer] WebSocket error after connection settled: ${err.message}`);
                }
            });

            this.transport.onClose(() => {
                this.logger('[BetterPlutoServer] WebSocket closed');
                this.emit('closed');
            });
        });
    }

    requestFullState(): void {
        this.sendMessage('reset_shared_state', {
            notebook_id: this.notebookId,
        });
    }

    private sendMessage(type: string, body: Record<string, unknown> = {}): void {
        if (!this.transport) {
            this.logger(`[BetterPlutoServer] Cannot send '${type}': no transport`);
            return;
        }

        if (this.transport.readyState() !== 1) {
            this.logger(`[BetterPlutoServer] Cannot send '${type}': WebSocket not open (readyState=${this.transport.readyState()})`);
            return;
        }

        const message = {
            type,
            client_id: this.clientId,
            request_id: this.idGenerator(),
            body,
            notebook_id: this.notebookId,
        };

        try {
            const encoded = encode(message);
            this.transport.send(Buffer.from(encoded));
        } catch (err) {
            this.logger(`[BetterPlutoServer] Failed to send '${type}': ${err}`);
        }
    }

    private handleMessage(data: Buffer | ArrayBuffer): void {
        try {
            const uint8 = data instanceof Buffer
                ? new Uint8Array(data)
                : new Uint8Array(data);

            const message = decode(uint8) as Record<string, unknown>;
            const type = message.type as string;

            if (type === 'notebook_diff') {
                const result = processNotebookDiff(message, {
                    cellOutputs: this.cellOutputs,
                    knownCellIds: this.knownCellIds,
                    cellOrder: this.cellOrder,
                    pendingCellIds: this.pendingCellIds,
                });

                this.cellOutputs = result.nextState.cellOutputs;
                this.knownCellIds = result.nextState.knownCellIds;
                this.cellOrder = result.nextState.cellOrder;
                this.pendingCellIds = result.nextState.pendingCellIds;

                for (const event of result.events) {
                    this.emit('cellState', event.cellId, event.state);
                }
            }
        } catch (err) {
            this.emit('error', err as Error);
        }
    }

    async runCell(cellId: string): Promise<void> {
        this.sendMessage('run_multiple_cells', {
            cells: [cellId],
        });
    }

    async runMultipleCells(cellIds: string[]): Promise<void> {
        this.sendMessage('run_multiple_cells', {
            cells: cellIds,
        });
    }

    async setBond(name: string, value: unknown): Promise<void> {
        this.sendMessage('update_notebook', {
            updates: [{
                path: ['bonds', name],
                op: 'replace',
                value: { value },
            }],
        });
    }

    async reshowCell(cellId: string, objectid: string, dim: number): Promise<void> {
        this.sendMessage('reshow_cell', {
            cell_id: cellId,
            objectid,
            dim,
        });
    }

    async interruptAll(): Promise<void> {
        this.sendMessage('interrupt_all', {});
    }

    async addCell(cellId: string, index: number, code: string = ''): Promise<void> {
        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_inputs', cellId],
                    op: 'add',
                    value: {
                        cell_id: cellId,
                        code: code,
                        code_folded: false,
                        metadata: {
                            disabled: false,
                        },
                    },
                },
                {
                    path: ['cell_order'],
                    op: 'replace',
                    value: this.getCellOrderWithNewCell(cellId, index),
                },
            ],
        });

        this.knownCellIds.add(cellId);
    }

    private getCellOrderWithNewCell(cellId: string, index: number): string[] {
        const newOrder = [...this.cellOrder];
        newOrder.splice(index, 0, cellId);
        this.cellOrder = newOrder;
        return newOrder;
    }

    async deleteCell(cellId: string, _index: number): Promise<void> {
        this.cellOrder = this.cellOrder.filter(id => id !== cellId);
        this.knownCellIds.delete(cellId);

        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_inputs', cellId],
                    op: 'remove',
                },
                {
                    path: ['cell_order'],
                    op: 'replace',
                    value: this.cellOrder,
                },
            ],
        });
    }

    async deleteCellOnly(cellId: string): Promise<void> {
        this.knownCellIds.delete(cellId);
        this.cellOrder = this.cellOrder.filter(id => id !== cellId);

        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_inputs', cellId],
                    op: 'remove',
                },
            ],
        });
    }

    getPlutoCellId(vscodeCellId: string): string {
        return this.vscodeToPlutoId.get(vscodeCellId) || vscodeCellId;
    }

    getVscodeCellId(plutoId: string): string {
        return this.plutoToVscodeId.get(plutoId) || plutoId;
    }

    async waitForCellToAppear(cellId: string, code: string = ''): Promise<string> {
        this.pendingCellIds.add(cellId);

        return new Promise((resolve) => {
            const startTime = Date.now();

            if (this.knownCellIds.has(cellId)) {
                this.pendingCellIds.delete(cellId);
                resolve(cellId);
                return;
            }

            const cleanup = () => {
                this.scheduler.clearInterval(checkInterval);
                this.scheduler.clearTimeout(timeout);
                this.waitTimers.delete(checkInterval);
                this.waitTimers.delete(timeout);
            };

            const checkInterval = this.scheduler.setInterval(async () => {
                if (this.knownCellIds.has(cellId)) {
                    cleanup();
                    this.pendingCellIds.delete(cellId);

                    try {
                        await this.updateCell(cellId, code);
                    } catch {
                        // Best effort.
                    }

                    resolve(cellId);
                    return;
                }

                if ((Date.now() - startTime) % 1000 < 100) {
                    this.requestFullState();
                }
            }, 100);

            const timeout = this.scheduler.setTimeout(() => {
                cleanup();
                this.pendingCellIds.delete(cellId);
                resolve(cellId);
            }, 10000);

            this.waitTimers.add(checkInterval);
            this.waitTimers.add(timeout);
        });
    }

    async addCellOnly(cellId: string, code: string = ''): Promise<string> {
        return this.waitForCellToAppear(cellId, code);
    }

    async updateCellOrder(newOrder: string[]): Promise<void> {
        this.cellOrder = [...newOrder];

        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_order'],
                    op: 'replace',
                    value: this.cellOrder,
                },
            ],
        });
    }

    async updateCell(cellId: string, code: string): Promise<void> {
        if (!this.knownCellIds.has(cellId)) {
            await this.addCellOnly(cellId, code);
            return;
        }

        this.sendMessage('update_notebook', {
            updates: [{
                path: ['cell_inputs', cellId, 'code'],
                op: 'replace',
                value: code,
            }],
        });
    }

    private killProcess(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }

    get ready(): boolean {
        return this.isReady;
    }

    stop(): void {
        if (this.startupTimeout) {
            this.scheduler.clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }
        if (this.connectDelayTimeout) {
            this.scheduler.clearTimeout(this.connectDelayTimeout);
            this.connectDelayTimeout = null;
        }
        if (this.resetSharedStateTimeout) {
            this.scheduler.clearTimeout(this.resetSharedStateTimeout);
            this.resetSharedStateTimeout = null;
        }
        // Clear waitForCellToAppear timers
        for (const timer of this.waitTimers) {
            this.scheduler.clearTimeout(timer);
            this.scheduler.clearInterval(timer);
        }
        this.waitTimers.clear();
        this.cellOutputs.clear();
        this.knownCellIds.clear();
        this.cellOrder = [];
        this.pendingCellIds.clear();
        this.vscodeToPlutoId.clear();
        this.plutoToVscodeId.clear();
        this.notebookId = '';

        if (this.transport) {
            this.transport.close();
            this.transport = null;
        }
        this.killProcess();
        this.isReady = false;
    }
}
