/**
 * Pluto HTML Renderer for VS Code Notebook
 * Handles interactive elements like Slider, Checkbox, etc.
 * and sends bond updates back to the extension
 */

import type { RendererContext, OutputItem } from 'vscode-notebook-renderer';
import { isTableOfContentsLike } from './pluto-toc-utils';
import { sanitizeHtml, isScriptSrcAllowed, isInlineScriptAllowed } from './pluto-sanitizer';

interface PlutoBondMessage {
    type: 'setBond';
    name: string;
    value: unknown;
}

interface PlutoShowMoreMessage {
    type: 'showMore';
    cellId: string;
    objectid: string;
    dim: number;
}

// MathJax is loaded dynamically from CDN
// We use a simple interface for type safety
interface MathJaxObject {
    typeset?: (elements: Element[]) => void;
    startup?: {
        defaultReady?: () => void;
    };
}

// Helper to access MathJax on window
function getMathJax(): MathJaxObject | undefined {
     
    return (window as any).MathJax as MathJaxObject | undefined;
}

// Helper to set MathJax config on window
 
function setMathJaxConfig(config: any): void {
     
    (window as any).MathJax = config;
}

// Flag to track if MathJax has been initialized
let mathJaxInitialized = false;
let mathJaxLoadPromise: Promise<void> | null = null;

async function waitForMathJaxReady(timeoutMs: number = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (getMathJax()?.typeset) {
            return;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
}

/**
 * Setup MathJax 3 configuration and load the script
 * Based on Pluto.jl's SetupMathJax.js
 */
function setupMathJax(): Promise<void> {
    if (mathJaxLoadPromise) {
        return mathJaxLoadPromise;
    }

    mathJaxLoadPromise = new Promise((resolve) => {
        try {
            if (mathJaxInitialized && getMathJax()?.typeset) {
                resolve();
                return;
            }

            // Check if script already exists
            if (document.getElementById('MathJax-script')) {
                console.log('[PlutoRenderer] MathJax script already exists');
                waitForMathJaxReady().then(() => resolve());
                return;
            }

            // Configure MathJax before loading the script
            setMathJaxConfig({
                options: {
                    // Match Pluto frontend; the alpha/theta avoids accidental collisions.
                    ignoreHtmlClass: "no-MαθJax",
                    processHtmlClass: "tex",  // Process elements with class "tex"
                },
                tex: {
                    inlineMath: [
                        ["$", "$"],
                        ["\\(", "\\)"],
                    ],
                },
                svg: {
                    fontCache: "global",
                },
                startup: {
                    ready: () => {
                        console.log('[PlutoRenderer] MathJax is ready');
                        try {
                            getMathJax()?.startup?.defaultReady?.();
                            // Pluto compatibility shim: some libraries still call MathJax v2 APIs.
                            const mj = getMathJax() as any;
                            if (mj) {
                                mj.Hub = {
                                    Queue: function (...args: unknown[]) {
                                        for (const arg of args) {
                                            const fn = mj.Callback ? mj.Callback(arg) : arg;
                                            if (typeof fn === 'function' && mj.startup?.promise) {
                                                mj.startup.promise = mj.startup.promise.then(fn);
                                            }
                                        }
                                        return mj.startup?.promise;
                                    },
                                    Typeset: function (elements: Element[], callback?: () => void) {
                                        let promise = mj.typesetPromise ? mj.typesetPromise(elements) : Promise.resolve();
                                        if (callback) {
                                            promise = promise.then(callback);
                                        }
                                        return promise;
                                    },
                                };
                            }
                        } catch (e) {
                            console.warn('[PlutoRenderer] MathJax defaultReady error:', e);
                        }
                        mathJaxInitialized = true;
                        resolve();
                    }
                }
            });

            // Load MathJax from CDN with SRI integrity check
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js';
            script.integrity = 'sha384-4kE/rQ11E8xT9QgrCBTyvenkuPfQo8rXYQvJZuMgxyPOoUfpatjQPlgdv6V5yhUK';
            script.crossOrigin = 'anonymous';
            script.async = true;
            script.id = 'MathJax-script';

            script.onload = () => {
                console.log('[PlutoRenderer] MathJax script loaded');
            };

            script.onerror = (e) => {
                console.error('[PlutoRenderer] Failed to load MathJax:', e);
                script.remove(); // Remove failed script so retry can re-add it
                mathJaxLoadPromise = null; // Allow retry on next call
                resolve(); // Resolve anyway to not block rendering
            };

            document.head.appendChild(script);
        } catch (e) {
            console.error('[PlutoRenderer] Error setting up MathJax:', e);
            resolve(); // Resolve anyway to not block rendering
        }
    });

    return mathJaxLoadPromise;
}

/**
 * Render math expressions in an element using MathJax
 *
 * Pluto.jl wraps LaTeX in elements with class "tex":
 * - Inline: <span class="tex">$formula$</span>
 * - Block: <p class="tex">$$formula$$</p>
 */
async function renderMathInElement(element: HTMLElement): Promise<void> {
    // Find all elements with class "tex" (Pluto.jl's convention)
    const texElements = element.querySelectorAll('.tex');
    console.log('[PlutoRenderer] Found .tex elements:', texElements.length);

    if (texElements.length === 0) {
        return;
    }

    // Ensure MathJax is loaded
    await setupMathJax();

    // Use MathJax to typeset the elements
    const mj = getMathJax();
    if (mj?.typeset) {
        try {
            mj.typeset(Array.from(texElements));
            console.log('[PlutoRenderer] MathJax typeset complete');
        } catch (err) {
            console.warn('[PlutoRenderer] Failed to typeset TeX:', err);
        }
    } else {
        console.warn('[PlutoRenderer] MathJax not available');
    }
}

/**
 * Activate the renderer
 */
export function activate(context: RendererContext<void>) {
    // Note: Don't load MathJax early - VS Code webviews have restrictions
    // MathJax will be loaded on-demand when rendering math content

    return {
        async renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            const html = outputItem.text();

            // Abort previous event listeners to prevent leaks
            const prevController = (element as any).__abortController as AbortController | undefined;
            if (prevController) {
                prevController.abort();
            }
            const abortController = new AbortController();
            (element as any).__abortController = abortController;

            // Disconnect previous IntersectionObservers to prevent leaks
            const prevObservers = (element as any).__tocObservers as IntersectionObserver[] | undefined;
            if (prevObservers) {
                prevObservers.forEach(obs => obs.disconnect());
                delete (element as any).__tocObservers;
            }

            // Debug log
            console.log('[PlutoRenderer] Rendering HTML output:', html.slice(0, 500));

            // Inject admonition styles (hint, warning, danger, etc.)
            injectAdmonitionStyles();

            // Create a container for the HTML
            const container = document.createElement('div');
            container.className = 'pluto-output';

            // Sanitize and render the HTML
            container.innerHTML = sanitizeHtml(html);

            // Find and setup interactive elements
            setupInteractiveElements(container, context, abortController.signal);

            // Clear previous content and add new
            element.innerHTML = '';
            element.appendChild(container);

            // Execute any scripts in the HTML (needed for Plotly, etc.)
            await executeScripts(container).catch(err => {
                console.warn('[PlutoRenderer] Script execution error:', err);
            });

            // Render math expressions using MathJax (async)
            renderMathInElement(container).catch(err => {
                console.warn('[PlutoRenderer] Math rendering error:', err);
            });

            // TableOfContents (PlutoUI) output is script-only; the script looks for headings
            // in the document, but in our cell output we only have this container. Build an
            // interactive TOC from headings found elsewhere in the same notebook document.
            if (!hasVisibleContent(container) && isTableOfContentsLike(html)) {
                const tocEl = renderTableOfContentsFromDocument(container, element);
                if (tocEl) {
                    container.appendChild(tocEl);
                    // Propagate observers to element for cleanup on next render
                    if ((tocEl as any).__tocObservers) {
                        (element as any).__tocObservers = (tocEl as any).__tocObservers;
                    }
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'pluto-toc-placeholder';
                    placeholder.setAttribute('style', 'color: var(--vscode-descriptionForeground); font-size: 0.9em; padding: 4px 0;');
                    placeholder.textContent = 'Index (Table of Contents) — 見出しは同じノート内のセルを参照します。';
                    container.appendChild(placeholder);
                }
            }
        }
    };
}

/**
 * Admonition CSS for hint, tip, warning, danger, etc.
 * Based on Pluto.jl/frontend/editor.css and themes/light.css, dark.css
 */
const ADMONITION_CSS = `
<style class="pluto-admonition-styles">
/* CSS variables for light/dark mode */
.pluto-output {
    --admonition-title-color: white;
    --jl-message-color: rgb(227, 227, 227);
    --jl-message-accent-color: rgb(163, 163, 163);
    --jl-info-color: rgb(214, 227, 244);
    --jl-info-accent-color: rgb(148, 182, 226);
    --jl-warn-color: rgb(236, 234, 213);
    --jl-warn-accent-color: rgb(207, 199, 138);
    --jl-danger-color: rgb(245, 218, 215);
    --jl-danger-accent-color: rgb(226, 157, 148);
}

@media (prefers-color-scheme: dark) {
    .pluto-output {
        --admonition-title-color: black;
        --jl-message-color: rgb(60, 60, 60);
        --jl-message-accent-color: rgb(120, 120, 120);
        --jl-info-color: rgb(42, 73, 115);
        --jl-info-accent-color: rgb(92, 140, 205);
        --jl-warn-color: rgb(96, 90, 34);
        --jl-warn-accent-color: rgb(221, 212, 100);
        --jl-danger-color: rgb(100, 47, 39);
        --jl-danger-accent-color: rgb(255, 117, 98);
    }
}

/* Base admonition styles */
.pluto-output div.admonition {
    border-radius: 8px;
    margin-block-start: 1em;
    margin-block-end: 1em;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    background: var(--jl-message-color);
    border: 5px solid var(--jl-message-accent-color);
}

.pluto-output div.admonition .admonition-title {
    font-family: "Vollkorn", Palatino, Georgia, serif;
    color: var(--admonition-title-color);
    font-weight: 600;
    margin-block-end: 0px;
    padding: 0.3em;
    font-size: 1.3em;
    background: var(--jl-message-accent-color);
    margin: -1px;
    margin-left: -0.55rem;
    margin-right: -0.55rem;
    border-radius: 4px 4px 0 0;
}

.pluto-output div.admonition .admonition-title ~ * {
    margin-block-end: 0.5em;
    margin-block-start: 0.5em;
    transition: filter linear 0.1s;
}

/* Note, Info, Hint styles (blue) */
.pluto-output div.admonition.note,
.pluto-output div.admonition.info,
.pluto-output div.admonition.hint {
    background: var(--jl-info-color);
    border: 5px solid var(--jl-info-accent-color);
}

.pluto-output div.admonition.note > .admonition-title,
.pluto-output div.admonition.info > .admonition-title,
.pluto-output div.admonition.hint > .admonition-title {
    background: var(--jl-info-accent-color);
}

/* Hint blur effect - content is blurred until hover */
.pluto-output div.admonition.hint > .admonition-title ~ * {
    filter: blur(0.25em);
}

.pluto-output div.admonition.hint:hover > .admonition-title ~ *,
.pluto-output div.admonition.hint:focus-within > .admonition-title ~ * {
    filter: blur(0em);
}

/* Tip styles (blue, same as info) */
.pluto-output div.admonition.tip {
    background: var(--jl-info-color);
    border: 5px solid var(--jl-info-accent-color);
}

.pluto-output div.admonition.tip > .admonition-title {
    background: var(--jl-info-accent-color);
}

/* Warning styles (yellow) */
.pluto-output div.admonition.warning,
.pluto-output div.admonition.alert-danger {
    background: var(--jl-warn-color);
    border: 5px solid var(--jl-warn-accent-color);
}

.pluto-output div.admonition.warning > .admonition-title,
.pluto-output div.admonition.alert-danger > .admonition-title {
    background: var(--jl-warn-accent-color);
}

/* Danger styles (red) */
.pluto-output div.admonition.danger {
    background: var(--jl-danger-color);
    border: 5px solid var(--jl-danger-accent-color);
}

.pluto-output div.admonition.danger > .admonition-title {
    background: var(--jl-danger-accent-color);
}

/* Correct styles (green) - for PlutoTeachingTools */
.pluto-output div.admonition.correct {
    --jl-correct-color: rgb(214, 244, 214);
    --jl-correct-accent-color: rgb(148, 226, 148);
    background: var(--jl-correct-color);
    border: 5px solid var(--jl-correct-accent-color);
}

@media (prefers-color-scheme: dark) {
    .pluto-output div.admonition.correct {
        --jl-correct-color: rgb(34, 80, 34);
        --jl-correct-accent-color: rgb(100, 180, 100);
    }
}

.pluto-output div.admonition.correct > .admonition-title {
    background: var(--jl-correct-accent-color);
}

/* Answer styles - same as tip */
.pluto-output div.admonition.answer {
    background: var(--jl-info-color);
    border: 5px solid var(--jl-info-accent-color);
}

.pluto-output div.admonition.answer > .admonition-title {
    background: var(--jl-info-accent-color);
}

/* Question styles (yellow-ish) */
.pluto-output div.admonition.question {
    background: var(--jl-warn-color);
    border: 5px solid var(--jl-warn-accent-color);
}

.pluto-output div.admonition.question > .admonition-title {
    background: var(--jl-warn-accent-color);
}

/* Key concept styles - same as info but could be customized */
.pluto-output div.admonition.key-concept {
    background: var(--jl-info-color);
    border: 5px solid var(--jl-info-accent-color);
}

.pluto-output div.admonition.key-concept > .admonition-title {
    background: var(--jl-info-accent-color);
}
</style>
`;

// Flag to track if admonition styles have been injected
let admonitionStylesInjected = false;

/**
 * Inject admonition styles into the document if not already present
 */
function injectAdmonitionStyles(): void {
    if (admonitionStylesInjected) {
        return;
    }
    if (document.querySelector('style.pluto-admonition-styles')) {
        admonitionStylesInjected = true;
        return;
    }
    const styleContainer = document.createElement('div');
    styleContainer.innerHTML = ADMONITION_CSS;
    const styleEl = styleContainer.firstElementChild;
    if (styleEl) {
        document.head.appendChild(styleEl);
        admonitionStylesInjected = true;
        console.log('[PlutoRenderer] Admonition styles injected');
    }
}

/**
 * PlutoUI-style CSS for TableOfContents
 * Based on PlutoUI.jl/src/TableOfContents.jl toc_css
 * Note: Toggle functionality is only for aside mode (fixed sidebar) in PlutoUI.
 * Since VS Code cell outputs don't support fixed positioning, we use inline mode without toggle.
 */
const PLUTOUI_TOC_CSS = `
<style>
.plutoui-toc {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Cantarell, "Apple Color Emoji",
        "Segoe UI Emoji", "Segoe UI Symbol", system-ui, sans-serif;
    --main-bg-color: var(--vscode-editor-background, #fafafa);
    --pluto-output-color: var(--vscode-foreground, hsl(0, 0%, 36%));
    --pluto-output-h-color: var(--vscode-editor-foreground, hsl(0, 0%, 21%));
    --sidebar-li-active-bg: var(--vscode-list-activeSelectionBackground, rgb(235, 235, 235));
    color: var(--pluto-output-color);
    padding: 0.5rem;
    padding-top: 0em;
    border-radius: 10px;
    background-color: var(--main-bg-color);
    max-width: 300px;
}

@media (prefers-color-scheme: dark) {
    .plutoui-toc {
        --main-bg-color: var(--vscode-editor-background, #303030);
        --pluto-output-color: var(--vscode-foreground, hsl(0, 0%, 90%));
        --pluto-output-h-color: var(--vscode-editor-foreground, hsl(0, 0%, 97%));
        --sidebar-li-active-bg: var(--vscode-list-activeSelectionBackground, rgb(82, 82, 82));
    }
}

.plutoui-toc header {
    display: flex;
    align-items: center;
    gap: .3em;
    font-size: 1.5em;
    margin-bottom: 0.4em;
    padding: 0.5rem;
    margin-left: 0;
    margin-right: 0;
    font-weight: bold;
    position: sticky;
    top: 0px;
    background: var(--main-bg-color);
    z-index: 41;
}

.plutoui-toc section .toc-row {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: .1em;
    border-radius: .2em;
}

.plutoui-toc section .toc-row.H1 {
    margin-top: 1em;
}

.plutoui-toc section .toc-row.in-view {
    background: var(--sidebar-li-active-bg);
}

.plutoui-toc section a {
    text-decoration: none;
    font-weight: normal;
    color: var(--pluto-output-color);
}
.plutoui-toc section a:hover {
    color: var(--pluto-output-h-color);
}

.plutoui-toc.indent section a.H1 {
    font-weight: 700;
    line-height: 1em;
}

.plutoui-toc.indent section .after-H2 a { padding-left: 10px; }
.plutoui-toc.indent section .after-H3 a { padding-left: 20px; }
.plutoui-toc.indent section .after-H4 a { padding-left: 30px; }
.plutoui-toc.indent section .after-H5 a { padding-left: 40px; }
.plutoui-toc.indent section .after-H6 a { padding-left: 50px; }

.plutoui-toc.indent section a.H1 { padding-left: 0px; }
.plutoui-toc.indent section a.H2 { padding-left: 10px; }
.plutoui-toc.indent section a.H3 { padding-left: 20px; }
.plutoui-toc.indent section a.H4 { padding-left: 30px; }
.plutoui-toc.indent section a.H5 { padding-left: 40px; }
.plutoui-toc.indent section a.H6 { padding-left: 50px; }
</style>
`;

/**
 * Find h1-h6 with id in other pluto-output containers in the same document and build a TOC.
 * Returns a nav element with PlutoUI-style links, or null if no headings found.
 * Based on PlutoUI.jl/src/TableOfContents.jl structure
 */
function renderTableOfContentsFromDocument(_container: HTMLElement, outputElement: HTMLElement): HTMLElement | null {
    // Query the document for headings in any pluto-output (excluding script-only TOC cell).
    // In VS Code notebook webview, all cell outputs are in the same document.
    const root = outputElement.closest('.notebook-output') ?? outputElement.closest('[data-vscode-notebook-cell-output]') ?? document.body;
    const headings = root.querySelectorAll('.pluto-output h1[id], .pluto-output h2[id], .pluto-output h3[id], .pluto-output h4[id], .pluto-output h5[id], .pluto-output h6[id]');
    const items: { id: string; text: string; level: number; element: Element }[] = [];
    headings.forEach((el) => {
        const id = el.getAttribute('id');
        if (!id) { return; }
        // Skip if this heading is inside our own container (TOC cell)
        if (outputElement.contains(el)) { return; }
        const text = (el.textContent ?? '').trim();
        if (!text) { return; }
        const level = parseInt(el.tagName.charAt(1), 10);
        items.push({ id, text, level, element: el });
    });
    if (items.length === 0) {
        return null;
    }

    // Create wrapper with CSS
    const wrapper = document.createElement('div');
    wrapper.innerHTML = PLUTOUI_TOC_CSS;

    // Create nav element (PlutoUI-style)
    const nav = document.createElement('nav');
    nav.className = 'plutoui-toc indent';
    nav.setAttribute('aria-label', 'Table of Contents');

    // Header (no toggle in inline mode - toggle is only for aside/fixed sidebar in PlutoUI)
    const header = document.createElement('header');
    header.textContent = 'Table of Contents';
    nav.appendChild(header);

    // Section with toc-rows
    const section = document.createElement('section');
    let lastLevel = 'H1';

    // Map for IntersectionObserver tracking
    const headerToRowMap = new Map<Element, HTMLElement>();
    const currentlyHighlighted = new Set<HTMLElement>();

    items.forEach(({ id, text, level, element }) => {
        const levelClass = `H${level}`;
        const row = document.createElement('div');
        row.className = `toc-row ${levelClass} after-${lastLevel}`;

        const a = document.createElement('a');
        a.className = levelClass;
        a.href = '#' + encodeURIComponent(id);
        a.title = text;
        a.textContent = text;
        a.onclick = (e) => {
            e.preventDefault();
            history.replaceState(null, '', a.href);
            const target = document.getElementById(id);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        };

        row.appendChild(a);
        section.appendChild(row);

        headerToRowMap.set(element, row);
        lastLevel = levelClass;
    });

    nav.appendChild(section);
    wrapper.appendChild(nav);

    // Set up IntersectionObserver for active section highlighting
    const intersectionCallback = (entries: IntersectionObserverEntry[]) => {
        const onTop = entries.filter(ix => ix.intersectionRatio > 0 && ix.intersectionRect.y < (ix.rootBounds?.height ?? 0) / 2);
        if (onTop.length > 0) {
            currentlyHighlighted.forEach(el => el.classList.remove('in-view'));
            currentlyHighlighted.clear();
            onTop.slice(0, 1).forEach(ix => {
                const row = headerToRowMap.get(ix.target);
                if (row) {
                    row.classList.add('in-view');
                    currentlyHighlighted.add(row);
                }
            });
        }
    };

    const observer1 = new IntersectionObserver(intersectionCallback, {
        root: null,
        threshold: 1,
        rootMargin: '-15px',
    });
    const observer2 = new IntersectionObserver(intersectionCallback, {
        root: null,
        threshold: 1,
        rootMargin: '15px',
    });

    // Observe all heading elements
    items.forEach(({ element }) => {
        observer1.observe(element);
        observer2.observe(element);
    });

    // Store observers on wrapper for cleanup on re-render
    (wrapper as any).__tocObservers = [observer1, observer2];

    return wrapper;
}

/** True if the element has visible content (text or non-script/style nodes with size) */
function hasVisibleContent(container: HTMLElement): boolean {
    const walk = (el: Element): boolean => {
        if (el.nodeType === Node.TEXT_NODE) {
            return (el.textContent?.trim().length ?? 0) > 0;
        }
        if (el.nodeType !== Node.ELEMENT_NODE) { return false; }
        const tag = (el as Element).tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') { return false; }
        if (tag === 'br' || tag === 'hr') { return true; }
        if ((el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0) { return true; }
        for (let i = 0; i < el.childNodes.length; i++) {
            if (walk(el.childNodes[i] as Element)) { return true; }
        }
        return false;
    };
    for (let i = 0; i < container.childNodes.length; i++) {
        if (walk(container.childNodes[i] as Element)) { return true; }
    }
    return false;
}

/**
 * Execute scripts in the HTML content
 * innerHTML doesn't execute scripts, so we need to do it manually
 * This is needed for Plotly, Clock, and other JavaScript-based visualizations
 */
async function executeScripts(container: HTMLElement): Promise<void> {
    const scripts = container.querySelectorAll('script');
    console.log(`[PlutoRenderer] Found ${scripts.length} scripts to execute`);

    for (const oldScript of Array.from(scripts)) {
        if (oldScript.src) {
            // External script - validate source against allowlist
            if (!isScriptSrcAllowed(oldScript.src)) {
                console.warn(`[PlutoRenderer] Blocked external script from disallowed source: ${oldScript.src}`);
                oldScript.remove();
                continue;
            }

            const newScript = document.createElement('script');
            // Copy attributes
            for (const attr of Array.from(oldScript.attributes)) {
                newScript.setAttribute(attr.name, attr.value);
            }

            console.log(`[PlutoRenderer] Loading external script: ${oldScript.src}`);
            await new Promise<void>((resolve) => {
                newScript.onload = () => {
                    console.log(`[PlutoRenderer] External script loaded: ${oldScript.src}`);
                    resolve();
                };
                newScript.onerror = (e) => {
                    console.error(`[PlutoRenderer] Failed to load script: ${oldScript.src}`, e);
                    resolve();
                };
                oldScript.parentNode?.replaceChild(newScript, oldScript);
            });
        } else {
            // Inline script - validate content
            const content = oldScript.textContent || '';
            if (!isInlineScriptAllowed(content)) {
                console.warn(`[PlutoRenderer] Blocked inline script that failed safety check`);
                oldScript.remove();
                continue;
            }

            const newScript = document.createElement('script');
            // Copy attributes
            for (const attr of Array.from(oldScript.attributes)) {
                newScript.setAttribute(attr.name, attr.value);
            }

            // Wrap with currentScript polyfill for PlutoUI widgets
            // PlutoUI's Clock.js uses `currentScript ?? this.currentScript` to find its element
            const wrappedScript = `
                (function() {
                    var currentScript = document.currentScript;
                    ${content}
                })();
            `;
            newScript.textContent = wrappedScript;
            oldScript.parentNode?.replaceChild(newScript, oldScript);
            console.log(`[PlutoRenderer] Executed inline script (${content.length} chars)`);
        }
    }
}

/**
 * Setup event listeners for interactive Pluto elements
 */
function setupInteractiveElements(container: HTMLElement, context: RendererContext<void>, signal: AbortSignal) {
    // Find all input elements that might be bound
    const inputs = container.querySelectorAll('input, select, textarea');

    inputs.forEach((input) => {
        const inputEl = input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

        // Look for Pluto bond attribute or data attribute
        // Pluto uses custom elements with specific attributes
        const bondName = findBondName(inputEl);

        if (bondName) {
            console.log(`[PlutoRenderer] Found bond: ${bondName}`);
            setupBondListener(inputEl, bondName, context, signal);
        }
    });

    // Also look for Pluto's custom <bond> elements
    const bondElements = container.querySelectorAll('bond');
    bondElements.forEach((bondEl) => {
        const bondName = bondEl.getAttribute('def');
        if (bondName) {
            console.log(`[PlutoRenderer] Found <bond> element: ${bondName}`);
            const input = bondEl.querySelector('input, select, textarea');
            if (input) {
                setupBondListener(input as HTMLInputElement, bondName, context, signal);
            }
        }
    });

    // Handle Pluto's standard HTML structure for sliders
    // PlutoUI wraps inputs in specific structures
    setupPlutoUISliders(container, context, signal);

    // Handle PlutoUI Clock widgets
    setupPlutoUIClock(container, context, signal);

    // Handle "show more" buttons in tree views
    setupShowMoreButtons(container, context, signal);

    // Handle tree collapse/expand
    setupTreeCollapse(container, signal);
}

/**
 * Find the bond name from an input element
 */
function findBondName(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | null {
    // Check Pluto-specific attributes only (not generic HTML 'name')
    const bondAttr = input.getAttribute('bond') ||
                     input.getAttribute('data-bond') ||
                     input.closest('bond')?.getAttribute('def') ||
                     null;

    return bondAttr;
}

/**
 * Setup a listener for bond value changes
 */
function setupBondListener(
    input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    bondName: string,
    context: RendererContext<void>,
    signal: AbortSignal
) {
    const sendValue = () => {
        const value = getInputValue(input);
        console.log(`[PlutoRenderer] Bond ${bondName} changed to:`, value);

        // Send message to extension
        if (context.postMessage) {
            context.postMessage({
                type: 'setBond',
                name: bondName,
                value: value
            } as PlutoBondMessage);
        }
    };

    // Listen for input events (auto-removed when signal is aborted)
    input.addEventListener('input', sendValue, { signal });
    input.addEventListener('change', sendValue, { signal });
}

/**
 * Get the value from an input element in the appropriate format
 */
function getInputValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
    if (input instanceof HTMLSelectElement) {
        if (input.multiple) {
            return Array.from(input.selectedOptions).map(opt => opt.value);
        }
        return input.value;
    }

    if (input instanceof HTMLInputElement) {
        switch (input.type) {
            case 'checkbox':
                return input.checked;
            case 'number':
            case 'range':
                return parseFloat(input.value);
            case 'date':
            case 'datetime-local':
                return input.value;
            default:
                return input.value;
        }
    }

    return (input as HTMLTextAreaElement).value;
}

/**
 * Setup handlers for PlutoUI Slider components
 * PlutoUI generates HTML like:
 * <bond def="varname"><input type="range" ...></bond>
 */
function setupPlutoUISliders(container: HTMLElement, context: RendererContext<void>, signal: AbortSignal) {
    // Find range inputs (sliders)
    const rangeInputs = container.querySelectorAll('input[type="range"]');

    rangeInputs.forEach((input) => {
        const rangeInput = input as HTMLInputElement;

        // Try to find the bond name from parent elements
        const bondName = findBondNameFromParents(rangeInput);

        if (bondName) {
            console.log(`[PlutoRenderer] Setting up slider for bond: ${bondName}`);
            setupBondListener(rangeInput, bondName, context, signal);
        } else {
            // If no bond name found, try to extract from surrounding HTML
            // PlutoUI often includes the variable name in span elements
            const parentHTML = rangeInput.parentElement?.outerHTML || '';
            console.log(`[PlutoRenderer] Slider without bond name, parent HTML:`, parentHTML.slice(0, 200));
        }
    });
}

/**
 * Setup handlers for PlutoUI Clock widgets
 * Clock uses a custom <plutoui-clock> element that fires 'input' events
 */
function setupPlutoUIClock(container: HTMLElement, context: RendererContext<void>, signal: AbortSignal) {
    const clocks = container.querySelectorAll('plutoui-clock');

    clocks.forEach((clock) => {
        const clockEl = clock as HTMLElement & { value?: number };

        // Find bond name from parent <bond> element
        const bondName = findBondNameFromParents(clockEl);

        if (bondName) {
            console.log(`[PlutoRenderer] Setting up Clock for bond: ${bondName}`);

            // Listen for input events from the clock (auto-removed when signal is aborted)
            clockEl.addEventListener('input', () => {
                const value = clockEl.value ?? 1;
                console.log(`[PlutoRenderer] Clock ${bondName} ticked: ${value}`);

                if (context.postMessage) {
                    context.postMessage({
                        type: 'setBond',
                        name: bondName,
                        value: value
                    });
                }
            }, { signal });
        } else {
            console.log(`[PlutoRenderer] Found Clock without bond name`);
        }
    });
}

/**
 * Find bond name by traversing parent elements
 */
function findBondNameFromParents(element: HTMLElement): string | null {
    let current: HTMLElement | null = element;

    while (current) {
        // Check for <bond def="..."> element
        if (current.tagName.toLowerCase() === 'bond') {
            const def = current.getAttribute('def');
            if (def) {return def;}
        }

        // Check for data-bond attribute
        const dataBond = current.getAttribute('data-bond');
        if (dataBond) {return dataBond;}

        // Check for pluto-bond class or similar
        if (current.classList.contains('pluto-bond')) {
            const bondName = current.getAttribute('data-name') ||
                           current.getAttribute('data-var');
            if (bondName) {return bondName;}
        }

        current = current.parentElement;
    }

    return null;
}

/**
 * Setup handlers for "show more" buttons in tree views
 */
function setupShowMoreButtons(container: HTMLElement, context: RendererContext<void>, signal: AbortSignal) {
    const moreButtons = container.querySelectorAll('pluto-tree-more');

    moreButtons.forEach((button) => {
        const moreBtn = button as HTMLElement;
        const cellId = moreBtn.getAttribute('data-cellid');
        const objectid = moreBtn.getAttribute('data-objectid');
        const dim = Number(moreBtn.getAttribute('data-dim') || '1');

        if (objectid && cellId) {
            console.log(`[PlutoRenderer] Found "show more" button with cellId=${cellId}, objectid=${objectid}, dim=${dim}`);

            moreBtn.style.cursor = 'pointer';
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log(`[PlutoRenderer] "show more" clicked, cellId=${cellId}, objectid=${objectid}, dim=${dim}`);

                // Update button state
                moreBtn.textContent = 'loading...';
                moreBtn.style.opacity = '0.5';

                // Send message to extension
                if (context.postMessage) {
                    context.postMessage({
                        type: 'showMore',
                        cellId,
                        objectid,
                        dim,
                    } as PlutoShowMoreMessage);
                }
            }, { signal });
        } else {
            // No objectid - show not supported message on click
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                moreBtn.textContent = '(expand not yet supported)';
                moreBtn.style.cursor = 'default';
                moreBtn.style.opacity = '0.4';
            }, { signal });
        }
    });
}

/**
 * Setup tree collapse/expand functionality
 * Allows users to click on tree prefixes to toggle collapsed state
 */
function setupTreeCollapse(container: HTMLElement, signal: AbortSignal) {
    const trees = container.querySelectorAll('pluto-tree');

    trees.forEach((tree) => {
        const treeEl = tree as HTMLElement;

        // Add click handler to the tree element (auto-removed when signal is aborted)
        treeEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            // Only handle clicks on the tree itself or its prefix
            const clickedTree = target.closest('pluto-tree') as HTMLElement | null;
            const clickedPrefix = target.closest('pluto-tree-prefix');
            const clickedMore = target.closest('pluto-tree-more');

            // Don't toggle if clicking on "show more" button
            if (clickedMore) {return;}

            // Only toggle if clicking directly on the tree or prefix
            if (clickedTree && (clickedPrefix || target === clickedTree || target.tagName.toLowerCase() === 'pluto-tree')) {
                // Check if parent tree is collapsed - if so, don't toggle children
                const parentTree = clickedTree.parentElement?.closest('pluto-tree') as HTMLElement | null;
                if (parentTree && parentTree.classList.contains('collapsed')) {
                    return;
                }

                // Toggle collapsed state
                clickedTree.classList.toggle('collapsed');
                e.stopPropagation();
            }
        }, { signal });
    });
}
