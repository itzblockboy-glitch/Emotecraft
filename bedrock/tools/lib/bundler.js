'use strict';
/**
 * Tiny ES-module bundler.
 *
 * Bedrock runs a single behaviour-pack script, so the RP-sourced modules have to
 * be flattened into one file. This bundler handles exactly the subset used by
 * the project:
 *
 *   import { a, b as c } from "./x.js";
 *   import { a } from "@minecraft/...";     (left as an external import)
 *   export const|let|function|class NAME
 *   export { a, b as c };
 *
 * It keeps live bindings by exporting the resolved values after the module body
 * runs, which is enough because the project has no circular imports.
 */

const fs = require('fs');
const path = require('path');

const EXTERNAL_PREFIX = '@minecraft/';

function collectFiles(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectFiles(full, base, out);
        else if (entry.name.endsWith('.js')) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
    return out;
}

function resolveRelative(fromId, spec) {
    const dir = path.posix.dirname(fromId);
    let resolved = path.posix.normalize(path.posix.join(dir, spec));
    if (!resolved.endsWith('.js')) resolved += '.js';
    return resolved;
}

function parseImportList(names) {
    return names
        .split(',')
        .map(n => n.trim())
        .filter(Boolean)
        .map(n => {
            const match = n.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
            return match ? `${match[1]}: ${match[2]}` : n;
        });
}

/** Rewrites one module source, returning { code, exports }. */
function transformModule(id, source, idForRelative, externals) {
    const exports = new Set();
    let code = source;

    // import { ... } from "spec";
    code = code.replace(/^[ \t]*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/gm, (_, names, spec) => {
        const bindings = parseImportList(names).join(', ');
        if (spec.startsWith('.')) {
            return `const { ${bindings} } = __import(${JSON.stringify(idForRelative(id, spec))});`;
        }
        const variable = externals[spec];
        if (!variable) throw new Error(`Unsupported external module "${spec}" in ${id}`);
        return `const { ${bindings} } = ${variable};`;
    });

    // import * as ns from "spec";
    code = code.replace(/^[ \t]*import\s*\*\s*as\s*([\w$]+)\s*from\s*["']([^"']+)["'];?/gm, (_, name, spec) => {
        if (spec.startsWith('.')) return `const ${name} = __import(${JSON.stringify(idForRelative(id, spec))});`;
        const variable = externals[spec];
        if (!variable) throw new Error(`Unsupported external module "${spec}" in ${id}`);
        return `const ${name} = ${variable};`;
    });

    // export const/let/var/function/class NAME
    code = code.replace(/^([ \t]*)export\s+(const|let|var|function|class|async function)\s+([\w$]+)/gm, (_, indent, kind, name) => {
        exports.add(name);
        return `${indent}${kind} ${name}`;
    });

    // export { a, b as c };
    code = code.replace(/^[ \t]*export\s*\{([^}]*)\};?/gm, (_, names) => {
        for (const item of names.split(',').map(n => n.trim()).filter(Boolean)) {
            const match = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
            if (match) {
                exports.add(match[1]);
                return `const ${match[2]} = ${match[1]};`;
            }
            exports.add(item);
        }
        return '';
    });

    if (/^\s*export\s+default/m.test(code)) throw new Error(`Default exports are not supported (${id})`);
    if (/^\s*export\s+\*/m.test(code)) throw new Error(`export * is not supported (${id})`);

    const exportLines = [...exports].map(name => `__exports[${JSON.stringify(name)}] = ${name};`).join('\n');
    return { code: `${code}\n${exportLines}`, exports };
}

/**
 * Bundles `entry` (path relative to `root`) into a single ES module string.
 * External `@minecraft/*` imports are hoisted to the top of the bundle.
 */
function bundle(root, entry = 'index.js') {
    const modules = collectFiles(root);
    if (!modules.includes(entry)) throw new Error(`Entry module not found: ${entry}`);

    const ids = new Map();
    modules.forEach((id, index) => ids.set(id, index + 1));

    const externals = {
        '@minecraft/server': '__mcServer',
        '@minecraft/server-ui': '__mcServerUi',
    };

    const idForRelative = (from, spec) => {
        const resolved = resolveRelative(from, spec);
        if (!ids.has(resolved)) throw new Error(`Cannot resolve "${spec}" from ${from}`);
        return ids.get(resolved);
    };

    const bodies = [];
    for (const id of modules) {
        const source = fs.readFileSync(path.join(root, id), 'utf8');
        const { code } = transformModule(id, source, idForRelative, externals);
        bodies.push(`__define(${ids.get(id)}, ${JSON.stringify(id)}, function (__exports) {\n${code}\n});`);
    }

    return `// Emotecraft for Bedrock - bundled behaviour pack script
// Generated by tools/build.js - do not edit. Source lives in src/BP/scripts.
import * as __mcServer from "@minecraft/server";
import * as __mcServerUi from "@minecraft/server-ui";

const __factories = {};
const __cache = {};
let __loading = null;

function __define(id, name, factory) { __factories[id] = { name, factory }; }

function __import(id) {
    if (__cache[id]) return __cache[id];
    if (__loading === id) return __cache[id] || (__cache[id] = {});
    const entry = __factories[id];
    if (!entry) throw new Error("Unknown module id " + id);
    const exports = {};
    __cache[id] = exports;
    const previous = __loading;
    __loading = id;
    try {
        entry.factory(exports);
    } finally {
        __loading = previous;
    }
    return exports;
}

${bodies.join('\n\n')}

const __entry = __import(${ids.get(entry)});
export default __entry;
`;
}

module.exports = { bundle, collectFiles };
