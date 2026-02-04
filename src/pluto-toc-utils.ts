/**
 * Pure helpers for TableOfContents (PlutoUI) detection in the renderer.
 * Kept separate so they can be unit-tested without DOM.
 */

/**
 * True if HTML looks like PlutoUI TableOfContents (script with scrollIntoView etc.).
 */
export function isTableOfContentsLike(html: string): boolean {
    const trimmed = html.trim();
    return (trimmed.startsWith('<script') || trimmed.includes('scrollIntoView')) &&
           (trimmed.includes('scrollIntoView') || trimmed.includes('TableOfContents') || trimmed.includes('table-of-contents'));
}
