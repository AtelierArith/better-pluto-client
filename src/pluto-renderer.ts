/**
 * Pluto HTML Renderer for VS Code Notebook
 * Handles interactive elements like Slider, Checkbox, etc.
 * and sends bond updates back to the extension
 */

import type { RendererContext, OutputItem } from 'vscode-notebook-renderer';

interface PlutoBondMessage {
    type: 'setBond';
    name: string;
    value: unknown;
}

interface PlutoShowMoreMessage {
    type: 'showMore';
    objectid: string;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).MathJax as MathJaxObject | undefined;
}

// Helper to set MathJax config on window
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setMathJaxConfig(config: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).MathJax = config;
}

// Flag to track if MathJax has been initialized
let mathJaxInitialized = false;
let mathJaxLoadPromise: Promise<void> | null = null;

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
                resolve();
                return;
            }

            // Configure MathJax before loading the script
            setMathJaxConfig({
                options: {
                    ignoreHtmlClass: "no-MathJax",
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
                        } catch (e) {
                            console.warn('[PlutoRenderer] MathJax defaultReady error:', e);
                        }
                        mathJaxInitialized = true;
                        resolve();
                    }
                }
            });

            // Load MathJax from CDN
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js';
            script.async = true;
            script.id = 'MathJax-script';

            script.onload = () => {
                console.log('[PlutoRenderer] MathJax script loaded');
            };

            script.onerror = (e) => {
                console.error('[PlutoRenderer] Failed to load MathJax:', e);
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
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            const html = outputItem.text();

            // Debug log
            console.log('[PlutoRenderer] Rendering HTML output:', html.slice(0, 500));

            // Create a container for the HTML
            const container = document.createElement('div');
            container.className = 'pluto-output';

            // Parse and render the HTML
            container.innerHTML = html;

            // Find and setup interactive elements
            setupInteractiveElements(container, context);

            // Clear previous content and add new
            element.innerHTML = '';
            element.appendChild(container);

            // Execute any scripts in the HTML (needed for Plotly, etc.)
            executeScripts(container).catch(err => {
                console.warn('[PlutoRenderer] Script execution error:', err);
            });

            // Render math expressions using MathJax (async)
            renderMathInElement(container).catch(err => {
                console.warn('[PlutoRenderer] Math rendering error:', err);
            });
        }
    };
}

/**
 * Execute scripts in the HTML content
 * innerHTML doesn't execute scripts, so we need to do it manually
 * This is needed for Plotly, and other JavaScript-based visualizations
 */
async function executeScripts(container: HTMLElement): Promise<void> {
    const scripts = container.querySelectorAll('script');
    console.log(`[PlutoRenderer] Found ${scripts.length} scripts to execute`);

    for (const oldScript of Array.from(scripts)) {
        const newScript = document.createElement('script');

        // Copy attributes
        for (const attr of Array.from(oldScript.attributes)) {
            newScript.setAttribute(attr.name, attr.value);
        }

        if (oldScript.src) {
            // External script - load it
            console.log(`[PlutoRenderer] Loading external script: ${oldScript.src}`);
            await new Promise<void>((resolve, reject) => {
                newScript.onload = () => {
                    console.log(`[PlutoRenderer] External script loaded: ${oldScript.src}`);
                    resolve();
                };
                newScript.onerror = (e) => {
                    console.error(`[PlutoRenderer] Failed to load script: ${oldScript.src}`, e);
                    reject(e);
                };
                oldScript.parentNode?.replaceChild(newScript, oldScript);
            });
        } else {
            // Inline script - copy content and execute
            newScript.textContent = oldScript.textContent;
            oldScript.parentNode?.replaceChild(newScript, oldScript);
            console.log(`[PlutoRenderer] Executed inline script (${oldScript.textContent?.length || 0} chars)`);
        }
    }
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
