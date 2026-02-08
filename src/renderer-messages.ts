/**
 * Renderer message types and validation for communication between
 * the pluto-html-renderer webview and the VS Code extension.
 */

export interface SetBondMessage {
    type: 'setBond';
    name: string;
    value: unknown;
}

export interface ShowMoreMessage {
    type: 'showMore';
    cellId: string;
    objectid: string;
    dim: number;
}

export type RendererMessage = SetBondMessage | ShowMoreMessage;

export function isValidRendererMessage(msg: unknown): msg is Record<string, unknown> & { type: string } {
    return typeof msg === 'object' && msg !== null && typeof (msg as Record<string, unknown>).type === 'string';
}

export function isSetBondMessage(msg: Record<string, unknown>): msg is Record<string, unknown> & SetBondMessage {
    return msg.type === 'setBond' && typeof msg.name === 'string';
}

export function isShowMoreMessage(msg: Record<string, unknown>): msg is Record<string, unknown> & ShowMoreMessage {
    return msg.type === 'showMore'
        && typeof msg.cellId === 'string'
        && typeof msg.objectid === 'string';
}
