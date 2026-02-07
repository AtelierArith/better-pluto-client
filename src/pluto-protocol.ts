import { isPlutoObjectId } from './output-utils';

export interface ProtocolLogEntry {
    level: string;
    msg: string;
    line?: number;
}

export interface ProtocolCellOutput {
    body: string;
    mime: string;
}

export interface ProtocolCellState {
    cellId: string;
    running: boolean;
    queued: boolean;
    output?: ProtocolCellOutput;
    errored: boolean;
    runtime?: number;
    logs?: ProtocolLogEntry[];
}

export interface ProtocolRuntimeState {
    cellOutputs: Map<string, { body?: string; mime?: string }>;
    knownCellIds: Set<string>;
    cellOrder: string[];
    pendingCellIds: Set<string>;
}

export interface ProtocolCellStateEvent {
    cellId: string;
    state: Partial<ProtocolCellState>;
}

export interface ProtocolProcessResult {
    nextState: ProtocolRuntimeState;
    events: ProtocolCellStateEvent[];
}

const RICH_OUTPUT_MIME_ORDER = [
    'text/html',
    'application/vnd.pluto.tree+object',
    'image/svg+xml',
    'image/png',
    'image/jpeg',
    'application/vnd.vega.v5+json',
    'application/vnd.plotly.v1+json',
    'text/plain',
];

export function tryDecodeMsgpackBinary(body: unknown, mime: string): string | null {
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

        if (isBinaryImage) {
            return Buffer.from(bytes).toString('base64');
        }
        return Buffer.from(bytes).toString('utf-8');
    }

    let bodyToCheck = body;
    if (typeof body === 'string') {
        try {
            bodyToCheck = JSON.parse(body);
        } catch {
            return null;
        }
    }

    let dataObj: Record<string, number> | null = null;
    if (bodyToCheck && typeof bodyToCheck === 'object' && !Array.isArray(bodyToCheck)) {
        const bodyObj = bodyToCheck as Record<string, unknown>;
        if (bodyObj.type === 18 && bodyObj.data && typeof bodyObj.data === 'object') {
            dataObj = bodyObj.data as Record<string, number>;
        }
    }

    if (!dataObj) {
        return null;
    }

    const keys = Object.keys(dataObj)
        .map((k) => parseInt(k, 10))
        .filter((k) => !isNaN(k))
        .sort((a, b) => a - b);

    if (keys.length === 0) {
        return null;
    }

    const maxKey = keys[keys.length - 1];
    const bytes = new Uint8Array(maxKey + 1);
    for (const key of keys) {
        bytes[key] = dataObj[String(key)];
    }

    const isPNG = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const isBinaryImage = isPNG || isJPEG || (mime.startsWith('image/') && mime !== 'image/svg+xml');

    if (isBinaryImage) {
        return Buffer.from(bytes).toString('base64');
    }
    return Buffer.from(bytes).toString('utf-8');
}

export function extractSingleLog(logObj: Record<string, unknown>): ProtocolLogEntry | null {
    const level = String(logObj.level || 'LogLevel(-555)');

    let msg = '';
    if (Array.isArray(logObj.msg) && logObj.msg.length > 0) {
        msg = String(logObj.msg[0] || '');
    }

    if (!msg) {
        return null;
    }

    return {
        level,
        msg,
        line: logObj.line as number | undefined,
    };
}

export function extractLogs(logsArray: unknown): ProtocolLogEntry[] {
    if (!Array.isArray(logsArray)) {
        if (logsArray && typeof logsArray === 'object') {
            return Object.values(logsArray as Record<string, unknown>)
                .map((log) => extractSingleLog(log as Record<string, unknown>))
                .filter((log): log is ProtocolLogEntry => log !== null);
        }
        return [];
    }

    return logsArray
        .map((log) => extractSingleLog(log as Record<string, unknown>))
        .filter((log): log is ProtocolLogEntry => log !== null);
}

export function extractOutput(output: Record<string, unknown>): ProtocolCellOutput {
    if (!output || typeof output !== 'object') {
        return { body: '', mime: 'text/plain' };
    }

    const hasBody = output.body !== undefined;
    const mimeFromShape = (output.mime as string) || 'text/plain';
    if (hasBody) {
        let body = '';
        const mime = mimeFromShape;
        const rawBody = output.body;
        const decodedBody = tryDecodeMsgpackBinary(rawBody, mime);
        if (decodedBody !== null) {
            body = decodedBody;
        } else if (typeof rawBody === 'string') {
            body = rawBody;
        } else if (rawBody instanceof Uint8Array || ArrayBuffer.isView(rawBody)) {
            const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array((rawBody as ArrayBufferView).buffer);
            body = mime.startsWith('image/') && mime !== 'image/svg+xml'
                ? Buffer.from(bytes).toString('base64')
                : Buffer.from(bytes).toString('utf-8');
        } else if (Array.isArray(rawBody)) {
            if (rawBody.every((v: unknown) => typeof v === 'number')) {
                const bytes = new Uint8Array(rawBody as number[]);
                body = mime.startsWith('image/') && mime !== 'image/svg+xml'
                    ? Buffer.from(bytes).toString('base64')
                    : Buffer.from(bytes).toString('utf-8');
            } else {
                body = JSON.stringify(rawBody);
            }
        } else if (rawBody && typeof rawBody === 'object') {
            body = JSON.stringify(rawBody);
        }

        if (body) {
            return { body, mime };
        }
    }

    for (const mime of RICH_OUTPUT_MIME_ORDER) {
        const value = output[mime];
        if (value === undefined) {
            continue;
        }

        let body = '';
        const decoded = tryDecodeMsgpackBinary(value, mime);
        if (decoded !== null) {
            body = decoded;
        } else if (typeof value === 'string') {
            body = value;
        } else if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
            const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as ArrayBufferView).buffer);
            body = mime.startsWith('image/') && mime !== 'image/svg+xml'
                ? Buffer.from(bytes).toString('base64')
                : Buffer.from(bytes).toString('utf-8');
        } else if (Array.isArray(value) && value.every((v: unknown) => typeof v === 'number')) {
            const bytes = new Uint8Array(value as number[]);
            body = mime.startsWith('image/') && mime !== 'image/svg+xml'
                ? Buffer.from(bytes).toString('base64')
                : Buffer.from(bytes).toString('utf-8');
        } else if (value !== null && typeof value === 'object') {
            body = JSON.stringify(value);
        }

        if (body) {
            return { body, mime };
        }
    }

    for (const [key, value] of Object.entries(output)) {
        if (key === 'body' || key === 'mime') {
            continue;
        }
        if (!key.includes('/')) {
            continue;
        }
        if (typeof value !== 'string') {
            continue;
        }
        if (value.length > 0) {
            return { body: value, mime: key };
        }
    }

    return { body: '', mime: mimeFromShape };
}

export function processNotebookDiff(
    message: Record<string, unknown>,
    state: ProtocolRuntimeState
): ProtocolProcessResult {
    const content = message.message as Record<string, unknown>;
    const patches = content?.patches as Array<{
        path: (string | number)[];
        op: string;
        value?: unknown;
    }>;

    if (!patches) {
        return {
            nextState: cloneState(state),
            events: [],
        };
    }

    const nextState = cloneState(state);
    const events: ProtocolCellStateEvent[] = [];

    const isOutputSubField = (p: { path: (string | number)[] }): boolean => {
        return p.path[0] === 'cell_results' && p.path.length >= 4 && p.path[2] === 'output';
    };

    const outputPatches = patches.filter(isOutputSubField);
    const otherPatches = patches.filter((p) => !isOutputSubField(p));

    for (const patch of [...outputPatches, ...otherPatches]) {
        const path = patch.path;

        if (path.length === 0 && patch.op === 'replace') {
            const fullState = patch.value as Record<string, unknown>;
            if (fullState?.cell_results) {
                handleFullCellResults(fullState.cell_results as Record<string, unknown>, nextState, events);
            }
            if (fullState?.cell_order && Array.isArray(fullState.cell_order)) {
                nextState.cellOrder = [...(fullState.cell_order as string[])];
                if (fullState?.cell_inputs && typeof fullState.cell_inputs === 'object') {
                    nextState.knownCellIds = new Set(Object.keys(fullState.cell_inputs as Record<string, unknown>));
                } else {
                    nextState.knownCellIds = new Set(nextState.cellOrder);
                }
            }
            continue;
        }

        if (path[0] === 'cell_inputs') {
            const cellId = path[1] as string;
            if (cellId) {
                if (patch.op === 'remove') {
                    nextState.knownCellIds.delete(cellId);
                    nextState.pendingCellIds.delete(cellId);
                } else if (patch.op === 'add' || patch.op === 'replace') {
                    nextState.knownCellIds.add(cellId);
                    nextState.pendingCellIds.delete(cellId);
                }
            }
            continue;
        }

        if (path[0] === 'cell_order' && patch.op === 'replace' && Array.isArray(patch.value)) {
            nextState.cellOrder = [...(patch.value as string[])];
            continue;
        }

        if (path[0] !== 'cell_results') {
            continue;
        }

        const cellId = path[1] as string;
        if (!cellId) {
            continue;
        }

        if (path.length === 2 && patch.op === 'replace') {
            handleCellResult(cellId, patch.value as Record<string, unknown>, nextState, events);
            continue;
        }

        const field = path[2] as string;
        if (field === 'output' && path.length >= 4) {
            const subField = path[3] as string;
            handleOutputSubField(cellId, subField, patch.value, nextState, events);
            continue;
        }

        handleCellField(cellId, field, patch.value, nextState, events);
    }

    return {
        nextState,
        events,
    };
}

function cloneState(state: ProtocolRuntimeState): ProtocolRuntimeState {
    return {
        cellOutputs: new Map(state.cellOutputs),
        knownCellIds: new Set(state.knownCellIds),
        cellOrder: [...state.cellOrder],
        pendingCellIds: new Set(state.pendingCellIds),
    };
}

function handleFullCellResults(
    cellResults: Record<string, unknown>,
    state: ProtocolRuntimeState,
    events: ProtocolCellStateEvent[]
): void {
    for (const [cellId, result] of Object.entries(cellResults)) {
        handleCellResult(cellId, result as Record<string, unknown>, state, events);
    }
}

function handleCellResult(
    cellId: string,
    result: Record<string, unknown>,
    state: ProtocolRuntimeState,
    events: ProtocolCellStateEvent[]
): void {
    if (!result) {
        return;
    }

    const cellState: Partial<ProtocolCellState> = { cellId };

    if (result.running !== undefined) {
        cellState.running = result.running as boolean;
    }
    if (result.errored !== undefined) {
        cellState.errored = result.errored as boolean;
    }
    if (result.runtime !== undefined) {
        cellState.runtime = result.runtime as number;
    }
    if (result.output) {
        const output = extractOutput(result.output as Record<string, unknown>);
        cellState.output = output;
        state.cellOutputs.set(cellId, output);
    }
    if (result.logs) {
        cellState.logs = extractLogs(result.logs);
    }

    events.push({ cellId, state: cellState });
}

function handleCellField(
    cellId: string,
    field: string,
    value: unknown,
    state: ProtocolRuntimeState,
    events: ProtocolCellStateEvent[]
): void {
    const cellState: Partial<ProtocolCellState> = { cellId };

    if (field === 'running') {
        cellState.running = value as boolean;
    } else if (field === 'queued') {
        cellState.queued = value as boolean;
    } else if (field === 'errored') {
        cellState.errored = value as boolean;
    } else if (field === 'runtime') {
        cellState.runtime = value as number;
    } else if (field === 'output') {
        const output = extractOutput(value as Record<string, unknown>);
        cellState.output = output;
        state.cellOutputs.set(cellId, output);
    } else if (field === 'logs') {
        if (Array.isArray(value)) {
            cellState.logs = extractLogs(value);
        } else if (value && typeof value === 'object') {
            const logEntry = extractSingleLog(value as Record<string, unknown>);
            if (logEntry) {
                cellState.logs = [logEntry];
            }
        }
    } else {
        return;
    }

    events.push({ cellId, state: cellState });
}

function handleOutputSubField(
    cellId: string,
    subField: string,
    value: unknown,
    state: ProtocolRuntimeState,
    events: ProtocolCellStateEvent[]
): void {
    const output = state.cellOutputs.get(cellId) || { body: '', mime: 'text/plain' };

    if (subField === 'body') {
        const decodedBody = tryDecodeMsgpackBinary(value, output.mime || 'text/plain');
        let newBody: string | undefined;

        if (decodedBody !== null) {
            newBody = decodedBody;
        } else if (typeof value === 'string') {
            newBody = value;
        } else if (value && typeof value === 'object') {
            const obj = value as Record<string, unknown>;
            if (obj.msg) {
                newBody = obj.msg as string;
            } else {
                newBody = JSON.stringify(value);
            }
        }

        const isObjectIdOnly = output.mime === 'application/vnd.pluto.tree+object' && isPlutoObjectId(newBody);
        if (isObjectIdOnly && output.body && output.body.length > 20) {
            return;
        }

        if (newBody !== undefined) {
            output.body = newBody;
        }
    } else if (subField === 'mime') {
        output.mime = value as string;
    } else if (subField === 'last_run_timestamp') {
        events.push({
            cellId,
            state: {
                cellId,
                running: false,
            },
        });
        return;
    } else if (subField.includes('/')) {
        const decodedBody = tryDecodeMsgpackBinary(value, subField);
        let newBody: string | undefined;
        if (decodedBody !== null) {
            newBody = decodedBody;
        } else if (typeof value === 'string') {
            newBody = value;
        } else if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
            const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as ArrayBufferView).buffer);
            newBody = subField.startsWith('image/') && subField !== 'image/svg+xml'
                ? Buffer.from(bytes).toString('base64')
                : Buffer.from(bytes).toString('utf-8');
        } else if (value !== null && typeof value === 'object') {
            newBody = JSON.stringify(value);
        }
        if (newBody !== undefined) {
            output.mime = subField;
            output.body = newBody;
        }
    } else {
        return;
    }

    state.cellOutputs.set(cellId, output);
    events.push({
        cellId,
        state: {
            cellId,
            output: {
                body: output.body || '',
                mime: output.mime || 'text/plain',
            },
        },
    });
}
