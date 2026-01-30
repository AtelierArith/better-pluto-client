/**
 * PlutoServer - Connect to Pluto.jl server for reactive execution
 */

import { spawn, ChildProcess } from 'child_process';
import { createConnection, Socket } from 'net';
import { encode, decode } from '@msgpack/msgpack';
import { EventEmitter } from 'events';

/**
 * Check if a string is a Pluto objectid (12-20 character hex string)
 */
function isPlutoObjectId(str: string | undefined | null): boolean {
    if (!str) return false;
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

    // Track pending get_published_object requests
    private pendingObjectRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();

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
     * Start Pluto server and open notebook
     */
    async start(notebookPath: string): Promise<void> {
        this.port = await this.findPort();

        console.log(`[PlutoServer] Starting on port ${this.port}`);

        const juliaCode = `
            import Pluto

            session = Pluto.ServerSession(;
                options = Pluto.Configuration.from_flat_kwargs(;
                    launch_browser = false,
                    port = ${this.port},
                    require_secret_for_access = false,
                    require_secret_for_open_links = false,
                    disable_writing_notebook_files = true,
                    auto_reload_from_file = false,
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
                        console.log('[PlutoServer] Notebook ID:', this.notebookId);
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
                    console.log('[PlutoServer] HTTP server is ready, connecting WebSocket...');

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
                console.log('[PlutoServer] Process exited with code', code);
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
            console.log('[PlutoServer] Connecting to', url);

            try {
                const socket = new WS(url);
                this.ws = socket as unknown as WebSocket;

                socket.on('open', () => {
                    console.log('[PlutoServer] WebSocket connected');

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
                    console.error('[PlutoServer] WebSocket error:', err.message);
                    reject(new Error(`WebSocket connection failed: ${err.message}`));
                });

                socket.on('close', () => {
                    console.log('[PlutoServer] WebSocket closed');
                    this.emit('closed');
                });
            } catch (err) {
                console.error('[PlutoServer] Failed to create WebSocket:', err);
                reject(err);
            }
        });
    }

    /**
     * Send message to Pluto server
     */
    private sendMessage(type: string, body: Record<string, unknown> = {}): void {
        if (!this.ws) {
            console.error('[PlutoServer] Cannot send message, WebSocket not initialized');
            return;
        }

        // Check if socket is open (readyState 1 = OPEN)
        const socket = this.ws as any;
        if (socket.readyState !== 1) {
            console.error('[PlutoServer] Cannot send message, WebSocket not open (state:', socket.readyState, ')');
            return;
        }

        const message = {
            type,
            client_id: this.clientId,
            request_id: this.generateId(),
            body,
            notebook_id: this.notebookId,
        };

        console.log('[PlutoServer] Sending:', type);
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

            console.log('[PlutoServer] Received:', type);

            if (type === '👋') {
                console.log('[PlutoServer] Got welcome message from Pluto');
            } else if (type === 'notebook_diff') {
                this.handleNotebookDiff(message);
            } else if (type === 'object_result') {
                this.handleObjectResult(message);
            }
        } catch (err) {
            console.error('[PlutoServer] Error handling message:', err);
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

        if (!patches) return;

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
                    this.knownCellIds = new Set(this.cellOrder);
                    console.log(`[PlutoServer] Initial cell order: ${this.cellOrder.length} cells`);
                }
                continue;
            }

            // Only handle cell_results patches
            if (path[0] !== 'cell_results') continue;

            const cellId = path[1] as string;
            if (!cellId) continue;

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
        console.log('[PlutoServer] Processing full cell results');
        for (const [cellId, result] of Object.entries(cellResults)) {
            this.handleCellResult(cellId, result as Record<string, unknown>);
        }
    }

    /**
     * Handle a single cell's full result
     */
    private handleCellResult(cellId: string, result: Record<string, unknown>): void {
        if (!result) return;

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
            console.log(`[PlutoServer] Cell ${cellId} has ${state.logs?.length || 0} logs`);
        }

        console.log(`[PlutoServer] Cell ${cellId} full result:`, JSON.stringify(state).slice(0, 200));
        this.emit('cellState', cellId, state);
    }

    /**
     * Handle a single field update for a cell
     */
    private handleCellField(cellId: string, field: string, value: unknown): void {
        const state: Partial<CellState> = { cellId };

        if (field === 'running') {
            state.running = value as boolean;
        } else if (field === 'queued') {
            state.queued = value as boolean;
        } else if (field === 'errored') {
            state.errored = value as boolean;
        } else if (field === 'runtime') {
            state.runtime = value as number;
        } else if (field === 'output') {
            // Full output object replacement
            state.output = this.extractOutput(value as Record<string, unknown>);
            // Also update tracked state
            this.cellOutputs.set(cellId, state.output);
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

        console.log(`[PlutoServer] Cell ${cellId} field ${field}:`, JSON.stringify(value)?.slice(0, 100));
        this.emit('cellState', cellId, state);
    }

    /**
     * Extract a single log entry from Pluto format
     */
    private extractSingleLog(logObj: Record<string, unknown>): LogEntry | null {
        const level = String(logObj.level || 'LogLevel(-555)'); // Default to stdout level

        console.log('[PlutoServer] Single log entry:', JSON.stringify(logObj).slice(0, 300));

        // Extract message - msg is an array with [content, mime] format
        let msg = '';
        if (Array.isArray(logObj.msg) && logObj.msg.length > 0) {
            // msg format: ["Hi\n", "text/plain"]
            msg = String(logObj.msg[0] || '');
        }

        if (!msg) return null;

        const entry = {
            level,
            msg,
            line: logObj.line as number | undefined,
        };

        console.log('[PlutoServer] Extracted single log:', entry);
        return entry;
    }

    /**
     * Extract logs from Pluto format (array of logs)
     */
    private extractLogs(logsArray: unknown[]): LogEntry[] {
        if (!Array.isArray(logsArray)) {
            console.log('[PlutoServer] logs is not an array:', typeof logsArray);
            return [];
        }

        console.log(`[PlutoServer] Extracting ${logsArray.length} logs`);

        const result = logsArray.map(log => {
            return this.extractSingleLog(log as Record<string, unknown>);
        }).filter((log): log is LogEntry => log !== null);

        console.log(`[PlutoServer] Extracted logs:`, result);
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
                console.log(`[PlutoServer] Cell ${cellId} skipping objectid-only update, keeping existing tree data`);
                return; // Don't emit update
            }

            if (newBody !== undefined) {
                output.body = newBody;
            }
            console.log(`[PlutoServer] Cell ${cellId} output.body: ${output.body?.slice(0, 100)}`);
        } else if (subField === 'mime') {
            output.mime = value as string;
            console.log(`[PlutoServer] Cell ${cellId} output.mime: ${output.mime}`);
        } else {
            // Skip other subfields like last_run_timestamp, rootassignee, etc.
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

        console.log(`[PlutoServer] Extracted output mime: ${mime}, body length: ${body.length}, preview: ${body.slice(0, 50)}`);
        return { body, mime };
    }

    /**
     * Try to decode msgpack binary format: {type: 18, data: {0: byte0, 1: byte1, ...}}
     * Returns { bytes, isBase64 } or null if not in this format
     * For binary data, always returns base64 to preserve bytes
     */
    private tryDecodeMsgpackBinary(body: unknown, mime: string): string | null {
        console.log(`[PlutoServer] tryDecodeMsgpackBinary: type=${typeof body}, isArray=${Array.isArray(body)}, isUint8Array=${body instanceof Uint8Array}`);

        // Handle Uint8Array or Buffer directly (from msgpack decoder)
        if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            console.log(`[PlutoServer] Direct binary data: ${bytes.length} bytes, first 10: [${Array.from(bytes.slice(0, 10)).join(', ')}]`);

            const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
            const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
            const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

            if (isBinaryImage) {
                const result = Buffer.from(bytes).toString('base64');
                console.log(`[PlutoServer] Direct binary -> base64: ${result.length} chars`);
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

        if (!dataObj) return null;

        // Extract bytes from the data object
        const allKeys = Object.keys(dataObj);
        const keys = allKeys.map(k => parseInt(k)).filter(k => !isNaN(k)).sort((a, b) => a - b);

        console.log(`[PlutoServer] Msgpack binary: ${allKeys.length} total keys, ${keys.length} numeric keys`);

        if (keys.length === 0) return null;

        // Check if keys are contiguous
        const maxKey = keys[keys.length - 1];
        const minKey = keys[0];
        console.log(`[PlutoServer] Key range: ${minKey} to ${maxKey}, expected length: ${maxKey - minKey + 1}`);

        const bytes = new Uint8Array(maxKey + 1);
        for (const key of keys) {
            bytes[key] = dataObj[String(key)];
        }

        console.log(`[PlutoServer] Decoded msgpack binary for ${mime}: ${bytes.length} bytes, first 10: [${Array.from(bytes.slice(0, 10)).join(', ')}]`);

        // Check if this looks like binary data (PNG, JPEG, etc.) by checking magic bytes
        const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

        // Decode as base64 for binary images, UTF-8 for text (SVG, HTML, etc.)
        let result: string;
        if (isBinaryImage) {
            result = Buffer.from(bytes).toString('base64');
            console.log(`[PlutoServer] Base64 encoded (binary image detected): ${result.length} chars`);
        } else {
            result = Buffer.from(bytes).toString('utf-8');
        }

        console.log(`[PlutoServer] Decoded msgpack binary: ${bytes.length} bytes -> ${result.length} chars`);
        return result;
    }

    /**
     * Run a cell
     */
    async runCell(cellId: string): Promise<void> {
        this.sendMessage('run_multiple_cells', {
            cells: [cellId],
        });
    }

    /**
     * Set a bond value (for interactive widgets like Slider)
     * This triggers reactive execution of dependent cells
     */
    async setBond(name: string, value: unknown): Promise<void> {
        console.log(`[PlutoServer] Setting bond ${name} to`, value);
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
        console.log(`[PlutoServer] Getting published object: ${objectid}`);

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

            console.log('[PlutoServer] Sending get_published_object request:', requestId);
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

        console.log('[PlutoServer] Received object_result for request:', requestId);

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
        console.log('[PlutoServer] Interrupting all cells');
        this.sendMessage('interrupt_all', {});
    }

    /**
     * Add a new cell to the notebook
     * Note: This only adds the cell_input. The cell_order is managed by Pluto automatically
     * when the notebook is saved/synced.
     */
    async addCell(cellId: string, index: number, code: string = ''): Promise<void> {
        console.log(`[PlutoServer] Adding cell ${cellId} at index ${index}`);

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
        console.log(`[PlutoServer] Deleting cell ${cellId} at index ${index}`);

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
     * Update cell order (for drag-and-drop reordering)
     * This sends the new cell_order array to Pluto, triggering reactive re-evaluation
     */
    async updateCellOrder(newOrder: string[]): Promise<void> {
        console.log(`[PlutoServer] Updating cell order: ${newOrder.length} cells`);

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
