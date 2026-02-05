import * as assert from 'assert';
import { isPlutoObjectId, buildOutputItems, CachedOutput, escapeHtml, renderStdoutAsHtml } from '../output-utils';

suite('Output Utils - isPlutoObjectId', () => {
    test('returns true for valid 14-char hex objectid', () => {
        assert.strictEqual(isPlutoObjectId('a1b2c3d4e5f6a7'), true);
    });

    test('returns true for valid 16-char hex objectid', () => {
        assert.strictEqual(isPlutoObjectId('a1b2c3d4e5f6a7b8'), true);
    });

    test('returns true for uppercase hex objectid', () => {
        assert.strictEqual(isPlutoObjectId('A1B2C3D4E5F6A7'), true);
    });

    test('returns false for too short string (11 chars)', () => {
        assert.strictEqual(isPlutoObjectId('a1b2c3d4e5f'), false);
    });

    test('returns false for too long string (21 chars)', () => {
        assert.strictEqual(isPlutoObjectId('a1b2c3d4e5f6a7b8c9d0e'), false);
    });

    test('returns false for non-hex characters', () => {
        assert.strictEqual(isPlutoObjectId('a1b2c3d4e5f6g7'), false);
    });

    test('returns false for null', () => {
        assert.strictEqual(isPlutoObjectId(null), false);
    });

    test('returns false for undefined', () => {
        assert.strictEqual(isPlutoObjectId(undefined), false);
    });

    test('returns false for empty string', () => {
        assert.strictEqual(isPlutoObjectId(''), false);
    });

    test('returns false for regular text', () => {
        assert.strictEqual(isPlutoObjectId('hello world'), false);
    });

    test('returns false for JSON object string', () => {
        assert.strictEqual(isPlutoObjectId('{"type":"Array"}'), false);
    });

    test('handles whitespace-padded objectid', () => {
        assert.strictEqual(isPlutoObjectId('  a1b2c3d4e5f6a7  '), true);
    });
});

suite('Output Utils - buildOutputItems', () => {
    test('returns empty array for empty cached output', () => {
        const cached: CachedOutput = {};
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 0);
    });

    test('builds stdout item from logs', () => {
        const cached: CachedOutput = {
            logs: [
                { level: 'LogLevel(-555)', msg: 'Hello\n' },
                { level: 'LogLevel(-555)', msg: 'World\n' }
            ]
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'stdout');
        assert.strictEqual(items[0].content, 'Hello\nWorld\n');
    });

    test('builds text/html output with custom mime type', () => {
        const cached: CachedOutput = {
            body: '<div class="markdown"><h1>Hello</h1></div>',
            mime: 'text/html'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'application/vnd.pluto.html+html');
        assert.strictEqual(items[0].content, '<div class="markdown"><h1>Hello</h1></div>');
    });

    test('builds text/plain output', () => {
        const cached: CachedOutput = {
            body: 'Hello World',
            mime: 'text/plain'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'text/plain');
    });

    test('treats text/plain that looks like HTML as HTML', () => {
        const cached: CachedOutput = {
            body: '<div>HTML content</div>',
            mime: 'text/plain'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'application/vnd.pluto.html+html');
    });

    test('builds SVG output', () => {
        const cached: CachedOutput = {
            body: '<svg><circle/></svg>',
            mime: 'image/svg+xml'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'image/svg+xml');
    });

    test('builds PNG output as binary', () => {
        const pngBase64 = Buffer.from([137, 80, 78, 71]).toString('base64');
        const cached: CachedOutput = {
            body: pngBase64,
            mime: 'image/png'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'binary');
        assert.strictEqual(items[0].mime, 'image/png');
        assert.ok(items[0].content instanceof Uint8Array);
    });

    test('builds JSON output', () => {
        const cached: CachedOutput = {
            body: '{"data": [1, 2, 3]}',
            mime: 'application/vnd.plotly.v1+json'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'json');
        assert.strictEqual(items[0].mime, 'application/vnd.plotly.v1+json');
    });

    test('handles invalid JSON gracefully', () => {
        const cached: CachedOutput = {
            body: 'not valid json',
            mime: 'application/vnd.plotly.v1+json'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'text/plain');
    });

    test('builds stderr for syntax error', () => {
        const cached: CachedOutput = {
            body: 'syntax: unexpected token',
            mime: 'text/plain'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'stderr');
    });

    test('builds stderr for extra token error', () => {
        const cached: CachedOutput = {
            body: 'extra token after end of expression',
            mime: 'text/plain'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'stderr');
    });

    test('builds stderr for stacktrace', () => {
        const cached: CachedOutput = {
            body: '{"msg": "MethodError"}',
            mime: 'application/vnd.pluto.stacktrace+object'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'stderr');
    });

    test('skips tree+object output when body is objectid only', () => {
        const cached: CachedOutput = {
            body: 'a1b2c3d4e5f6a7',
            mime: 'application/vnd.pluto.tree+object'
        };
        const items = buildOutputItems(cached);
        // Should return empty because objectid-only tree output should be skipped
        assert.strictEqual(items.length, 0);
    });

    test('builds tree+object output when body has real data', () => {
        const cached: CachedOutput = {
            body: '{"type":"Array","elements":[[0,["1","text/plain"]]]}',
            mime: 'application/vnd.pluto.tree+object'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'application/vnd.pluto.html+html');
    });

    test('combines logs and body output', () => {
        const cached: CachedOutput = {
            body: '42',
            mime: 'text/plain',
            logs: [{ level: '', msg: 'Debug output\n' }]
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].type, 'stdout');
        assert.strictEqual(items[1].type, 'text');
    });

    test('defaults to text/plain when mime is missing', () => {
        const cached: CachedOutput = {
            body: 'some value'
        };
        const items = buildOutputItems(cached);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].mime, 'text/plain');
    });
});

suite('Output Utils - Race Condition Scenario', () => {
    /**
     * This test verifies the core behavior that fixes the race condition bug:
     * When Pluto sends initial state with outputs BEFORE execution objects exist,
     * the cached output should be preserved and correctly built into output items.
     *
     * The bug was: cellOutputs was deleted in runAllCellsOnStart(), erasing
     * the initial output data before it could be rendered.
     */
    test('preserves and builds cached HTML output (markdown cell scenario)', () => {
        // This simulates the exact scenario from the bug:
        // A markdown cell with md"""# The Basel problem...""" that renders to HTML
        const cached: CachedOutput = {
            body: '<div class="markdown"><h1 id="The-Basel-problem">The Basel problem</h1><p><em>Leonard Euler</em> proved in 1741...</p></div>',
            mime: 'text/html'
        };

        const items = buildOutputItems(cached);

        // The output should be preserved and correctly built
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
        assert.strictEqual(items[0].mime, 'application/vnd.pluto.html+html');
        assert.ok(items[0].content.toString().includes('The Basel problem'));
        assert.ok(items[0].content.toString().includes('Leonard Euler'));
    });

    test('cached output with lastCode field is handled correctly', () => {
        // The cached output may have lastCode for tracking code changes
        const cached: CachedOutput = {
            body: '<div>Result</div>',
            mime: 'text/html',
            lastCode: 'md"""# Hello"""'
        };

        const items = buildOutputItems(cached);

        // lastCode should not affect output building
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'text');
    });

    test('empty body but with logs still produces output', () => {
        // Sometimes output may arrive as logs only initially
        const cached: CachedOutput = {
            logs: [{ level: '', msg: 'Compiling packages...\n' }]
        };

        const items = buildOutputItems(cached);

        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'stdout');
        assert.strictEqual(items[0].content, 'Compiling packages...\n');
    });
});

suite('Output Utils - escapeHtml', () => {
    test('escapes ampersand', () => {
        assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    });

    test('escapes less than', () => {
        assert.strictEqual(escapeHtml('a < b'), 'a &lt; b');
    });

    test('escapes greater than', () => {
        assert.strictEqual(escapeHtml('a > b'), 'a &gt; b');
    });

    test('escapes double quotes', () => {
        assert.strictEqual(escapeHtml('a "b" c'), 'a &quot;b&quot; c');
    });

    test('escapes single quotes', () => {
        assert.strictEqual(escapeHtml("a 'b' c"), 'a &#039;b&#039; c');
    });

    test('escapes all special characters in one string', () => {
        assert.strictEqual(
            escapeHtml('<div class="test">a & b\'s</div>'),
            '&lt;div class=&quot;test&quot;&gt;a &amp; b&#039;s&lt;/div&gt;'
        );
    });

    test('returns empty string for empty input', () => {
        assert.strictEqual(escapeHtml(''), '');
    });

    test('returns unchanged string with no special characters', () => {
        assert.strictEqual(escapeHtml('Hello World'), 'Hello World');
    });
});

suite('Output Utils - renderStdoutAsHtml', () => {
    test('returns HTML with pluto-stdout-container class', () => {
        const html = renderStdoutAsHtml('Hello');
        assert.ok(html.includes('class="pluto-stdout-container"'));
    });

    test('returns HTML with pluto-stdout class', () => {
        const html = renderStdoutAsHtml('Hello');
        assert.ok(html.includes('class="pluto-stdout"'));
    });

    test('returns HTML with stdout label', () => {
        const html = renderStdoutAsHtml('Hello');
        assert.ok(html.includes('class="pluto-stdout-label"'));
        assert.ok(html.includes('stdout'));
    });

    test('escapes HTML characters in stdout content', () => {
        const html = renderStdoutAsHtml('<script>alert("xss")</script>');
        assert.ok(html.includes('&lt;script&gt;'));
        assert.ok(!html.includes('<script>alert'));
    });

    test('preserves newlines in pre tag', () => {
        const html = renderStdoutAsHtml('line1\nline2\nline3');
        assert.ok(html.includes('line1\nline2\nline3'));
    });

    test('includes CRT terminal styling CSS', () => {
        const html = renderStdoutAsHtml('test');
        assert.ok(html.includes('--inner: hsl(36deg 20% 37%)'));
        assert.ok(html.includes('color: #c0ffab'));
        assert.ok(html.includes('radial-gradient'));
    });

    test('includes terminal icon SVG', () => {
        const html = renderStdoutAsHtml('test');
        assert.ok(html.includes('<svg'));
        assert.ok(html.includes('viewBox="0 0 512 512"'));
    });

    test('wraps content in pre tag', () => {
        const html = renderStdoutAsHtml('test output');
        assert.ok(html.includes('<pre class="pluto-stdout">test output</pre>'));
    });

    test('handles empty string', () => {
        const html = renderStdoutAsHtml('');
        assert.ok(html.includes('<pre class="pluto-stdout"></pre>'));
    });

    test('handles multiline output with special characters', () => {
        const input = 'Line 1: x > 0\nLine 2: y < 10\nLine 3: "test"';
        const html = renderStdoutAsHtml(input);
        assert.ok(html.includes('x &gt; 0'));
        assert.ok(html.includes('y &lt; 10'));
        assert.ok(html.includes('&quot;test&quot;'));
    });
});
