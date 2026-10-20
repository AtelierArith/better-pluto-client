import * as assert from 'assert';
import { toggleBeginEnd } from '../begin-end-toggle';

suite('begin/end toggle', () => {
    test('wraps and unwraps without modifying source indentation', () => {
        for (const code of ['', 'x = 1\ny = 2', '  x = 1\n', 'x = 1\r\ny = 2']) {
            const wrapped = toggleBeginEnd(code);
            assert.strictEqual(wrapped.unwrapped, false);
            assert.strictEqual(toggleBeginEnd(wrapped.code).code, code);
        }
    });
    test('unwraps only one outer block and preserves nested blocks', () => {
        const inner = '    if true\n        begin\n            x = 1\n        end\n    end';
        assert.deepStrictEqual(toggleBeginEnd(`begin\n${inner}\nend`), { code: inner, unwrapped: true });
    });
    test('does not mistake identifiers or two separate blocks for a wrapper', () => {
        for (const code of ['beginning = friend', 'begin\nx = 1\nend\nbegin\ny = 2\nend', 'begin\nif true\nx = 1\nend']) {
            assert.strictEqual(toggleBeginEnd(code).unwrapped, false);
        }
    });
    test('ignores keywords in comments, strings, commands, and indexing', () => {
        const inner = '    # end\n    #= begin #= end =# end =#\n    s = "begin end"\n    c = `echo end`\n    x = A[begin:end]\n    q = :end\n    y = A\'';
        assert.strictEqual(toggleBeginEnd(`begin\n${inner}\nend`).code, inner);
    });
    test('preserves multiline literal bytes when wrapping and unwrapping', () => {
        const code = 's = """\n  begin\nend\n  """';
        assert.strictEqual(toggleBeginEnd(toggleBeginEnd(code).code).code, code);
    });
    test('preserves leading/trailing blank lines outside an existing wrapper', () => {
        assert.strictEqual(toggleBeginEnd('\nbegin\n    x = 1\nend\n').code, '\n    x = 1\n');
    });
    test('does not unwrap unclosed delimiters, literals or comments', () => {
        for (const inner of ['x = "oops', 'x = (1', '#= comment', 'x = [1)']) {
            assert.strictEqual(toggleBeginEnd(`begin\n${inner}\nend`).unwrapped, false);
        }
    });
});
