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

/**
 * Activate the renderer
 */
export function activate(context: RendererContext<void>) {
    return {
        renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
            const html = outputItem.text();

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
