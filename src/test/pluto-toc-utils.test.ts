import * as assert from 'assert';
import { isTableOfContentsLike } from '../pluto-toc-utils';

suite('pluto-toc-utils - isTableOfContentsLike', () => {
    test('returns true for script starting with scrollIntoView', () => {
        const html = `<script>
const {default: scrollIntoView} = await import("data:text/javascript;base64,...");
</script>`;
        assert.strictEqual(isTableOfContentsLike(html), true);
    });

    test('returns true for HTML containing scrollIntoView and TableOfContents', () => {
        assert.strictEqual(isTableOfContentsLike('<div>TableOfContents</div><script>scrollIntoView</script>'), true);
    });

    test('returns true for script tag with table-of-contents', () => {
        assert.strictEqual(isTableOfContentsLike('<script>// table-of-contents widget</script>'), true);
    });

    test('returns false for plain markdown HTML', () => {
        const html = '<div class="markdown"><h1 id="x">Title</h1></div>';
        assert.strictEqual(isTableOfContentsLike(html), false);
    });

    test('returns false for empty string', () => {
        assert.strictEqual(isTableOfContentsLike(''), false);
    });

    test('returns false for whitespace-only', () => {
        assert.strictEqual(isTableOfContentsLike('   \n  '), false);
    });

    test('returns false for script without scrollIntoView or TableOfContents', () => {
        assert.strictEqual(isTableOfContentsLike('<script>console.log(1);</script>'), false);
    });

    test('returns true when trimmed content starts with <script and contains scrollIntoView', () => {
        assert.strictEqual(isTableOfContentsLike('  \n<script>\nscrollIntoView\n</script>'), true);
    });
});
