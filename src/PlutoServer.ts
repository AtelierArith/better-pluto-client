/**
 * PlutoServer - Connect to Pluto.jl server for reactive execution
 */

import { spawn, ChildProcess } from 'child_process';
import { createConnection, Socket } from 'net';
import { encode, decode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';
import { log } from './extension';

/**
 * Check if a string is a Pluto objectid (12-20 character hex string)
 */
function isPlutoObjectId(str: string | undefined | null): boolean {
    if (!str) {return false;}
    const trimmed = str.trim();
    return /^[0-9a-f]{12,20}$/i.test(trimmed);
}

export interface LogEntry {
    level: string;
    msg: string;
    line?: number;
}

export interface CellState {
    cellId: string;
    running: boolean;
    queued: boolean;
    output?: {
        body: string;
        mime: string;
    };
    errored: boolean;
    runtime?: number;
    logs?: LogEntry[];
}

export interface PlutoServerEvents {
    ready: () => void;
    cellState: (cellId: string, state: CellState) => void;
    notebookState: (cells: Record<string, CellState>) => void;
    error: (error: Error) => void;
    closed: () => void;
}

export class PlutoServer extends EventEmitter {
    private process: ChildProcess | null = null;
    private ws: WebSocket | null = null;
    private port: number = 0;
    private notebookId: string = '';
    private clientId: string = '';
    private isReady: boolean = false;
    private messageQueue: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

    // Track accumulated output state for each cell
    private cellOutputs: Map<string, { body?: string; mime?: string }> = new Map();

    // Track known cell IDs and their order
    private knownCellIds = new Set<string>();
    private cellOrder: string[] = [];
    
    // Track cells that are being added but not yet confirmed by Pluto
    // This prevents syncCellOrder from sending cell_order without these cells
    private pendingCellIds = new Set<string>();


    // Track pending get_published_object requests
    private pendingObjectRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
    
    // Map VS Code cell IDs to Pluto cell IDs (for future use if needed)
    private vscodeToPlutoId = new Map<string, string>();
    private plutoToVscodeId = new Map<string, string>();

    constructor() {
        super();
        this.clientId = this.generateId();
    }

    /**
     * Get the current cell order tracked by the server
     */
    getCellOrder(): string[] {
        return [...this.cellOrder];
    }

    /**
     * Check if a cell is known to Pluto (has cell_inputs registered) or is pending addition.
     * Pending cells are included so that syncCellOrder doesn't accidentally exclude them
     * while addCellOnly is waiting for Pluto's confirmation.
     */
    isKnownCell(cellId: string): boolean {
        return this.knownCellIds.has(cellId) || this.pendingCellIds.has(cellId);
    }

    /**
     * Start Pluto server and open notebook
     */
    async start(notebookPath: string): Promise<void> {
        this.port = await this.findPort();

        log(`[BetterPlutoServer] Starting on port ${this.port}`);

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
            this.process = spawn('julia', ['--project=@.', '-e', juliaCode]);

            let outputBuffer = '';
            let stderrBuffer = '';
            let resolved = false;
            let notebookIdFound = false;

            this.process.stdout?.on('data', (data) => {
                const text = data.toString();
                outputBuffer += text;
                console.log('[PlutoServer stdout]', text.trim());

                // Extract notebook ID when available
                if (!notebookIdFound) {
                    const match = outputBuffer.match(/NOTEBOOK_ID=([a-f0-9-]+)/);
                    if (match) {
                        this.notebookId = match[1];
                        notebookIdFound = true;
                        log(`[BetterPlutoServer] Notebook ID: ${this.notebookId}`);
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                const text = data.toString();
                stderrBuffer += text;
                console.log('[PlutoServer stderr]', text.trim());

                // Pluto prints "Go to http://localhost:PORT/" when HTTP server is ready
                if (!resolved && stderrBuffer.includes('Go to http://localhost')) {
                    resolved = true;
                    log('[BetterPlutoServer] HTTP server is ready, connecting WebSocket...');

                    // Give the server a moment to fully initialize
                    setTimeout(async () => {
                        try {
                            await this.connectWebSocket();
                            this.isReady = true;
                            this.emit('ready');
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }, 1000);
                }
            });

            this.process.on('error', (err) => {
                if (!resolved) {
                    reject(err);
                }
                this.emit('error', err);
            });

            this.process.on('exit', (code) => {
                log(`[BetterPlutoServer] Process exited with code ${code}`);
                this.isReady = false;
                this.emit('closed');
            });

            // Timeout
            setTimeout(() => {
                if (!resolved) {
                    reject(new Error('Pluto server startup timeout'));
                }
            }, 120000); // 2 minute timeout for Pluto startup
        });
    }

    /**
     * Connect to Pluto WebSocket
     */
    private async connectWebSocket(): Promise<void> {
        // Import ws module
        const wsModule = await import('ws');
        const WS = wsModule.default || wsModule.WebSocket || wsModule;

        return new Promise((resolve, reject) => {
            const url = `ws://127.0.0.1:${this.port}/`;
            log(`[BetterPlutoServer] Connecting to ${url}`);

            try {
                const socket = new WS(url);
                this.ws = socket as unknown as WebSocket;

                socket.on('open', () => {
                    log('[BetterPlutoServer] WebSocket connected');

                    // Send connect message
                    this.sendMessage('connect', {
                        notebook_id: this.notebookId,
                    });

                    // Request full state
                    setTimeout(() => {
                        this.sendMessage('reset_shared_state', {
                            notebook_id: this.notebookId,
                        });
                        resolve();
                    }, 500);
                });

                socket.on('message', (data: Buffer) => {
                    this.handleMessage(data);
                });

                socket.on('error', (err: Error) => {
                    console.error('[BetterPlutoServer] WebSocket error:', err.message);
                    reject(new Error(`WebSocket connection failed: ${err.message}`));
                });

                socket.on('close', () => {
                    log('[BetterPlutoServer] WebSocket closed');
                    this.emit('closed');
                });
            } catch (err) {
                console.error('[BetterPlutoServer] Failed to create WebSocket:', err);
                reject(err);
            }
        });
    }

    /**
     * Request full notebook state from Pluto
     */
    requestFullState(): void {
        this.sendMessage('reset_shared_state', {
            notebook_id: this.notebookId,
        });
    }

    /**
     * Send message to Pluto server
     */
    private sendMessage(type: string, body: Record<string, unknown> = {}): void {
        if (!this.ws) {
            console.error('[BetterPlutoServer] Cannot send message, WebSocket not initialized');
            return;
        }

        // Check if socket is open (readyState 1 = OPEN)
        const socket = this.ws as any;
        if (socket.readyState !== 1) {
            console.error('[BetterPlutoServer] Cannot send message, WebSocket not open (state:', socket.readyState, ')');
            return;
        }

        const message = {
            type,
            client_id: this.clientId,
            request_id: this.generateId(),
            body,
            notebook_id: this.notebookId,
        };

        log(`[BetterPlutoServer] Sending: ${type}`);
        const encoded = encode(message);
        socket.send(Buffer.from(encoded));
    }

    /**
     * Handle incoming message
     */
    private handleMessage(data: Buffer | ArrayBuffer): void {
        try {
            // Convert to Uint8Array for msgpack
            const uint8 = data instanceof Buffer
                ? new Uint8Array(data)
                : new Uint8Array(data);

            const message = decode(uint8) as Record<string, unknown>;
            const type = message.type as string;

            log(`[BetterPlutoServer] Received: ${type}`);

            // Log ALL message types to debug add_cell response
            log(`[BetterPlutoServer] Received message type: ${type}`);
            
            if (type === '👋') {
                log('[BetterPlutoServer] Got welcome message from Pluto');
            } else if (type === 'notebook_diff') {
                const content = message.message as Record<string, unknown>;
                const patches = content?.patches as Array<{
                    path: (string | number)[];
                    op: string;
                    value?: unknown;
                }>;
                log(`[BetterPlutoServer] notebook_diff patches=${patches?.length ?? 0}`);
                this.handleNotebookDiff(message);
            } else if (type === 'run_feedback') {
                log(`[BetterPlutoServer] run_feedback: ${JSON.stringify(message).slice(0, 300)}`);
            } else if (type === 'object_result') {
                this.handleObjectResult(message);
            } else {
                // Log unknown message types with full content for debugging
                log(`[BetterPlutoServer] Unknown message: ${JSON.stringify(message).slice(0, 500)}`);
            }
        } catch (err) {
            console.error('[BetterPlutoServer] Error handling message:', err);
        }
    }

    /**
     * Handle notebook state diff
     */
    private handleNotebookDiff(message: Record<string, unknown>): void {
        const content = message.message as Record<string, unknown>;
        const patches = content?.patches as Array<{
            path: (string | number)[];
            op: string;
            value?: unknown;
        }>;

        if (!patches) {return;}

        // Debug: log patch paths (trim to avoid huge output)
        const patchPreview = patches.slice(0, 8).map((patch) => {
            return `${patch.op} ${JSON.stringify(patch.path)}`;
        });
        log(`[BetterPlutoServer] notebook_diff patch paths: ${patchPreview.join(' | ')}`);

        for (const patch of patches) {
            const path = patch.path;

            // Handle full state replacement (initial state)
            if (path.length === 0 && patch.op === 'replace') {
                const fullState = patch.value as Record<string, unknown>;
                if (fullState?.cell_results) {
                    this.handleFullCellResults(fullState.cell_results as Record<string, unknown>);
                }
                // Track cell order from initial state
                if (fullState?.cell_order && Array.isArray(fullState.cell_order)) {
                    this.cellOrder = fullState.cell_order as string[];
                    if (fullState?.cell_inputs && typeof fullState.cell_inputs === 'object') {
                        this.knownCellIds = new Set(Object.keys(fullState.cell_inputs as Record<string, unknown>));
                    } else {
                        this.knownCellIds = new Set(this.cellOrder);
                    }
                    log(`[BetterPlutoServer] Initial cell order: ${this.cellOrder.length} cells: [${this.cellOrder.join(', ')}]`);
                    log(`[BetterPlutoServer] Known cell IDs: [${Array.from(this.knownCellIds).join(', ')}]`);
                }
                continue;
            }

            // Track cell_inputs add/remove to keep knownCellIds in sync
            if (path[0] === 'cell_inputs') {
                const cellId = path[1] as string;
                if (cellId) {
                    if (patch.op === 'remove') {
                        this.knownCellIds.delete(cellId);
                        // Also remove from pending if Pluto explicitly removed it
                        if (this.pendingCellIds.has(cellId)) {
                            this.pendingCellIds.delete(cellId);
                            log(`[BetterPlutoServer] Cell ${cellId} removed by Pluto, cleared from pendingCellIds`);
                        }
                    } else if (patch.op === 'add' || patch.op === 'replace') {
                        this.knownCellIds.add(cellId);
                        // Remove from pending since it's now confirmed
                        if (this.pendingCellIds.has(cellId)) {
                            this.pendingCellIds.delete(cellId);
                            log(`[BetterPlutoServer] Cell ${cellId} confirmed via ${patch.op}, removed from pendingCellIds`);
                        }
                    }
                }
                continue;
            }

            // Track cell order changes (no-op for execution, but keep local order in sync)
            if (path[0] === 'cell_order' && patch.op === 'replace' && Array.isArray(patch.value)) {
                const newOrder = patch.value as string[];
                log(`[BetterPlutoServer] cell_order updated: [${newOrder.join(', ')}]`);
                this.cellOrder = newOrder;
                continue;
            }

            // Only handle cell_results patches
            if (path[0] !== 'cell_results') {continue;}

            const cellId = path[1] as string;
            if (!cellId) {continue;}

            // Handle full cell result replacement
            if (path.length === 2 && patch.op === 'replace') {
                const cellResult = patch.value as Record<string, unknown>;
                this.handleCellResult(cellId, cellResult);
                continue;
            }

            const field = path[2] as string;

            // Handle nested output fields (path length >= 4)
            // e.g., ["cell_results", cellId, "output", "body"]
            if (field === 'output' && path.length >= 4) {
                const subField = path[3] as string;
                this.handleOutputSubField(cellId, subField, patch.value);
                continue;
            }

            this.handleCellField(cellId, field, patch.value);
        }
    }

    /**
     * Handle full cell results from initial state
     */
    private handleFullCellResults(cellResults: Record<string, unknown>): void {
        log('[BetterPlutoServer] Processing full cell results');
        for (const [cellId, result] of Object.entries(cellResults)) {
            this.handleCellResult(cellId, result as Record<string, unknown>);
        }
    }

    /**
     * Handle a single cell's full result
     */
    private handleCellResult(cellId: string, result: Record<string, unknown>): void {
        if (!result) {return;}

        const state: Partial<CellState> = { cellId };

        if (result.running !== undefined) {
            state.running = result.running as boolean;
        }
        if (result.errored !== undefined) {
            state.errored = result.errored as boolean;
        }
        if (result.runtime !== undefined) {
            state.runtime = result.runtime as number;
        }
        if (result.output) {
            const output = result.output as Record<string, unknown>;
            state.output = this.extractOutput(output);
        }
        if (result.logs) {
            state.logs = this.extractLogs(result.logs as unknown[]);
            console.log(`[BetterPlutoServer] Cell ${cellId} has ${state.logs?.length || 0} logs`);
        }

        log(`[BetterPlutoServer] cellResult ${cellId}: running=${state.running}, errored=${state.errored}, runtime=${state.runtime}, hasOutput=${!!state.output}`);
        console.log(`[BetterPlutoServer] Cell ${cellId} full result:`, JSON.stringify(state).slice(0, 200));
        this.emit('cellState', cellId, state);
    }

    /**
     * Handle a single field update for a cell
     */
    private handleCellField(cellId: string, field: string, value: unknown): void {
        const state: Partial<CellState> = { cellId };

        if (field === 'running') {
            state.running = value as boolean;
            log(`[BetterPlutoServer] cellField ${cellId} running=${state.running}`);
        } else if (field === 'queued') {
            state.queued = value as boolean;
            log(`[BetterPlutoServer] cellField ${cellId} queued=${state.queued}`);
        } else if (field === 'errored') {
            state.errored = value as boolean;
            log(`[BetterPlutoServer] cellField ${cellId} errored=${state.errored}`);
        } else if (field === 'runtime') {
            state.runtime = value as number;
            log(`[BetterPlutoServer] cellField ${cellId} runtime=${state.runtime}`);
        } else if (field === 'output') {
            // Full output object replacement
            state.output = this.extractOutput(value as Record<string, unknown>);
            // Also update tracked state
            this.cellOutputs.set(cellId, state.output);
            log(`[BetterPlutoServer] cellField ${cellId} output mime=${state.output?.mime}`);
        } else if (field === 'logs') {
            // Handle logs - can be array or single log object (when pushed via JSONPatch)
            if (Array.isArray(value)) {
                state.logs = this.extractLogs(value);
            } else if (value && typeof value === 'object') {
                // Single log entry being pushed
                const logEntry = this.extractSingleLog(value as Record<string, unknown>);
                if (logEntry) {
                    state.logs = [logEntry];
                }
            }
        } else {
            // Skip other fields
            return;
        }

        console.log(`[BetterPlutoServer] Cell ${cellId} field ${field}:`, JSON.stringify(value)?.slice(0, 100));
        this.emit('cellState', cellId, state);
    }

    /**
     * Extract a single log entry from Pluto format
     */
    private extractSingleLog(logObj: Record<string, unknown>): LogEntry | null {
        const level = String(logObj.level || 'LogLevel(-555)'); // Default to stdout level

        log(`[BetterPlutoServer] Single log entry: ${JSON.stringify(logObj).slice(0, 300)}`);

        // Extract message - msg is an array with [content, mime] format
        let msg = '';
        if (Array.isArray(logObj.msg) && logObj.msg.length > 0) {
            // msg format: ["Hi\n", "text/plain"]
            msg = String(logObj.msg[0] || '');
        }

        if (!msg) {return null;}

        const entry = {
            level,
            msg,
            line: logObj.line as number | undefined,
        };

        log(`[BetterPlutoServer] Extracted single log: ${JSON.stringify(entry)}`);
        return entry;
    }

    /**
     * Extract logs from Pluto format (array of logs)
     */
    private extractLogs(logsArray: unknown[]): LogEntry[] {
        if (!Array.isArray(logsArray)) {
            if (logsArray && typeof logsArray === 'object') {
                const values = Object.values(logsArray as Record<string, unknown>);
                console.log(`[BetterPlutoServer] Extracting ${values.length} logs from object`);
                const result = values.map(log => {
                    return this.extractSingleLog(log as Record<string, unknown>);
                }).filter((log): log is LogEntry => log !== null);
                console.log(`[BetterPlutoServer] Extracted logs:`, result);
                return result;
            }
            log(`[BetterPlutoServer] logs is not an array: ${typeof logsArray}`);
            return [];
        }

        console.log(`[BetterPlutoServer] Extracting ${logsArray.length} logs`);

        const result = logsArray.map(log => {
            return this.extractSingleLog(log as Record<string, unknown>);
        }).filter((log): log is LogEntry => log !== null);

        console.log(`[BetterPlutoServer] Extracted logs:`, result);
        return result;
    }

    /**
     * Handle nested output field update (e.g., output.body, output.mime)
     */
    private handleOutputSubField(cellId: string, subField: string, value: unknown): void {
        // Get or create tracked output for this cell
        let output = this.cellOutputs.get(cellId) || { body: '', mime: 'text/plain' };

        if (subField === 'body') {
            // Body can be string or object (for complex types like msgpack binary)
            // First try to decode msgpack binary format
            const decodedBody = this.tryDecodeMsgpackBinary(value, output.mime || 'text/plain');
            let newBody: string | undefined;

            if (decodedBody !== null) {
                newBody = decodedBody;
            } else if (typeof value === 'string') {
                newBody = value;
            } else if (value && typeof value === 'object') {
                // For complex output like errors, try to extract msg or stringify
                const obj = value as Record<string, unknown>;
                if (obj.msg) {
                    newBody = obj.msg as string;
                } else {
                    newBody = JSON.stringify(value);
                }
            }

            // For tree+object, don't overwrite existing data with just an objectid
            const isObjectIdOnly = output.mime === 'application/vnd.pluto.tree+object' &&
                                   isPlutoObjectId(newBody);
            if (isObjectIdOnly && output.body && output.body.length > 20) {
                console.log(`[BetterPlutoServer] Cell ${cellId} skipping objectid-only update, keeping existing tree data`);
                return; // Don't emit update
            }

            if (newBody !== undefined) {
                output.body = newBody;
            }
            console.log(`[BetterPlutoServer] Cell ${cellId} output.body: ${output.body?.slice(0, 100)}`);
        } else if (subField === 'mime') {
            output.mime = value as string;
            console.log(`[BetterPlutoServer] Cell ${cellId} output.mime: ${output.mime}`);
        } else if (subField === 'last_run_timestamp') {
            // last_run_timestamp update indicates cell evaluation is complete.
            // Critical for unchanged cells where Pluto skips running/runtime diffs
            // because those fields haven't changed from the previous execution.
            const state: Partial<CellState> = {
                cellId,
                running: false,
            };
            this.emit('cellState', cellId, state);
            return;
        } else {
            // Skip other subfields like rootassignee, etc.
            return;
        }

        this.cellOutputs.set(cellId, output);

        // Emit updated state
        const state: Partial<CellState> = {
            cellId,
            output: { body: output.body || '', mime: output.mime || 'text/plain' },
        };
        this.emit('cellState', cellId, state);
    }

    /**
     * Extract output body from Pluto output format
     */
    private extractOutput(output: Record<string, unknown>): { body: string; mime: string } {
        if (!output || typeof output !== 'object') {
            return { body: '', mime: 'text/plain' };
        }

        let body = '';
        const mime = (output.mime as string) || 'text/plain';

        if (output.body !== undefined) {
            // First, try to decode if it's already a msgpack binary format object
            const decodedBody = this.tryDecodeMsgpackBinary(output.body, mime);
            if (decodedBody !== null) {
                body = decodedBody;
            } else if (typeof output.body === 'string') {
                body = output.body;
            } else if (output.body instanceof Uint8Array || ArrayBuffer.isView(output.body)) {
                // Handle binary data (like PNG images)
                const bytes = output.body instanceof Uint8Array
                    ? output.body
                    : new Uint8Array((output.body as ArrayBufferView).buffer);
                // Convert to base64 for binary images
                if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
                    body = Buffer.from(bytes).toString('base64');
                } else {
                    // For text-based formats, decode as UTF-8
                    body = Buffer.from(bytes).toString('utf-8');
                }
            } else if (Array.isArray(output.body)) {
                // Might be a byte array as plain array
                if (output.body.every((v: unknown) => typeof v === 'number')) {
                    const bytes = new Uint8Array(output.body as number[]);
                    if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
                        body = Buffer.from(bytes).toString('base64');
                    } else {
                        body = Buffer.from(bytes).toString('utf-8');
                    }
                } else {
                    body = JSON.stringify(output.body);
                }
            } else if (output.body && typeof output.body === 'object') {
                // Other object types - stringify as fallback
                body = JSON.stringify(output.body);
            }
        }

        console.log(`[BetterPlutoServer] Extracted output mime: ${mime}, body length: ${body.length}, preview: ${body.slice(0, 50)}`);
        return { body, mime };
    }

    /**
     * Try to decode msgpack binary format: {type: 18, data: {0: byte0, 1: byte1, ...}}
     * Returns { bytes, isBase64 } or null if not in this format
     * For binary data, always returns base64 to preserve bytes
     */
    private tryDecodeMsgpackBinary(body: unknown, mime: string): string | null {
        console.log(`[BetterPlutoServer] tryDecodeMsgpackBinary: type=${typeof body}, isArray=${Array.isArray(body)}, isUint8Array=${body instanceof Uint8Array}`);

        // Handle Uint8Array or Buffer directly (from msgpack decoder)
        if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            console.log(`[BetterPlutoServer] Direct binary data: ${bytes.length} bytes, first 10: [${Array.from(bytes.slice(0, 10)).join(', ')}]`);

            const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
            const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
            const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

            if (isBinaryImage) {
                const result = Buffer.from(bytes).toString('base64');
                console.log(`[BetterPlutoServer] Direct binary -> base64: ${result.length} chars`);
                return result;
            } else {
                return Buffer.from(bytes).toString('utf-8');
            }
        }

        let dataObj: Record<string, number> | null = null;

        // First, try to parse if it's a JSON string
        let bodyToCheck = body;
        if (typeof body === 'string') {
            try {
                bodyToCheck = JSON.parse(body);
            } catch {
                // Not JSON, keep as string
                return null;
            }
        }

        // Check if it's an object with type: 18 and data
        if (bodyToCheck && typeof bodyToCheck === 'object' && !Array.isArray(bodyToCheck)) {
            const bodyObj = bodyToCheck as Record<string, unknown>;
            if (bodyObj.type === 18 && bodyObj.data && typeof bodyObj.data === 'object') {
                dataObj = bodyObj.data as Record<string, number>;
            }
        }

        if (!dataObj) {return null;}

        // Extract bytes from the data object
        const allKeys = Object.keys(dataObj);
        const keys = allKeys.map(k => parseInt(k)).filter(k => !isNaN(k)).sort((a, b) => a - b);

        console.log(`[BetterPlutoServer] Msgpack binary: ${allKeys.length} total keys, ${keys.length} numeric keys`);

        if (keys.length === 0) {return null;}

        // Check if keys are contiguous
        const maxKey = keys[keys.length - 1];
        const minKey = keys[0];
        console.log(`[BetterPlutoServer] Key range: ${minKey} to ${maxKey}, expected length: ${maxKey - minKey + 1}`);

        const bytes = new Uint8Array(maxKey + 1);
        for (const key of keys) {
            bytes[key] = dataObj[String(key)];
        }

        console.log(`[BetterPlutoServer] Decoded msgpack binary for ${mime}: ${bytes.length} bytes, first 10: [${Array.from(bytes.slice(0, 10)).join(', ')}]`);

        // Check if this looks like binary data (PNG, JPEG, etc.) by checking magic bytes
        const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

        // Decode as base64 for binary images, UTF-8 for text (SVG, HTML, etc.)
        let result: string;
        if (isBinaryImage) {
            result = Buffer.from(bytes).toString('base64');
            console.log(`[BetterPlutoServer] Base64 encoded (binary image detected): ${result.length} chars`);
        } else {
            result = Buffer.from(bytes).toString('utf-8');
        }

        console.log(`[BetterPlutoServer] Decoded msgpack binary: ${bytes.length} bytes -> ${result.length} chars`);
        return result;
    }

    /**
     * Run a cell
     */
    async runCell(cellId: string): Promise<void> {
        console.log(`[BetterPlutoServer] runCell request: ${cellId}`);
        this.sendMessage('run_multiple_cells', {
            cells: [cellId],
        });
    }

    /**
     * Run multiple cells at once (more efficient for Run All)
     */
    async runMultipleCells(cellIds: string[]): Promise<void> {
        this.sendMessage('run_multiple_cells', {
            cells: cellIds,
        });
    }

    /**
     * Set a bond value (for interactive widgets like Slider)
     * This triggers reactive execution of dependent cells
     */
    async setBond(name: string, value: unknown): Promise<void> {
        console.log(`[BetterPlutoServer] Setting bond ${name} to`, value);
        this.sendMessage('update_notebook', {
            updates: [{
                path: ['bonds', name],
                op: 'replace',
                value: { value },
            }],
        });
    }

    /**
     * Get a published object by its objectid
     * Used to expand "show more" in tree views
     */
    async getPublishedObject(objectid: string): Promise<unknown> {
        console.log(`[BetterPlutoServer] Getting published object: ${objectid}`);

        return new Promise((resolve, reject) => {
            const requestId = this.generateId();
            this.pendingObjectRequests.set(requestId, { resolve, reject });

            // Send the request
            if (!this.ws) {
                reject(new Error('WebSocket not initialized'));
                return;
            }

            const socket = this.ws as any;
            if (socket.readyState !== 1) {
                reject(new Error('WebSocket not open'));
                return;
            }

            const message = {
                type: 'get_published_object',
                client_id: this.clientId,
                request_id: requestId,
                body: { objectid },
                notebook_id: this.notebookId,
            };

            log(`[BetterPlutoServer] Sending get_published_object request: ${requestId}`);
            const encoded = encode(message);
            socket.send(Buffer.from(encoded));

            // Timeout after 10 seconds
            setTimeout(() => {
                if (this.pendingObjectRequests.has(requestId)) {
                    this.pendingObjectRequests.delete(requestId);
                    reject(new Error('Timeout waiting for published object'));
                }
            }, 10000);
        });
    }

    /**
     * Handle object_result response from Pluto
     */
    private handleObjectResult(message: Record<string, unknown>): void {
        const requestId = message.request_id as string;
        const body = message.body as Record<string, unknown>;

        log(`[BetterPlutoServer] Received object_result for request: ${requestId}`);

        const pending = this.pendingObjectRequests.get(requestId);
        if (pending) {
            this.pendingObjectRequests.delete(requestId);

            if (body?.success === false) {
                pending.reject(new Error(body.message as string || 'Failed to get object'));
            } else {
                pending.resolve(body?.object);
            }
        }
    }

    /**
     * Interrupt all running cells
     */
    async interruptAll(): Promise<void> {
        log('[BetterPlutoServer] Interrupting all cells');
        this.sendMessage('interrupt_all', {});
    }

    /**
     * Add a new cell to the notebook
     * Note: This only adds the cell_input. The cell_order is managed by Pluto automatically
     * when the notebook is saved/synced.
     */
    async addCell(cellId: string, index: number, code: string = ''): Promise<void> {
        console.log(`[BetterPlutoServer] Adding cell ${cellId} at index ${index}`);

        // First, add the cell to cell_inputs with its full structure
        // Then add to cell_order
        // This mimics how Pluto's frontend handles cell addition
        this.sendMessage('update_notebook', {
            updates: [
                // Add to cell_inputs first
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
                // Then add to cell_order
                // Note: We use 'add' with path ending in '-' to append,
                // or we need to replace the entire array
                {
                    path: ['cell_order'],
                    op: 'replace',
                    value: this.getCellOrderWithNewCell(cellId, index),
                },
            ],
        });

        // Track this cell as known
        this.knownCellIds.add(cellId);
    }

    /**
     * Get the current cell order with a new cell inserted at the given index
     */
    private getCellOrderWithNewCell(cellId: string, index: number): string[] {
        const newOrder = [...this.cellOrder];
        // Insert at the specified index
        newOrder.splice(index, 0, cellId);
        // Update our tracked order
        this.cellOrder = newOrder;
        return newOrder;
    }

    /**
     * Delete a cell from the notebook
     */
    async deleteCell(cellId: string, index: number): Promise<void> {
        console.log(`[BetterPlutoServer] Deleting cell ${cellId} at index ${index}`);

        // Update local tracking first
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

    /**
     * Delete a cell without updating cell_order
     * Used when cell order will be updated separately (e.g., during move operations)
     */
    async deleteCellOnly(cellId: string): Promise<void> {
        console.log(`[BetterPlutoServer] Deleting cell input only: ${cellId}`);

        this.knownCellIds.delete(cellId);

        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_inputs', cellId],
                    op: 'remove',
                },
            ],
        });
    }

    /**
     * Get the Pluto cell ID for a VS Code cell ID (handles ID mapping)
     */
    getPlutoCellId(vscodeCellId: string): string {
        return this.vscodeToPlutoId.get(vscodeCellId) || vscodeCellId;
    }
    
    /**
     * Get the VS Code cell ID for a Pluto cell ID (reverse mapping)
     */
    getVscodeCellId(plutoId: string): string {
        return this.plutoToVscodeId.get(plutoId) || plutoId;
    }
    
    /**
     * Wait for a cell to appear in Pluto's state (via auto-reload from file).
     * This is used after saving the notebook file with a new cell.
     * Returns the cell ID once Pluto recognizes it.
     */
    async waitForCellToAppear(cellId: string, code: string = ''): Promise<string> {
        log(`[BetterPlutoServer] Waiting for cell ${cellId} to appear in Pluto (via file auto-reload)`);
        
        // Mark this cell as pending
        this.pendingCellIds.add(cellId);
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            
            // Check if cell already exists
            if (this.knownCellIds.has(cellId)) {
                log(`[BetterPlutoServer] Cell ${cellId} already known to Pluto`);
                this.pendingCellIds.delete(cellId);
                resolve(cellId);
                return;
            }
            
            // Poll for the cell to appear
            const checkInterval = setInterval(async () => {
                // Check if cell appeared in knownCellIds
                if (this.knownCellIds.has(cellId)) {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    log(`[BetterPlutoServer] Cell ${cellId} detected in Pluto`);
                    this.pendingCellIds.delete(cellId);
                    
                    // Update the cell code to make sure it's correct
                    try {
                        await this.updateCell(cellId, code);
                    } catch (err) {
                        log(`[BetterPlutoServer] Failed to update cell code: ${err}`);
                    }
                    
                    resolve(cellId);
                    return;
                }
                
                // Request full state periodically to help detect new cells
                if ((Date.now() - startTime) % 1000 < 100) {
                    this.requestFullState();
                }
            }, 100);
            
            // Timeout after 10 seconds
            const timeout = setTimeout(() => {
                clearInterval(checkInterval);
                log(`[BetterPlutoServer] Timeout waiting for cell ${cellId} to appear in Pluto`);
                this.pendingCellIds.delete(cellId);
                // Return the original cellId even if not found
                resolve(cellId);
            }, 10000);
        });
    }
    
    /**
     * Legacy method - redirects to waitForCellToAppear
     * @deprecated Use waitForCellToAppear instead
     */
    async addCellOnly(cellId: string, code: string = ''): Promise<string> {
        return this.waitForCellToAppear(cellId, code);
    }

    /**
     * Update cell order (for drag-and-drop reordering)
     * This sends the new cell_order array to Pluto, triggering reactive re-evaluation
     */
    async updateCellOrder(newOrder: string[]): Promise<void> {
        console.log(`[BetterPlutoServer] Updating cell order: ${newOrder.length} cells`);

        // Update local tracking
        this.cellOrder = newOrder;

        // Send the update to Pluto - this will trigger reactive re-evaluation
        this.sendMessage('update_notebook', {
            updates: [
                {
                    path: ['cell_order'],
                    op: 'replace',
                    value: newOrder,
                },
            ],
        });
    }

    /**
     * Update cell code
     */
    async updateCell(cellId: string, code: string): Promise<void> {
        log(`[BetterPlutoServer] updateCell request: ${cellId}, length=${code.length}`);
        if (!this.knownCellIds.has(cellId)) {
            log(`[BetterPlutoServer] updateCell missing cell_inputs for ${cellId}, using addCellOnly`);
            // Use addCellOnly which waits for Pluto confirmation
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

    /**
     * Check if server is ready
     */
    get ready(): boolean {
        return this.isReady;
    }

    /**
     * Stop the server
     */
    stop(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.isReady = false;
    }

    /**
     * Find available port
     */
    private async findPort(): Promise<number> {
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
    }

    /**
     * Generate UUID
     */
    private generateId(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
