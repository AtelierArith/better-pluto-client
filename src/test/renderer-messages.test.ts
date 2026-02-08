import * as assert from 'assert';
import { isValidRendererMessage, isSetBondMessage, isShowMoreMessage } from '../renderer-messages';

suite('Renderer message validation (#83)', () => {
    suite('isValidRendererMessage', () => {
        test('accepts object with string type', () => {
            assert.strictEqual(isValidRendererMessage({ type: 'setBond' }), true);
            assert.strictEqual(isValidRendererMessage({ type: 'showMore' }), true);
            assert.strictEqual(isValidRendererMessage({ type: 'unknown' }), true);
        });

        test('rejects null/undefined', () => {
            assert.strictEqual(isValidRendererMessage(null), false);
            assert.strictEqual(isValidRendererMessage(undefined), false);
        });

        test('rejects non-object', () => {
            assert.strictEqual(isValidRendererMessage('string'), false);
            assert.strictEqual(isValidRendererMessage(42), false);
            assert.strictEqual(isValidRendererMessage(true), false);
        });

        test('rejects object without type', () => {
            assert.strictEqual(isValidRendererMessage({}), false);
            assert.strictEqual(isValidRendererMessage({ name: 'x' }), false);
        });

        test('rejects object with non-string type', () => {
            assert.strictEqual(isValidRendererMessage({ type: 123 }), false);
            assert.strictEqual(isValidRendererMessage({ type: null }), false);
            assert.strictEqual(isValidRendererMessage({ type: true }), false);
        });
    });

    suite('isSetBondMessage', () => {
        test('accepts valid setBond message', () => {
            assert.strictEqual(isSetBondMessage({ type: 'setBond', name: 'x', value: 42 }), true);
            assert.strictEqual(isSetBondMessage({ type: 'setBond', name: 'slider', value: 'hello' }), true);
        });

        test('accepts setBond without value (value is optional in JS)', () => {
            assert.strictEqual(isSetBondMessage({ type: 'setBond', name: 'x' }), true);
        });

        test('rejects wrong type', () => {
            assert.strictEqual(isSetBondMessage({ type: 'showMore', name: 'x' }), false);
            assert.strictEqual(isSetBondMessage({ type: 'other' }), false);
        });

        test('rejects missing name', () => {
            assert.strictEqual(isSetBondMessage({ type: 'setBond' }), false);
        });

        test('rejects non-string name', () => {
            assert.strictEqual(isSetBondMessage({ type: 'setBond', name: 123 }), false);
            assert.strictEqual(isSetBondMessage({ type: 'setBond', name: null }), false);
        });
    });

    suite('isShowMoreMessage', () => {
        test('accepts valid showMore message', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', cellId: 'abc', objectid: 'def', dim: 1 }), true);
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', cellId: 'abc', objectid: 'def' }), true);
        });

        test('rejects wrong type', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'setBond', cellId: 'abc', objectid: 'def' }), false);
        });

        test('rejects missing cellId', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', objectid: 'def' }), false);
        });

        test('rejects missing objectid', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', cellId: 'abc' }), false);
        });

        test('rejects non-string cellId', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', cellId: 123, objectid: 'def' }), false);
        });

        test('rejects non-string objectid', () => {
            assert.strictEqual(isShowMoreMessage({ type: 'showMore', cellId: 'abc', objectid: 123 }), false);
        });
    });
});
