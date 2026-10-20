/** Cell-level navigation using Pluto's dependency graph, never inferred Julia syntax. */
export class PlutoNavigationState {
    private state: Record<string, unknown> = Object.create(null);
    private topologyCurrent = false;
    private hasSnapshot = false;
    private dirtyCellIds = new Set<string>();
    private removedCellIds = new Set<string>();
    private refreshRequested = false;

    clear(): void {
        this.state = Object.create(null);
        this.topologyCurrent = false;
        this.hasSnapshot = false;
        this.dirtyCellIds.clear();
        this.removedCellIds.clear();
        this.refreshRequested = false;
    }

    applyNotebookDiff(message: Record<string, unknown>): void {
        const content = message.message as { patches?: unknown } | undefined;
        if (!Array.isArray(content?.patches)) { return; }
        const previousInputs = this.inputCodes();
        let receivedDependencies = false;
        let fullSnapshot = false;
        for (const patch of content.patches) {
            if (!patch || !Array.isArray(patch.path)) { continue; }
            const path: unknown[] = patch.path;
            if (path.length === 0 && (patch.op === 'replace' || patch.op === 'add')) {
                fullSnapshot = true;
                receivedDependencies = isRecord(patch.value) && isRecord(patch.value.cell_dependencies);
                this.state = Object.create(null);
                if (isRecord(patch.value)) {
                    for (const key of ['cell_dependencies', 'cell_inputs']) {
                        if (isRecord(patch.value[key])) {
                            this.state[key] = cloneValue(patch.value[key]);
                        }
                    }
                }
                continue;
            }
            if (path[0] !== 'cell_dependencies' && path[0] !== 'cell_inputs') { continue; }
            if (!path.every(part => typeof part === 'string' || typeof part === 'number')) { continue; }
            // Never traverse Object.prototype even with a malformed server payload.
            if (path.some(part => part === '__proto__' || part === 'constructor' || part === 'prototype')) { continue; }
            if (!['replace', 'add', 'remove'].includes(patch.op)) { continue; }
            applyPatch(this.state, path as Array<string | number>, patch.op, patch.value);
            receivedDependencies ||= path[0] === 'cell_dependencies';
        }
        const currentInputs = this.inputCodes();
        const changed = [...currentInputs.keys()].filter(id => previousInputs.get(id) !== currentInputs.get(id));
        const removed = [...previousInputs.keys()].filter(id => !currentInputs.has(id));
        if (fullSnapshot && !this.hasSnapshot) {
            this.hasSnapshot = true;
            this.topologyCurrent = receivedDependencies;
        } else if (changed.length || removed.length) {
            this.topologyCurrent = false;
            for (const id of changed) { this.dirtyCellIds.add(id); this.removedCellIds.delete(id); }
            for (const id of removed) { this.dirtyCellIds.delete(id); this.removedCellIds.add(id); }
            this.refreshRequested = false;
        } else if (fullSnapshot && receivedDependencies && this.dirtyCellIds.size === 0 && this.deletionsAcknowledged()) {
            // Only a complete snapshot after the changed cells have finished can
            // validate unchanged dependency maps. Unrelated partial patches cannot.
            this.topologyCurrent = true;
            this.removedCellIds.clear();
            this.refreshRequested = false;
        }
    }

    get needsRefresh(): boolean { return this.hasSnapshot && !this.topologyCurrent; }

    /** Return true once when all edited cells have reached a terminal run state. */
    cellFinished(cellId: string): boolean {
        if (!this.dirtyCellIds.delete(cellId)) { return false; }
        return this.requestRefreshWhenReady();
    }

    /** Deleting a cell has no terminal run; wait for its topology entry to disappear. */
    takeDeletionRefresh(): boolean {
        return this.removedCellIds.size > 0 && this.requestRefreshWhenReady();
    }

    private requestRefreshWhenReady(): boolean {
        if (!this.needsRefresh || this.dirtyCellIds.size > 0 || this.refreshRequested) { return false; }
        if (!this.deletionsAcknowledged()) { return false; }
        this.refreshRequested = true;
        return true;
    }

    private deletionsAcknowledged(): boolean {
        const dependencies = this.state.cell_dependencies;
        return this.removedCellIds.size === 0 || (isRecord(dependencies) &&
            [...this.removedCellIds].every(id => !Object.hasOwn(dependencies, id)));
    }

    private inputCodes(): Map<string, unknown> {
        const inputs = this.state.cell_inputs;
        return new Map(isRecord(inputs)
            ? Object.keys(inputs).map(id => [id, isRecord(inputs[id]) ? inputs[id].code : null])
            : []);
    }

    matchesCode(cellId: string, code: string): boolean {
        const inputs = this.state.cell_inputs;
        return isRecord(inputs) && isRecord(inputs[cellId]) && inputs[cellId].code === code;
    }

    definitionCellIds(cellId: string, code: string, symbol: string): string[] {
        if (!this.topologyCurrent || !this.matchesCode(cellId, code)) { return []; }
        const dependencies = this.state.cell_dependencies;
        if (!isRecord(dependencies) || !isRecord(dependencies[cellId])) { return []; }
        const upstream = dependencies[cellId].upstream_cells_map;
        if (!isRecord(upstream) || !Object.hasOwn(upstream, symbol)) { return []; }
        const ids = upstream[symbol];
        return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== cellId))] : [];
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(cloneValue); }
    if (isRecord(value)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value)) { result[key] = cloneValue(item); }
        return result;
    }
    return value;
}

function applyPatch(target: Record<string, unknown> | unknown[], path: Array<string | number>, op: string, value: unknown): void {
    const key = String(path[0]);
    if (path.length === 1) {
        if (Array.isArray(target)) {
            const index = Number(key);
            if (!Number.isInteger(index) || index < 0 || index > target.length) { return; }
            if (op === 'remove') { target.splice(index, 1); }
            else if (op === 'add') { target.splice(index, 0, cloneValue(value)); }
            else { target[index] = cloneValue(value); }
        } else if (op === 'remove') { delete target[key]; }
        else { target[key] = cloneValue(value); }
        return;
    }
    const object = target as Record<string, unknown>;
    if (!Object.hasOwn(object, key) || object[key] === null || typeof object[key] !== 'object') {
        if (op === 'remove') { return; }
        object[key] = typeof path[1] === 'number' ? [] : Object.create(null);
    }
    applyPatch(object[key] as Record<string, unknown>, path.slice(1), op, value);
}
