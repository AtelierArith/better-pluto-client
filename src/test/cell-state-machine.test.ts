import * as assert from 'assert';
import { accumulateExecutionState, shouldEndExecution } from '../cell-state-machine';

suite('cell-state-machine', () => {
    test('accumulateExecutionState merges partial updates', () => {
        const state = accumulateExecutionState(
            { running: true, queued: true },
            { queued: false, runtime: 10 }
        );

        assert.deepStrictEqual(state, {
            running: true,
            queued: false,
            runtime: 10,
            errored: undefined,
        });
    });

    test('shouldEndExecution returns true on running=false and not queued', () => {
        assert.strictEqual(shouldEndExecution({ running: false, queued: false }), true);
    });

    test('shouldEndExecution returns true on runtime', () => {
        assert.strictEqual(shouldEndExecution({ runtime: 0 }), true);
    });

    test('shouldEndExecution returns true on errored', () => {
        assert.strictEqual(shouldEndExecution({ errored: true }), true);
    });

    test('shouldEndExecution returns false while still queued', () => {
        assert.strictEqual(shouldEndExecution({ running: false, queued: true }), false);
    });
});
