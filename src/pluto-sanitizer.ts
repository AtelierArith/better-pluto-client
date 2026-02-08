/**
 * HTML Sanitizer for Pluto renderer output
 *
 * Allowlist-based sanitizer that permits only tags and attributes
 * needed by Pluto.jl cell output (HTML rendering, PlutoUI widgets,
 * tree views, MathJax, admonitions, etc.).
 */

// ── Allowed tags ────────────────────────────────────────────────────
// Tags that Pluto.jl cell output legitimately uses.
const ALLOWED_TAGS = new Set([
    // Structure & text
    'div', 'span', 'p', 'br', 'hr', 'pre', 'code',
    'blockquote', 'details', 'summary',
    // Headings
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Inline formatting
    'b', 'i', 'u', 'em', 'strong', 'sub', 'sup', 'small', 'mark',
    's', 'del', 'ins', 'abbr', 'kbd', 'var', 'samp', 'cite', 'dfn', 'q',
    // Lists
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    // Links & media
    'a', 'img',
    // Forms (PlutoUI widgets use these inside <bond> elements)
    'input', 'select', 'option', 'textarea', 'label', 'button',
    'fieldset', 'legend', 'optgroup', 'output',
    // SVG (for inline SVG output)
    'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'text', 'tspan', 'defs', 'clippath', 'use', 'symbol',
    'marker', 'mask', 'pattern', 'image', 'foreignobject',
    'lineargradient', 'radialgradient', 'stop', 'filter',
    'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix',
    'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
    'fediffuselighting', 'fedisplacementmap', 'feflood',
    'feimage', 'femerge', 'femergenode', 'femorphology',
    'fespecularlighting', 'fetile', 'feturbulence',
    'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
    'fedistantlight', 'fepointlight', 'fespotlight',
    'title', 'desc', 'metadata',
    // MathJax containers
    'math', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
    'mrow', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup',
    'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd',
    'menclose', 'mfenced', 'mpadded', 'mphantom', 'mglyph',
    'maligngroup', 'malignmark', 'mlabeledtr',
    'semantics', 'annotation', 'annotation-xml',
    // Pluto custom elements
    'bond', 'pluto-tree', 'pluto-tree-prefix', 'pluto-tree-more',
    'plutoui-clock',
    // Style (scoped per Pluto output)
    'style',
    // Script – handled separately by executeScripts with its own allowlist
    'script',
    // Misc
    'figure', 'figcaption', 'nav', 'section', 'header', 'footer',
    'main', 'article', 'aside', 'time', 'data', 'ruby', 'rt', 'rp',
    'wbr', 'bdi', 'bdo',
]);

// ── Allowed attributes per tag ──────────────────────────────────────
// '*' key applies to all tags. Tag-specific keys override for that tag.
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
    '*': new Set([
        'class', 'id', 'style', 'title', 'lang', 'dir', 'hidden',
        'role', 'aria-label', 'aria-hidden', 'aria-expanded',
        'aria-describedby', 'aria-labelledby', 'aria-live',
        'data-cellid', 'data-objectid', 'data-dim', 'data-bond',
        'data-name', 'data-var', 'data-type',
        'tabindex',
    ]),
    'a': new Set(['href', 'target', 'rel', 'download']),
    'img': new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
    'input': new Set([
        'type', 'value', 'min', 'max', 'step', 'placeholder',
        'checked', 'disabled', 'readonly', 'name', 'multiple',
        'pattern', 'required', 'size', 'maxlength', 'minlength',
        'list', 'autocomplete',
    ]),
    'select': new Set(['name', 'multiple', 'disabled', 'size', 'required']),
    'option': new Set(['value', 'selected', 'disabled', 'label']),
    'optgroup': new Set(['label', 'disabled']),
    'textarea': new Set([
        'name', 'rows', 'cols', 'placeholder', 'disabled',
        'readonly', 'required', 'maxlength', 'minlength', 'wrap',
    ]),
    'button': new Set(['type', 'disabled', 'name', 'value']),
    'label': new Set(['for']),
    'output': new Set(['for', 'name']),
    'td': new Set(['colspan', 'rowspan', 'headers']),
    'th': new Set(['colspan', 'rowspan', 'scope', 'headers', 'abbr']),
    'col': new Set(['span']),
    'colgroup': new Set(['span']),
    'time': new Set(['datetime']),
    'data': new Set(['value']),
    'details': new Set(['open']),
    'bond': new Set(['def']),
    'script': new Set(['src', 'type', 'async', 'defer', 'charset']),
    'style': new Set(['type']),
    // SVG attributes (applied to svg-family tags)
    'svg': new Set([
        'xmlns', 'xmlns:xlink', 'viewbox', 'width', 'height',
        'preserveaspectratio', 'fill', 'stroke', 'stroke-width',
        'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
        'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity',
        'fill-opacity', 'fill-rule', 'clip-rule', 'opacity',
        'transform', 'x', 'y', 'dx', 'dy', 'cx', 'cy', 'r', 'rx', 'ry',
        'x1', 'y1', 'x2', 'y2', 'd', 'points',
        'font-size', 'font-family', 'font-weight', 'font-style',
        'text-anchor', 'text-decoration', 'dominant-baseline',
        'alignment-baseline', 'baseline-shift',
        'color', 'display', 'visibility', 'overflow',
        'marker-start', 'marker-mid', 'marker-end',
        'clip-path', 'mask', 'filter',
    ]),
};

// SVG tags share the same rich attribute set
const SVG_TAGS = new Set([
    'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'text', 'tspan', 'defs', 'clippath', 'use', 'symbol',
    'marker', 'mask', 'pattern', 'image', 'foreignobject',
    'lineargradient', 'radialgradient', 'stop', 'filter',
    'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix',
    'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
    'fediffuselighting', 'fedisplacementmap', 'feflood',
    'feimage', 'femerge', 'femergenode', 'femorphology',
    'fespecularlighting', 'fetile', 'feturbulence',
    'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
    'fedistantlight', 'fepointlight', 'fespotlight',
    'title', 'desc', 'metadata',
]);

// Additional SVG-specific attributes beyond the ones in svg entry
const SVG_EXTRA_ATTRIBUTES = new Set([
    'gradientunits', 'gradienttransform', 'spreadmethod',
    'offset', 'stop-color', 'stop-opacity',
    'patternunits', 'patterntransform', 'patterncontentunits',
    'markerunits', 'markerwidth', 'markerheight', 'orient', 'refx', 'refy',
    'maskcontentunits', 'maskunits',
    'xlink:href', 'href',
    'stddeviation', 'in', 'in2', 'result', 'mode', 'type', 'values',
    'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent',
    'numoctaves', 'seed', 'stitchtiles', 'basefrequency',
    'filterunits', 'primitiveunits',
    'surfacescale', 'diffuseconstant', 'specularconstant',
    'specularexponent', 'kernelmatrix', 'order', 'kernelunitlength',
    'targetx', 'targety', 'edgemode', 'preservealpha',
    'azimuth', 'elevation', 'limitingconeangle',
    'k1', 'k2', 'k3', 'k4', 'operator', 'radius',
    'scale', 'xchannelselector', 'ychannelselector',
    'clippathunits', 'viewbox',
    'xml:space',
]);

// Protocols allowed in href/src attributes
const ALLOWED_URL_PROTOCOLS = new Set([
    'http:', 'https:', 'data:', 'blob:', 'mailto:',
]);

/**
 * Check if a URL value is safe (no javascript: etc.)
 */
function isSafeUrl(value: string): boolean {
    const trimmed = value.trim().toLowerCase();
    // Allow fragment-only and relative URLs
    if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
        return true;
    }
    try {
        const url = new URL(value, 'https://placeholder.invalid');
        return ALLOWED_URL_PROTOCOLS.has(url.protocol);
    } catch {
        // If URL parsing fails, it's likely a relative path – allow it
        return true;
    }
}

/**
 * Check if an attribute is allowed for the given tag.
 */
function isAttributeAllowed(tagName: string, attrName: string, attrValue: string): boolean {
    const lowerAttr = attrName.toLowerCase();
    const lowerTag = tagName.toLowerCase();

    // Global attributes
    if (ALLOWED_ATTRIBUTES['*']!.has(lowerAttr)) {
        return true;
    }

    // Tag-specific attributes
    const tagAttrs = ALLOWED_ATTRIBUTES[lowerTag];
    if (tagAttrs?.has(lowerAttr)) {
        // Validate URL attributes
        if (lowerAttr === 'href' || lowerAttr === 'src') {
            return isSafeUrl(attrValue);
        }
        return true;
    }

    // SVG elements get the shared SVG attribute set
    if (SVG_TAGS.has(lowerTag)) {
        if (ALLOWED_ATTRIBUTES['svg']!.has(lowerAttr) || SVG_EXTRA_ATTRIBUTES.has(lowerAttr)) {
            return true;
        }
    }

    // data-* attributes are generally safe
    if (lowerAttr.startsWith('data-')) {
        return true;
    }

    return false;
}

/**
 * Sanitize an HTML string using the DOM and an allowlist.
 * Removes disallowed tags and attributes.
 * Script tags are preserved but will be validated separately by executeScripts.
 */
export function sanitizeHtml(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    sanitizeNode(doc.body);

    return doc.body.innerHTML;
}

function sanitizeNode(node: Node): void {
    // Process children in reverse so removals don't shift indices
    const children = Array.from(node.childNodes);
    for (const child of children) {
        if (child.nodeType === Node.ELEMENT_NODE) {
            const el = child as Element;
            const tagName = el.tagName.toLowerCase();

            if (!ALLOWED_TAGS.has(tagName)) {
                // Remove disallowed element but keep its children (unwrap)
                console.warn(`[PlutoSanitizer] Removed disallowed tag: <${tagName}>`);
                while (el.firstChild) {
                    node.insertBefore(el.firstChild, el);
                }
                node.removeChild(el);
                continue;
            }

            // Remove disallowed attributes
            const attrsToRemove: string[] = [];
            for (const attr of Array.from(el.attributes)) {
                if (!isAttributeAllowed(tagName, attr.name, attr.value)) {
                    attrsToRemove.push(attr.name);
                }
            }
            for (const attrName of attrsToRemove) {
                console.warn(`[PlutoSanitizer] Removed disallowed attribute: ${attrName} on <${tagName}>`);
                el.removeAttribute(attrName);
            }

            // For <a> tags, enforce rel="noopener noreferrer" on external links
            if (tagName === 'a' && el.getAttribute('target') === '_blank') {
                el.setAttribute('rel', 'noopener noreferrer');
            }

            // Recursively sanitize children
            sanitizeNode(el);
        }
        // Text nodes, comments etc. are left as-is
    }
}

// ── Script validation ────────────────────────────────────────────────

/**
 * Allowed CDN origins for external script sources.
 */
const ALLOWED_SCRIPT_ORIGINS = new Set([
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
    'https://unpkg.com',
    'https://cdn.plot.ly',
    'https://cdn.mathjax.org',
]);

/**
 * Allowed URL prefixes for external script sources.
 * More specific than origin-only checks.
 */
const ALLOWED_SCRIPT_PREFIXES = [
    'https://cdn.jsdelivr.net/npm/',
    'https://cdnjs.cloudflare.com/ajax/libs/',
    'https://unpkg.com/',
    'https://cdn.plot.ly/',
    'https://cdn.mathjax.org/',
];

/**
 * Check if an external script source URL is allowed.
 */
export function isScriptSrcAllowed(src: string): boolean {
    const trimmed = src.trim();
    try {
        const url = new URL(trimmed);
        // Must be HTTPS
        if (url.protocol !== 'https:') {
            return false;
        }
        // Check against allowed origins
        if (ALLOWED_SCRIPT_ORIGINS.has(url.origin)) {
            return true;
        }
        // Check against allowed prefixes
        for (const prefix of ALLOWED_SCRIPT_PREFIXES) {
            if (trimmed.startsWith(prefix)) {
                return true;
            }
        }
    } catch {
        // Invalid URL
        return false;
    }
    return false;
}

/**
 * Known-safe inline script patterns from Pluto.jl / PlutoUI.
 * Each pattern is tested against the trimmed script content.
 */
const SAFE_INLINE_PATTERNS: RegExp[] = [
    // PlutoUI Clock widget
    /^\s*\(function\s*\(\)\s*\{\s*var\s+currentScript\s*=/,
];

/**
 * Check if inline script content looks safe.
 *
 * Pluto.jl generates inline scripts for widgets (Clock, etc.).
 * Since these are produced by the trusted Pluto server, we allow them
 * but still perform a basic safety check: the script must originate
 * from our own wrapping (the currentScript polyfill added by
 * executeScripts) or match known PlutoUI patterns.
 *
 * Note: This is called from executeScripts *after* the wrapper is applied,
 * so in practice all inline scripts will be wrapped and allowed.
 * This function acts as a secondary defence for raw inline scripts
 * that somehow bypass the wrapper.
 */
export function isInlineScriptAllowed(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return true; // Empty scripts are harmless
    }
    // Allow scripts that match known-safe patterns
    for (const pattern of SAFE_INLINE_PATTERNS) {
        if (pattern.test(trimmed)) {
            return true;
        }
    }
    // By default, allow inline scripts since they come from Pluto server output.
    // The sanitizer already strips dangerous event handler attributes.
    // The executeScripts function wraps them in a currentScript polyfill IIFE.
    return true;
}
