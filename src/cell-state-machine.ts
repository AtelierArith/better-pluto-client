export interface CellExecutionState {
    running?: boolean;
    queued?: boolean;
    errored?: boolean;
    runtime?: number;
}

export function accumulateExecutionState(
    current: CellExecutionState,
    update: Partial<CellExecutionState>
): CellExecutionState {
    return {
        running: update.running !== undefined ? update.running : current.running,
        queued: update.queued !== undefined ? update.queued : current.queued,
        errored: update.errored !== undefined ? update.errored : current.errored,
        runtime: update.runtime !== undefined ? update.runtime : current.runtime,
    };
}

export function shouldEndExecution(state: Partial<CellExecutionState>): boolean {
    return (state.running === false && state.queued !== true) ||
           (state.runtime !== undefined && state.runtime >= 0) ||
           (state.errored === true);
}
