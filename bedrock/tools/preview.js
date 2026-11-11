#!/usr/bin/env node
'use strict';
/**
 * Renders stick-figure previews of the converted emotes.
 *
 * This is a development aid: it applies the *generated Bedrock animation data*
 * through the vanilla humanoid skeleton so the poses can be eyeballed without
 * launching Minecraft. Output: docs/preview-<emote>.png plus docs/preview.png
 * (contact sheet).
 *
 * Usage: node tools/preview.js [emoteId...]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ANIM_DIR = path.join(ROOT, 'src', 'RP', 'animations', 'emotes');
const OUT_DIR = path.resolve(ROOT, '..', 'docs');

// ---------------------------------------------------------------------------
// Tiny PNG writer
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

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

class Canvas {
    constructor(width, height, background = [18, 18, 24, 255]) {
        this.width = width;
        this.height = height;
        this.data = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            this.data[i * 4] = background[0];
            this.data[i * 4 + 1] = background[1];
            this.data[i * 4 + 2] = background[2];
            this.data[i * 4 + 3] = background[3];
        }
    }

    plot(x, y, colour) {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
        const i = (py * this.width + px) * 4;
        this.data[i] = colour[0];
        this.data[i + 1] = colour[1];
        this.data[i + 2] = colour[2];
        this.data[i + 3] = 255;
    }

    line(x0, y0, x1, y1, colour, thickness = 2) {
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = x0 + (x1 - x0) * t;
            const y = y0 + (y1 - y0) * t;
            for (let dx = -thickness; dx <= thickness; dx++) {
                for (let dy = -thickness; dy <= thickness; dy++) {
                    if (dx * dx + dy * dy <= thickness * thickness) this.plot(x + dx, y + dy, colour);
                }
            }
        }
    }

    rect(x, y, w, h, colour) {
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.plot(x + xx, y + yy, colour);
    }

    save(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, encodePng(this.width, this.height, this.data));
    }
}

// ---------------------------------------------------------------------------
// Small 3D maths (Bedrock rotates bones X then Y then Z, degrees)
// ---------------------------------------------------------------------------

function rotX(v, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotY(v, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
function rotZ(v, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

function rotate(v, rotation) {
    return rotZ(rotY(rotX(v, rotation[0]), rotation[1]), rotation[2]);
}

// ---------------------------------------------------------------------------
// Skeleton (Bedrock geometry.humanoid.custom, in model pixels)
// ---------------------------------------------------------------------------

const SKELETON = {
    root: { pivot: [0, 0, 0], parent: null },
    waist: { pivot: [0, 12, 0], parent: 'root' },
    body: { pivot: [0, 24, 0], parent: 'waist' },
    head: { pivot: [0, 24, 0], parent: 'body' },
    rightArm: { pivot: [-5, 22, 0], parent: 'body', length: 12 },
    leftArm: { pivot: [5, 22, 0], parent: 'body', length: 12 },
    rightLeg: { pivot: [-1.9, 12, 0], parent: 'root', length: 12 },
    leftLeg: { pivot: [1.9, 12, 0], parent: 'root', length: 12 },
};

/** Samples an animation's channel value at `time` (linear). */
function sampleChannel(channel, time) {
    if (!channel) return null;
    if (Array.isArray(channel)) return channel;
    const times = Object.keys(channel)
        .map(Number)
        .sort((a, b) => a - b);
    if (!times.length) return null;
    if (time <= times[0]) return channel[String(times[0])];
    if (time >= times[times.length - 1]) return channel[String(times[times.length - 1])];
    let i = 0;
    while (i < times.length - 1 && times[i + 1] < time) i++;
    const t0 = times[i];
    const t1 = times[i + 1];
    const a = channel[String(t0)];
    const b = channel[String(t1)];
    const k = (time - t0) / (t1 - t0 || 1);
    return a.map((v, j) => v + (b[j] - v) * k);
}

function poseAt(animation, time) {
    const pose = {};
    for (const [bone, channels] of Object.entries(animation.bones || {})) {
        pose[bone] = {
            rotation: sampleChannel(channels.rotation, time) || [0, 0, 0],
            position: sampleChannel(channels.position, time) || [0, 0, 0],
        };
    }
    return pose;
}

/**
 * Resolves world-space joint positions for a pose.
 *
 * Bedrock bone pivots are absolute model-space coordinates, so a child's offset
 * from its parent is `childPivot - parentPivot`; the parent transform is applied
 * around the parent's own pivot. Getting this wrong folds the skeleton in half,
 * which is exactly what this preview is here to catch.
 */
function joints(pose) {
    const world = {};

    const resolve = name => {
        if (world[name]) return world[name];
        const bone = SKELETON[name];
        const local = pose[name] || { rotation: [0, 0, 0], position: [0, 0, 0] };
        const parentWorld = bone.parent ? resolve(bone.parent).matrix : identity();
        const parentPivot = bone.parent ? SKELETON[bone.parent].pivot : [0, 0, 0];

        const offset = add(sub(bone.pivot, parentPivot), scale(local.position, 16));
        const matrix = multiply(parentWorld, translate(offset), rotationMatrix(local.rotation));
        world[name] = { matrix, pivot: transform(matrix, [0, 0, 0]), rotation: local.rotation };
        return world[name];
    };

    for (const name of Object.keys(SKELETON)) resolve(name);

    const point = (name, localOffset) => transform(world[name].matrix, localOffset);

    return {
        hips: world.waist.pivot,
        chest: world.body.pivot,
        head: point('head', [0, 0, 0]),
        headTop: point('head', [0, 8, 0]),
        rightArm: point('rightArm', [0, 0, 0]),
        rightHand: point('rightArm', [0, -12, 0]),
        leftArm: point('leftArm', [0, 0, 0]),
        leftHand: point('leftArm', [0, -12, 0]),
        rightLeg: point('rightLeg', [0, 0, 0]),
        rightFoot: point('rightLeg', [0, -12, 0]),
        leftLeg: point('leftLeg', [0, 0, 0]),
        leftFoot: point('leftLeg', [0, -12, 0]),
        matrix: world,
    };
}

function identity() {
    return [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];
}

function translate(v) {
    const m = identity();
    m[0][3] = v[0];
    m[1][3] = v[1];
    m[2][3] = v[2];
    return m;
}

function rotationMatrix([x, y, z]) {
    // Bedrock: X then Y then Z  =>  R = Rz * Ry * Rx
    const rx = ((x * Math.PI) / 180);
    const ry = ((y * Math.PI) / 180);
    const rz = ((z * Math.PI) / 180);
    const Rx = [
        [1, 0, 0, 0],
        [0, Math.cos(rx), -Math.sin(rx), 0],
        [0, Math.sin(rx), Math.cos(rx), 0],
        [0, 0, 0, 1],
    ];
    const Ry = [
        [Math.cos(ry), 0, Math.sin(ry), 0],
        [0, 1, 0, 0],
        [-Math.sin(ry), 0, Math.cos(ry), 0],
        [0, 0, 0, 1],
    ];
    const Rz = [
        [Math.cos(rz), -Math.sin(rz), 0, 0],
        [Math.sin(rz), Math.cos(rz), 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ];
    return multiply(Rz, Ry, Rx);
}

function multiply(...matrices) {
    return matrices.reduce((a, b) => {
        const out = identity();
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += a[i][k] * b[k][j];
                out[i][j] = sum;
            }
        }
        return out;
    });
}

function transform(matrix, v) {
    return [
        matrix[0][0] * v[0] + matrix[0][1] * v[1] + matrix[0][2] * v[2] + matrix[0][3],
        matrix[1][0] * v[0] + matrix[1][1] * v[1] + matrix[1][2] * v[2] + matrix[1][3],
        matrix[2][0] * v[0] + matrix[2][1] * v[1] + matrix[2][2] * v[2] + matrix[2][3],
    ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const COLOURS = {
    torso: [90, 170, 255, 255],
    head: [255, 210, 120, 255],
    arms: [120, 240, 180, 255],
    legs: [200, 140, 255, 255],
};

function drawPose(canvas, pose, originX, originY, scaleFactor, viewYaw) {
    const j = joints(pose);
    // Simple yaw rotation + orthographic projection (front view, slightly turned).
    const project = p => {
        const rotated = rotY(sub(p, [0, 18, 0]), viewYaw);
        return [originX + rotated[0] * scaleFactor, originY - rotated[1] * scaleFactor];
    };

    const hips = project(j.hips);
    const chest = project(j.chest);
    
    canvas.line(hips[0], hips[1], chest[0], chest[1], COLOURS.torso, 4);
    canvas.rect(chest[0] - 7, chest[1] - 3, 14, 12, COLOURS.torso);
    const neck = project(j.head);
    canvas.rect(neck[0] - 5, neck[1] - 12, 10, 10, COLOURS.head);

    for (const [joint, hand] of [
        [j.rightArm, j.rightHand],
        [j.leftArm, j.leftHand],
    ]) {
        const a = project(joint);
        const b = project(hand);
        canvas.line(a[0], a[1], b[0], b[1], COLOURS.arms, 3);
    }
    for (const [joint, foot] of [
        [j.rightLeg, j.rightFoot],
        [j.leftLeg, j.leftFoot],
    ]) {
        const a = project(joint);
        const b = project(foot);
        canvas.line(a[0], a[1], b[0], b[1], COLOURS.legs, 3);
    }

    // ground line
    const ground = project([0, 0, 0]);
    canvas.line(ground[0] - 40, ground[1], ground[0] + 40, ground[1], [60, 60, 72, 255], 1);
}

function renderEmote(emoteId, animation, frames = 6, size = 150) {
    const canvas = new Canvas(size * frames, size + 20);
    const length = animation.animation_length || 1;
    canvas.rect(0, 0, canvas.width, canvas.height, [18, 18, 24, 255]);
    for (let i = 0; i < frames; i++) {
        const time = (i / frames) * length;
        const pose = poseAt(animation, time);
        drawPose(canvas, pose, i * size + size / 2, size - 12, 3.0, -18);
        // frame marker
        for (let x = 0; x <= 2; x++) canvas.plot(i * size + x, size + 12, [120, 120, 140, 255]);
        const label = `${emoteId} ${time.toFixed(2)}s`;
        drawText(canvas, 6 + i * size, 12, `${time.toFixed(2)}s`, [150, 150, 170, 255]);
    }
    return canvas;
}

// 3x5 bitmap font, enough for the frame labels.
const FONT = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
    ".": ["000", "000", "000", "000", "010"],
    s: ["011", "100", "010", "001", "110"],
};

function drawText(canvas, x, y, text, colour) {
    let cursor = x;
    for (const char of text) {
        const glyph = FONT[char];
        if (glyph) {
            glyph.forEach((row, ry) => {
                [...row].forEach((cell, rx) => {
                    if (cell === "1") canvas.plot(cursor + rx, y + ry, colour);
                });
            });
        }
        cursor += 4;
    }
}

function main() {
    const requested = process.argv.slice(2);
    const files = fs
        .readdirSync(ANIM_DIR)
        .filter(f => f.endsWith('.animation.json') && !f.includes('.loop.'))
        .sort();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const sheets = [];
    for (const file of files) {
        const id = file.replace('.animation.json', '');
        if (requested.length && !requested.includes(id)) continue;
        const data = JSON.parse(fs.readFileSync(path.join(ANIM_DIR, file), 'utf8'));
        const key = Object.keys(data.animations)[0];
        const animation = data.animations[key];
        const canvas = renderEmote(id, animation);
        canvas.save(path.join(OUT_DIR, `preview-${id}.png`));
        sheets.push({ id, canvas, length: animation.animation_length });
        console.log(`  rendered ${id} (${animation.animation_length}s)`);
    }

    // Contact sheet: two columns of emote strips.
    if (sheets.length && !requested.length) {
        const width = Math.max(...sheets.map(s => s.canvas.width));
        const rowHeight = 168;
        const rows = Math.ceil(sheets.length / 1);
        const sheet = new Canvas(width, rows * rowHeight);
        sheets.forEach((entry, index) => {
            const y = index * rowHeight;
            for (let i = 0; i < entry.canvas.width; i++) {
                for (let j = 0; j < entry.canvas.height; j++) {
                    const src = (j * entry.canvas.width + i) * 4;
                    const dst = ((y + j) * width + i) * 4;
                    sheet.data[dst] = entry.canvas.data[src];
                    sheet.data[dst + 1] = entry.canvas.data[src + 1];
                    sheet.data[dst + 2] = entry.canvas.data[src + 2];
                    sheet.data[dst + 3] = 255;
                }
            }
        });
        sheet.save(path.join(OUT_DIR, 'preview.png'));
        console.log(`\nContact sheet -> ${path.relative(process.cwd(), path.join(OUT_DIR, 'preview.png'))}`);
    }
}

main();
