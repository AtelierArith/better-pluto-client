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

    test('shouldEndExecution does not end on runtime alone', () => {
        // runtime alone should not cause completion (prevents premature termination
        // when accumulated state carries a previous runtime value)
        assert.strictEqual(shouldEndExecution({ runtime: 0 }), false);
        assert.strictEqual(shouldEndExecution({ runtime: 1.5 }), false);
    });

    test('shouldEndExecution returns true on running=false with runtime', () => {
        assert.strictEqual(shouldEndExecution({ running: false, queued: false, runtime: 1.5 }), true);
    });

    test('shouldEndExecution returns true on errored', () => {
        assert.strictEqual(shouldEndExecution({ errored: true }), true);
    });

    test('shouldEndExecution returns false while still queued', () => {
        assert.strictEqual(shouldEndExecution({ running: false, queued: true }), false);
    });
});
