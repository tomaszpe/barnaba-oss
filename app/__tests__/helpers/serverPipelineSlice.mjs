import { readFileSync } from 'fs';

/**
 * Shared setup for the tests that run the REAL emission path inside a vm sandbox.
 *
 * Why this helper exists (28.08.2026)
 * -----------------------------------
 * Two test files extract the same contiguous slice of server.js and execute it with
 * a hand-built context. Anything the slice references but does not declare has to be
 * supplied by that context - including every module-level flag declared ABOVE the
 * slice.
 *
 * That makes the arrangement quietly fragile: adding one `const X = process.env...`
 * near the top of server.js breaks both files, and it breaks them as a
 * `ReferenceError` thrown from generated code inside the sandbox, pointing at
 * `evalmachine.<anonymous>:749`. Release 1.6.0 added B4_CADENCE_V2_SHADOW_ENABLED and
 * cost 15 red tests that way, with a stack trace that named neither the flag's origin
 * nor the fix.
 *
 * `assertContextProvides` turns that into a setup-time failure that says which names
 * are missing. The fragility is inherent to running a source slice out of context;
 * what is not inherent is finding out about it from a line number in generated code.
 */

const SLICE_START = 'const DE_STOPWORDS = new Set([';
const SLICE_END = '// Client (listener) handlers';

// Names that are ambient in any JS context and are never supplied by the caller.
const AMBIENT = new Set([
    'JSON', 'NaN', 'Infinity', 'Math', 'Date', 'Number', 'String', 'Boolean',
    'Array', 'Object', 'Map', 'Set', 'Promise', 'URL', 'Error', 'RegExp', 'Symbol',
    'BigInt', 'WeakMap', 'WeakSet', 'Intl', 'ArrayBuffer', 'Uint8Array', 'Float32Array',
]);

/** Comments and string/template literals removed, so text is not mistaken for code. */
function stripLiterals(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

export function buildPipelineSlice(importMetaUrl) {
    const serverSource = readFileSync(new URL('../server.js', importMetaUrl), 'utf8');
    const start = serverSource.indexOf(SLICE_START);
    const end = serverSource.indexOf(SLICE_END, start);
    if (start < 0 || end < 0) {
        throw new Error(
            `server.js slice markers not found (start=${start}, end=${end}). ` +
            'The pipeline tests pin these markers; if the source moved, update them here.',
        );
    }
    return `${serverSource.slice(start, end)}\nthis.processCompleteSentence = processCompleteSentence;`;
}

/**
 * Every SCREAMING_CASE name the slice reads but does not declare must be in the
 * context. Returns the missing ones; the caller asserts on it.
 */
export function missingContextNames(pipelineSource, context) {
    const code = stripLiterals(pipelineSource);
    const declared = new Set(
        [...code.matchAll(/\b(?:const|let|var|function)\s+([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]),
    );
    const used = new Set([...code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]));

    return [...used]
        .filter((name) => !declared.has(name) && !AMBIENT.has(name) && !(name in context))
        .sort();
}

export function assertContextProvides(pipelineSource, context) {
    const missing = missingContextNames(pipelineSource, context);
    if (missing.length) {
        throw new Error(
            'vm sandbox context is missing names the server.js slice reads: ' +
            `${missing.join(', ')}. They are declared above the slice in server.js, so the ` +
            'sandbox has to supply them. Add them to the context with their production default.',
        );
    }
}
