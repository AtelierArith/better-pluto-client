import * as assert from 'assert';
import { isScriptSrcAllowed, isInlineScriptAllowed } from '../pluto-sanitizer';

suite('isScriptSrcAllowed', () => {
    test('allows Plotly CDN', () => {
        assert.strictEqual(isScriptSrcAllowed('https://cdn.plot.ly/plotly-2.27.0.min.js'), true);
    });

    test('allows jsdelivr CDN', () => {
        assert.strictEqual(isScriptSrcAllowed('https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js'), true);
    });

    test('allows cdnjs', () => {
        assert.strictEqual(isScriptSrcAllowed('https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.27.0/plotly.min.js'), true);
    });

    test('allows unpkg', () => {
        assert.strictEqual(isScriptSrcAllowed('https://unpkg.com/htl@0.3.1'), true);
    });

    test('allows mathjax CDN', () => {
        assert.strictEqual(isScriptSrcAllowed('https://cdn.mathjax.org/mathjax/latest/MathJax.js'), true);
    });

    test('blocks HTTP scripts', () => {
        assert.strictEqual(isScriptSrcAllowed('http://cdn.plot.ly/plotly.js'), false);
    });

    test('blocks unknown domains', () => {
        assert.strictEqual(isScriptSrcAllowed('https://evil.example.com/malware.js'), false);
    });

    test('blocks javascript: protocol', () => {
        assert.strictEqual(isScriptSrcAllowed('javascript:alert(1)'), false);
    });

    test('blocks data: protocol', () => {
        assert.strictEqual(isScriptSrcAllowed('data:text/javascript,alert(1)'), false);
    });

    test('blocks empty string', () => {
        assert.strictEqual(isScriptSrcAllowed(''), false);
    });

    test('blocks relative paths', () => {
        assert.strictEqual(isScriptSrcAllowed('/local/script.js'), false);
    });
});

suite('isInlineScriptAllowed', () => {
    test('allows empty scripts', () => {
        assert.strictEqual(isInlineScriptAllowed(''), true);
    });

    test('allows whitespace-only scripts', () => {
        assert.strictEqual(isInlineScriptAllowed('   \n  '), true);
    });

    test('allows currentScript polyfill wrapper', () => {
        const wrapped = `
            (function() {
                var currentScript = document.currentScript;
                console.log("hello");
            })();
        `;
        assert.strictEqual(isInlineScriptAllowed(wrapped), true);
    });

    test('allows typical PlutoUI script content', () => {
        const script = 'let x = 1 + 2; console.log(x);';
        assert.strictEqual(isInlineScriptAllowed(script), true);
    });
});
