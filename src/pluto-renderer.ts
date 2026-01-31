/**
 * Pluto HTML Renderer for VS Code Notebook
 * Handles interactive elements like Slider, Checkbox, etc.
 * and sends bond updates back to the extension
 */

import type { RendererContext, OutputItem } from 'vscode-notebook-renderer';
import katex from 'katex';

interface PlutoBondMessage {
    type: 'setBond';
    name: string;
    value: unknown;
}

interface PlutoShowMoreMessage {
    type: 'showMore';
    objectid: string;
}

// Flag to track if KaTeX styles have been added
let katexStylesAdded = false;

/**
 * Add KaTeX CSS styles to the document
 */
function addKaTeXStyles() {
    if (katexStylesAdded) return;

    const style = document.createElement('style');
    style.textContent = `
        /* KaTeX styles - minimal inline version */
        .katex { font: normal 1.21em KaTeX_Main, Times New Roman, serif; line-height: 1.2; text-indent: 0; text-rendering: auto; }
        .katex * { -ms-high-contrast-adjust: none !important; }
        .katex .katex-html { display: inline-block; }
        .katex .katex-mathml { position: absolute; clip: rect(1px, 1px, 1px, 1px); padding: 0; border: 0; height: 1px; width: 1px; overflow: hidden; }
        .katex .base { position: relative; display: inline-block; }
        .katex .strut { display: inline-block; }
        .katex .textbf { font-weight: bold; }
        .katex .textit { font-style: italic; }
        .katex .textrm { font-family: KaTeX_Main; }
        .katex .textsf { font-family: KaTeX_SansSerif; }
        .katex .texttt { font-family: KaTeX_Typewriter; }
        .katex .mathnormal { font-family: KaTeX_Math; font-style: italic; }
        .katex .mathit { font-family: KaTeX_Main; font-style: italic; }
        .katex .mathrm { font-style: normal; }
        .katex .mathbf { font-family: KaTeX_Main; font-weight: bold; }
        .katex .boldsymbol { font-family: KaTeX_Math; font-weight: bold; font-style: italic; }
        .katex .amsrm { font-family: KaTeX_AMS; }
        .katex .mathbb, .katex .textbb { font-family: KaTeX_AMS; }
        .katex .mathcal { font-family: KaTeX_Caligraphic; }
        .katex .mathfrak, .katex .textfrak { font-family: KaTeX_Fraktur; }
        .katex .mathtt { font-family: KaTeX_Typewriter; }
        .katex .mathscr, .katex .textscr { font-family: KaTeX_Script; }
        .katex .mathsf, .katex .textsf { font-family: KaTeX_SansSerif; }
        .katex .mord { }
        .katex .mop { }
        .katex .mbin { }
        .katex .mrel { }
        .katex .mopen { }
        .katex .mclose { }
        .katex .mpunct { }
        .katex .minner { }
        .katex .msupsub { text-align: left; }
        .katex .mfrac > span > span { text-align: center; }
        .katex .mfrac .frac-line { display: inline-block; width: 100%; border-bottom-style: solid; }
        .katex .sqrt > .root { margin-left: 0.27777778em; margin-right: -0.55555556em; }
        .katex .sizing, .katex .fontsize-ensurer { display: inline-block; }
        .katex .delimsizing { }
        .katex .nulldelimiter { display: inline-block; width: 0.12em; }
        .katex .op-symbol { position: relative; }
        .katex .op-limits > .vlist-t { text-align: center; }
        .katex .accent > .vlist-t { text-align: center; }
        .katex .vlist-t { display: inline-table; table-layout: fixed; }
        .katex .vlist-r { display: table-row; }
        .katex .vlist { display: table-cell; vertical-align: bottom; position: relative; }
        .katex .vlist > span { display: block; height: 0; position: relative; }
        .katex .vlist > span > span { display: inline-block; }
        .katex .vlist > span > .pstrut { overflow: hidden; width: 0; }
        .katex .vlist-s { display: table-cell; vertical-align: bottom; font-size: 1px; width: 0; }
        .katex-display { display: block; margin: 1em 0; text-align: center; }
        .katex-display > .katex { display: block; text-align: center; white-space: nowrap; }
        .katex-display > .katex > .katex-html { display: block; position: relative; }
        .katex-display > .katex > .katex-html > .tag { position: absolute; right: 0; }

        /* Display math block styling */
        .math-display {
            display: block;
            margin: 1em 0;
            text-align: center;
        }
        .math-inline {
            display: inline;
        }
    `;
    document.head.appendChild(style);
    katexStylesAdded = true;
}

/**
 * Render math expressions in an element using KaTeX
 *
 * Pluto.jl wraps LaTeX in elements with class "tex":
 * - Inline: <span class="tex">$formula$</span>
 * - Block: <p class="tex">$$formula$$</p>
 */
function renderMathInElement(element: HTMLElement): void {
    // Find all elements with class "tex" (Pluto.jl's convention)
    const texElements = element.querySelectorAll('.tex');
    console.log('[PlutoRenderer] Found .tex elements:', texElements.length);

    texElements.forEach((texEl) => {
        const text = texEl.textContent || '';
        console.log('[PlutoRenderer] Processing .tex element:', text.slice(0, 100));

        // Check for display math ($$...$$) or inline math ($...$)
        const displayMatch = text.match(/^\$\$([\s\S]*)\$\$$/);
        const inlineMatch = text.match(/^\$([\s\S]*)\$$/);

        const isDisplay = displayMatch !== null;
        const formula = isDisplay ? displayMatch[1] : (inlineMatch ? inlineMatch[1] : null);

        if (formula) {
            try {
                // Clear the element and render with KaTeX
                texEl.innerHTML = '';
                katex.render(formula.trim(), texEl as HTMLElement, {
                    displayMode: isDisplay,
                    throwOnError: false,
                    output: 'html'
                });
                console.log('[PlutoRenderer] Rendered formula:', formula.slice(0, 50));
            } catch (e) {
                console.warn('[PlutoRenderer] KaTeX error for formula:', formula, e);
            }
        }
    });

    // Also process text nodes directly for cases where .tex class is not used
    // (fallback for raw $...$ in text)
    processTextNodesForMath(element);
}

/**
 * Process text nodes directly for math expressions (fallback)
 */
function processTextNodesForMath(element: HTMLElement): void {
    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
    );

    const nodesToProcess: { node: Text; parent: Node }[] = [];

    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const text = textNode.textContent || '';

        // Skip if already inside a KaTeX rendered element
        if (textNode.parentElement?.closest('.katex')) {
            continue;
        }

        // Check if text contains math delimiters
        if (text.includes('$')) {
            const parent = textNode.parentNode;
            if (parent) {
                nodesToProcess.push({ node: textNode, parent });
            }
        }
    }

    // Process collected nodes (reverse order to maintain positions)
    for (const { node, parent } of nodesToProcess.reverse()) {
        const text = node.textContent || '';
        const fragment = processTextWithMath(text);
        if (fragment) {
            parent.replaceChild(fragment, node);
        }
    }
}

/**
 * Process text containing math expressions and return a document fragment
 */
function processTextWithMath(text: string): DocumentFragment | null {
    const fragment = document.createDocumentFragment();
    let hasChanges = false;
    let lastIndex = 0;

    // Pattern for display math ($$...$$) and inline math ($...$)
    // Display math first to avoid matching $$ as two inline $
    const mathPattern = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;
    let match;

    while ((match = mathPattern.exec(text)) !== null) {
        hasChanges = true;

        // Add text before the match
        if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const isDisplay = match[1] !== undefined;
        const mathContent = isDisplay ? match[1] : match[2];

        try {
            const span = document.createElement('span');
            span.className = isDisplay ? 'math-display' : 'math-inline';

            katex.render(mathContent.trim(), span, {
                displayMode: isDisplay,
                throwOnError: false,
                output: 'html'
            });

            fragment.appendChild(span);
        } catch (e) {
            // If KaTeX fails, keep original text
            console.warn('[PlutoRenderer] KaTeX error:', e);
            fragment.appendChild(document.createTextNode(match[0]));
        }

        lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    return hasChanges ? fragment : null;
}

/**
 * Activate the renderer
 */
export function activate(context: RendererContext<void>) {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            const html = outputItem.text();

            // Debug log
            console.log('[PlutoRenderer] Rendering HTML output:', html.slice(0, 500));

            // Add KaTeX styles if not already added
            addKaTeXStyles();

            // Create a container for the HTML
            const container = document.createElement('div');
            container.className = 'pluto-output';

            // Parse and render the HTML
            container.innerHTML = html;

            // Debug: log text content before math rendering
            console.log('[PlutoRenderer] Text content before KaTeX:', container.textContent?.slice(0, 300));

            // Render math expressions using KaTeX
            renderMathInElement(container);

            // Find and setup interactive elements
            setupInteractiveElements(container, context);

            // Clear previous content and add new
            element.innerHTML = '';
            element.appendChild(container);
        }
    };
}

/**
 * Setup event listeners for interactive Pluto elements
 */
function setupInteractiveElements(container: HTMLElement, context: RendererContext<void>) {
    // Find all input elements that might be bound
    const inputs = container.querySelectorAll('input, select, textarea');

    inputs.forEach((input) => {
        const inputEl = input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

        // Look for Pluto bond attribute or data attribute
        // Pluto uses custom elements with specific attributes
        const bondName = findBondName(inputEl);

        if (bondName) {
            console.log(`[PlutoRenderer] Found bond: ${bondName}`);
            setupBondListener(inputEl, bondName, context);
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
                setupBondListener(input as HTMLInputElement, bondName, context);
            }
        }
    });

    // Handle Pluto's standard HTML structure for sliders
    // PlutoUI wraps inputs in specific structures
    setupPlutoUISliders(container, context);

    // Handle "show more" buttons in tree views
    setupShowMoreButtons(container, context);

    // Handle tree collapse/expand
    setupTreeCollapse(container);
}

/**
 * Find the bond name from an input element
 */
function findBondName(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | null {
    // Check various attributes that Pluto might use
    const bondAttr = input.getAttribute('bond') ||
                     input.getAttribute('data-bond') ||
                     input.getAttribute('name') ||
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
    context: RendererContext<void>
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

    // Listen for input events
    input.addEventListener('input', sendValue);
    input.addEventListener('change', sendValue);
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
function setupPlutoUISliders(container: HTMLElement, context: RendererContext<void>) {
    // Find range inputs (sliders)
    const rangeInputs = container.querySelectorAll('input[type="range"]');

    rangeInputs.forEach((input) => {
        const rangeInput = input as HTMLInputElement;

        // Try to find the bond name from parent elements
        let bondName = findBondNameFromParents(rangeInput);

        if (bondName) {
            console.log(`[PlutoRenderer] Setting up slider for bond: ${bondName}`);
            setupBondListener(rangeInput, bondName, context);
        } else {
            // If no bond name found, try to extract from surrounding HTML
            // PlutoUI often includes the variable name in span elements
            const parentHTML = rangeInput.parentElement?.outerHTML || '';
            console.log(`[PlutoRenderer] Slider without bond name, parent HTML:`, parentHTML.slice(0, 200));
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
            if (def) return def;
        }

        // Check for data-bond attribute
        const dataBond = current.getAttribute('data-bond');
        if (dataBond) return dataBond;

        // Check for pluto-bond class or similar
        if (current.classList.contains('pluto-bond')) {
            const bondName = current.getAttribute('data-name') ||
                           current.getAttribute('data-var');
            if (bondName) return bondName;
        }

        current = current.parentElement;
    }

    return null;
}

/**
 * Setup handlers for "show more" buttons in tree views
 */
function setupShowMoreButtons(container: HTMLElement, context: RendererContext<void>) {
    const moreButtons = container.querySelectorAll('pluto-tree-more');

    moreButtons.forEach((button) => {
        const moreBtn = button as HTMLElement;
        const objectid = moreBtn.getAttribute('data-objectid');

        if (objectid) {
            console.log(`[PlutoRenderer] Found "show more" button with objectid: ${objectid}`);

            moreBtn.style.cursor = 'pointer';
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log(`[PlutoRenderer] "show more" clicked, objectid: ${objectid}`);

                // Update button state
                moreBtn.textContent = 'loading...';
                moreBtn.style.opacity = '0.5';

                // Send message to extension
                if (context.postMessage) {
                    context.postMessage({
                        type: 'showMore',
                        objectid: objectid
                    } as PlutoShowMoreMessage);
                }
            });
        } else {
            // No objectid - show not supported message on click
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                moreBtn.textContent = '(expand not yet supported)';
                moreBtn.style.cursor = 'default';
                moreBtn.style.opacity = '0.4';
            });
        }
    });
}

/**
 * Setup tree collapse/expand functionality
 * Allows users to click on tree prefixes to toggle collapsed state
 */
function setupTreeCollapse(container: HTMLElement) {
    const trees = container.querySelectorAll('pluto-tree');

    trees.forEach((tree) => {
        const treeEl = tree as HTMLElement;

        // Add click handler to the tree element
        treeEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            // Only handle clicks on the tree itself or its prefix
            const clickedTree = target.closest('pluto-tree') as HTMLElement | null;
            const clickedPrefix = target.closest('pluto-tree-prefix');
            const clickedMore = target.closest('pluto-tree-more');

            // Don't toggle if clicking on "show more" button
            if (clickedMore) return;

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
        });
    });
}
