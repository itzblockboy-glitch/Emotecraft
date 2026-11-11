#!/usr/bin/env node
'use strict';
/**
 * Builds the distributable add-on.
 *
 *   1. runs the emote converter (Java jar -> Bedrock animations/textures/audio)
 *   2. bundles the behaviour pack scripts into a single scripts/index.js
 *      (Bedrock cannot resolve ES module imports between files)
 *   3. zips RP + BP and produces:
 *        dist/Emotecraft-Bedrock.mcaddon      (double click to install)
 *        dist/Emotecraft-RP.mcpack            (resource pack on its own)
 *        dist/Emotecraft-BP.mcpack            (behaviour pack on its own)
 *
 * Usage: node tools/build.js [--no-convert] [--skip-bundle]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');

const args = process.argv.slice(2);
const skipConvert = args.includes('--no-convert');
const skipBundle = args.includes('--skip-bundle');

// ---------------------------------------------------------------------------
// ZIP writer (deflate), no external dependencies.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
    return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
    const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { time, day };
}

/** Writes a zip from a list of { name, data } entries. */
function writeZip(target, entries) {
    const now = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        const useDeflate = deflated.length < raw.length;
        const body = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(now.time, 10);
        local.writeUInt16LE(now.day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        chunks.push(local, nameBuf, body);

        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0, 8);
        record.writeUInt16LE(method, 10);
        record.writeUInt16LE(now.time, 12);
        record.writeUInt16LE(now.day, 14);
        record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(body.length, 20);
        record.writeUInt32LE(raw.length, 24);
        record.writeUInt16LE(nameBuf.length, 28);
        record.writeUInt16LE(0, 30);
        record.writeUInt16LE(0, 32);
        record.writeUInt16LE(0, 34);
        record.writeUInt16LE(0, 36);
        record.writeUInt32LE(0, 38);
        record.writeUInt32LE(offset, 42);
        central.push(record, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }

    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.concat([...chunks, centralBuf, end]));
    return fs.statSync(target).size;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function walk(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, base, out);
        else out.push({ name: path.relative(base, full).split(path.sep).join('/'), file: full });
    }
    return out;
}

function collect(dir) {
    return walk(dir).map(entry => ({ name: entry.name, data: fs.readFileSync(entry.file) }));
}

// ---------------------------------------------------------------------------
// Script bundling
// ---------------------------------------------------------------------------

function bundleScripts() {
    const { bundle } = require('./lib/bundler.js');
    const output = bundle(path.join(SRC, 'BP', 'scripts'), 'index.js');
    fs.mkdirSync(BUILD, { recursive: true });
    fs.writeFileSync(path.join(BUILD, 'index.bundle.js'), output);
    return Buffer.from(output);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const t0 = Date.now();
    fs.mkdirSync(DIST, { recursive: true });

    if (!skipConvert) {
        console.log('→ converting emotes from the Emotecraft jar');
        execFileSync(process.execPath, [path.join(__dirname, 'convert.js'), ...args.filter(a => a.startsWith('--jar'))], {
            stdio: 'inherit',
            cwd: ROOT,
        });
    }

    const bundled = skipBundle ? null : bundleScripts();

    const bpEntries = collect(path.join(SRC, 'BP')).filter(entry => {
        if (entry.name === 'scripts/index.js') return false;
        return !entry.name.startsWith('scripts/');
    });
    if (bundled) bpEntries.push({ name: 'scripts/index.js', data: bundled });
    // Ship the raw sources too so servers can inspect/modify them.
    for (const { name, data } of collect(path.join(SRC, 'BP', 'scripts'))) {
        if (name === 'index.js') continue;
        bpEntries.push({ name: `scripts/source/${name}`, data });
    }

    const rpEntries = collect(path.join(SRC, 'RP'));

    const ordered = entries =>
        entries.sort((a, b) => {
            const aManifest = a.name === 'manifest.json' ? 0 : 1;
            const bManifest = b.name === 'manifest.json' ? 0 : 1;
            return aManifest - bManifest || a.name.localeCompare(b.name);
        });

    const rpSize = writeZip(path.join(DIST, 'Emotecraft-RP.mcpack'), ordered(rpEntries));
    const bpSize = writeZip(path.join(DIST, 'Emotecraft-BP.mcpack'), ordered(bpEntries));

    const addon = [
        ...rpEntries.map(entry => ({ name: `Emotecraft_RP/${entry.name}`, data: entry.data })),
        ...bpEntries.map(entry => ({ name: `Emotecraft_BP/${entry.name}`, data: entry.data })),
    ];
    const addonSize = writeZip(path.join(DIST, 'Emotecraft-Bedrock.mcaddon'), addon);

    const kb = bytes => `${(bytes / 1024).toFixed(0)} KB`;
    console.log(`\n✓ dist/Emotecraft-Bedrock.mcaddon  ${kb(addonSize)}`);
    console.log(`✓ dist/Emotecraft-RP.mcpack        ${kb(rpSize)}`);
    console.log(`✓ dist/Emotecraft-BP.mcpack        ${kb(bpSize)}`);
    console.log(`  (${rpEntries.length} RP files, ${bpEntries.length} BP files, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

main();
