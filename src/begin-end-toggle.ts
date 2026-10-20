/** Toggle a standalone outer Julia begin/end block without reindenting literals. */
export function toggleBeginEnd(code: string): { code: string; unwrapped: boolean } {
    const newline = code.includes('\r\n') ? '\r\n' : '\n';
    const lines = code.split(/\r?\n/);
    const first = lines.findIndex(line => line.trim() !== '');
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') { last--; }
    if (first >= 0 && first < last && lines[first].trim() === 'begin' &&
        lines[last].trim() === 'end' && hasSingleOuterBlock(code)) {
        // Do not dedent: whitespace inside multiline strings/commands is data.
        lines.splice(last, 1);
        lines.splice(first, 1);
        return { code: lines.join(newline), unwrapped: true };
    }
    return { code: `begin${newline}${code}${newline}end`, unwrapped: false };
}

/** Conservative lexical check, not a Julia parser. Ambiguous syntax stays wrapped. */
function hasSingleOuterBlock(code: string): boolean {
    let depth = 0;
    let commentDepth = 0;
    const brackets: string[] = [];
    const openers = new Set(['begin', 'quote', 'let', 'if', 'for', 'while', 'try',
        'function', 'macro', 'struct', 'module', 'baremodule', 'do', 'type']);
    let closed = false;
    for (let i = 0; i < code.length;) {
        if (code.startsWith('#=', i)) { commentDepth++; i += 2; continue; }
        if (commentDepth) {
            if (code.startsWith('=#', i)) { commentDepth--; i += 2; }
            else { i++; }
            continue;
        }
        const ch = code[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '#') {
            const end = code.indexOf('\n', i);
            i = end < 0 ? code.length : end + 1;
            continue;
        }
        if (closed) { return false; }
        if (ch === '"' || ch === '`') {
            const delimiter = ch === '"' && code.startsWith('"""', i) ? '"""' : ch;
            i += delimiter.length;
            let terminated = false;
            while (i < code.length) {
                if (code[i] === '\\') { i += 2; continue; }
                if (code.startsWith(delimiter, i)) { i += delimiter.length; terminated = true; break; }
                i++;
            }
            if (!terminated) { return false; }
            continue;
        }
        if (ch === "'") {
            // Character literal or postfix adjoint. Consume only an unambiguous char.
            const char = code.slice(i).match(/^'(?:\\(?:[abefnrtv\\'"]|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3})|[^'\\\r\n])'/u);
            i += char ? char[0].length : 1;
            continue;
        }
        if ('([{'.includes(ch)) { brackets.push(ch); i++; continue; }
        if (')]}'.includes(ch)) {
            const opening = '([{'[')]}'.indexOf(ch)];
            if (brackets.pop() !== opening) { return false; }
            i++;
            continue;
        }
        const word = code.slice(i).match(/^[\p{L}_][\p{L}\p{N}_!?]*/u)?.[0];
        if (word) {
            if (brackets.length === 0 && code[i - 1] !== ':' && code[i - 1] !== '.') {
                if (openers.has(word)) { depth++; }
                else if (word === 'end') {
                    depth--;
                    if (depth < 0) { return false; }
                    if (depth === 0) { closed = true; }
                }
            }
            i += word.length;
        } else { i++; }
    }
    return closed && depth === 0 && brackets.length === 0 && commentDepth === 0;
}
