#!/usr/bin/env node
'use strict';
/**
 * Converts the emotes bundled with the Emotecraft Java mod into Bedrock assets.
 *
 *   RP/animations/emotes/<id>.animation.json       baked Bedrock bone animation
 *   RP/animations/emotes/<id>.loop.animation.json  looping window (looping emotes)
 *   RP/textures/emotecraft/emote/<id>.png          emote icon
 *   RP/sounds/emotecraft/<id>.ogg                  Ogg Vorbis (transcoded from Opus)
 *   RP/sounds/sound_definitions.json               sound events
 *   BP/scripts/data/emotes.js                      catalogue used by the UI
 *
 * Usage:  node tools/convert.js [--jar <emotecraft.jar>]
 *
 * Audio: Emotecraft ships Ogg *Opus*, Bedrock only decodes Ogg *Vorbis*. When a
 * Python with `soundfile` (libsndfile) is available the converter transcodes
 * automatically; existing .ogg files are never overwritten, so building without
 * Python still works.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { readEmote, bakeEmote, BEDROCK_BONES } = require('./lib/emote');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RP = path.join(SRC, 'RP');
const BP = path.join(SRC, 'BP');
const OUT_ANIM = path.join(RP, 'animations', 'emotes');
const OUT_TEX = path.join(RP, 'textures', 'emotecraft', 'emote');
const OUT_SND = path.join(RP, 'sounds', 'emotecraft');
const OUT_DATA = path.join(BP, 'scripts', 'data');
const CUSTOM_DIR = path.join(ROOT, 'custom');

const DEFAULT_EMOTE_JAR = path.resolve(ROOT, '..', 'emotecraft-for-MC26.3-3.5.0-b.build.179.jar');
const FPS = 20;

// ---------------------------------------------------------------------------
// Minimal ZIP reader (stored + deflate), no external dependencies.
// ---------------------------------------------------------------------------

function readZip(file) {
    const buf = fs.readFileSync(file);
    const entries = new Map();

    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65558; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error(`${file} is not a zip archive`);

    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt central directory');
        const method = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const raw = buf.slice(dataStart, dataStart + compressedSize);

        entries.set(name, { name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Animation writer
// ---------------------------------------------------------------------------

/**
 * Builds one Bedrock animation file.
 *
 * `override_previous_animation` is set so an emote fully replaces the vanilla
 * walk/look-at poses instead of blending on top of them, and the bones are
 * sampled from the emote's own zero pose so no residual rotation leaks in.
 */
function buildAnimation(baked, time, { loop, name, bones, settleToRest = false }) {
    const out = {};
    // Append a rest frame so non-looping emotes return to the vanilla pose
    // instead of snapping. Emotecraft blends back to rest after `stopTick`.
    const frames = settleToRest ? [...time, Number((time[time.length - 1] + 0.25).toFixed(3))] : [...time];
    for (const [internalBone, data] of Object.entries(baked.tracks)) {
        const bedrockBone = BEDROCK_BONES[internalBone];
        if (!bedrockBone) continue;
        if (bones && !bones.includes(internalBone)) continue;

        const rotation = {};
        const position = {};
        const scale = {};
        let usesRotation = false;
        let usesPosition = false;
        let usesScale = false;

        for (let i = 0; i < frames.length; i++) {
            const key = String(frames[i]);
            const last = i >= time.length;
            const r = last ? [0, 0, 0] : data.rotation[i];
            const p = last ? [0, 0, 0] : data.position[i];
            const s = last ? [1, 1, 1] : data.scale[i];
            rotation[key] = r;
            position[key] = p;
            scale[key] = s;
            if (r.some(v => Math.abs(v) > 1e-4)) usesRotation = true;
            if (p.some(v => Math.abs(v) > 1e-5)) usesPosition = true;
            if (s.some(v => Math.abs(v - 1) > 1e-4)) usesScale = true;
        }

        const entry = {};
        // Rotation is always written: it resets the bone that vanilla walk/look
        // animations may have left rotated.
        entry.rotation = rotation;
        entry.position = position;
        if (usesPosition) entry.position = position;
        if (usesScale) entry.scale = scale;
        out[bedrockBone] = entry;
    }

    const length = Math.max(frames[frames.length - 1] || 0.05, 0.05);
    return {
        format_version: '1.8.0',
        animations: {
            [name]: {
                loop,
                animation_length: Number(length.toFixed(4)),
                override_previous_animation: true,
                bones: out,
            },
        },
    };
}

/** Re-times a slice of a baked emote starting at `startSec`. */
function sliceBaked(baked, startSec) {
    const keep = [];
    baked.time.forEach((t, i) => {
        if (t >= startSec - 1e-6) keep.push(i);
    });
    if (!keep.length) keep.push(baked.time.length - 1);

    const tracks = {};
    for (const [bone, data] of Object.entries(baked.tracks)) {
        tracks[bone] = {
            rotation: keep.map(i => data.rotation[i]),
            position: keep.map(i => data.position[i]),
            scale: keep.map(i => data.scale[i]),
        };
    }
    const offset = baked.time[keep[0]];
    const time = keep.map(i => Number((baked.time[i] - offset).toFixed(3)));
    return { tracks, time };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function findPython() {
    const candidates = [
        process.env.EMOTECRAFT_PYTHON,
        path.resolve(ROOT, '..', '.venv', 'bin', 'python'),
        '/tmp/venv/bin/python',
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            execFileSync(candidate, ['-c', 'import soundfile'], { stdio: 'ignore' });
            return candidate;
        } catch {
            /* keep looking */
        }
    }
    return null;
}

const TRANSCODE_SCRIPT = `
import sys, numpy as np, soundfile as sf
src, dst = sys.argv[1], sys.argv[2]
data, rate = sf.read(src, always_2d=True)
peak = float(np.max(np.abs(data))) if data.size else 0.0
if peak > 0:
    data = data * min(1.0, 0.89 / peak)
if rate not in (44100, 48000):
    n = int(round(data.shape[0] * 44100 / rate))
    idx = np.linspace(0, max(data.shape[0] - 1, 0), n)
    data = np.stack([np.interp(idx, np.arange(data.shape[0]), data[:, c]) for c in range(data.shape[1])], axis=1)
    rate = 44100
sf.write(dst, data.astype(np.float32), rate, format='OGG', subtype='VORBIS')
`;

function transcodeAudio(bytes, emoteId, python) {
    if (!bytes) return false;

    const target = path.join(OUT_SND, `${emoteId}.ogg`);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return true;
    if (!python) return false;

    const temp = path.join(OUT_SND, `${emoteId}.opus`);
    fs.writeFileSync(temp, bytes);
    try {
        execFileSync(python, ['-c', TRANSCODE_SCRIPT, temp, target], { stdio: 'pipe' });
        return true;
    } catch (error) {
        console.warn(`  ! could not transcode ${emoteId}.opus: ${String(error.stderr || error).slice(0, 160)}`);
        return false;
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

/**
 * Converts a single emote and registers it in the catalogue.
 *
 * @param {object} job
 * @param {string} job.id            catalogue id
 * @param {object} job.raw           parsed emote JSON
 * @param {boolean} [job.custom]     true for user supplied emotes in custom/
 * @param {function} job.readBinary  (name) => Buffer|undefined for icon/audio lookup
 * @param {boolean} [job.hasAudio]
 * @param {Buffer} [job.audioBytes]
 * @param {boolean} [job.audioIsVorbis] audio is already Vorbis, no transcode
 */
function convertOne(job) {
    const { id, raw, custom } = job;

    let emote;
    try {
        emote = readEmote(raw, id);
    } catch (error) {
        console.warn(`  ! skipping ${id}: ${error.message}`);
        return;
    }

    const baked = bakeEmote(emote, { fps: FPS });
    if (!Object.keys(baked.tracks).length) {
        console.warn(`  ! skipping ${id}: no animatable bones`);
        return;
    }

    const animationName = `animation.emotecraft.${id}`;
    fs.writeFileSync(
        path.join(OUT_ANIM, `${id}.animation.json`),
        stringify(buildAnimation(baked, baked.time, { loop: false, name: animationName, settleToRest: true })),
    );

    let loopAnimation = null;
    if (emote.loop) {
        const startSec = (emote.returnTick ?? emote.beginTick ?? 0) / 20;
        const sliced = sliceBaked(baked, startSec);
        loopAnimation = `${animationName}.loop`;
        fs.writeFileSync(
            path.join(OUT_ANIM, `${id}.loop.animation.json`),
            stringify(
                buildAnimation({ tracks: sliced.tracks }, sliced.time, { loop: true, name: loopAnimation }),
            ),
        );
    }

    const iconBytes = job.readBinary(`assets/emotecraft/emotes/${id}.png`);
    const hasIcon = Boolean(iconBytes);
    if (hasIcon) fs.writeFileSync(path.join(OUT_TEX, `${id}.png`), iconBytes);

    let hasSound = false;
    if (job.hasAudio) {
        if (job.audioIsVorbis) {
            fs.writeFileSync(path.join(OUT_SND, `${id}.ogg`), job.audioBytes);
            hasSound = true;
        } else {
            hasSound = transcodeAudio(job.audioBytes, id, PYTHON);
            if (hasSound) soundDefinitions[`emotecraft.${id}`] = soundEntry(id);
        }
    }

    const displayName = LANG[`emotecraft.emote.${id}.name`] || emote.name || id;
    const description = LANG[`emotecraft.emote.${id}.description`] || emote.description || "";

    EMOTES.push({
        id,
        animation: animationName,
        loopAnimation,
        name: displayName,
        description,
        author: emote.author || "",
        loop: emote.loop,
        duration: baked.duration,
        begin: baked.begin,
        loopStart: Number(((emote.returnTick ?? 0) / 20).toFixed(3)),
        stop: baked.stop,
        icon: hasIcon ? `textures/emotecraft/emote/${id}` : null,
        sound: hasSound ? `emotecraft.${id}` : null,
        schema: emote.schema,
        bones: Object.keys(baked.tracks).length,
        custom: Boolean(custom),
    });

    console.log(
        `  + ${id.padEnd(20)} ${String(baked.duration).padStart(6)}s loop=${String(emote.loop).padEnd(5)} ` +
            `bones=${String(Object.keys(baked.tracks).length).padEnd(2)} ${hasSound ? "audio" : "     "} ` +
            `${custom ? "custom" : emote.schema}`,
    );
}

function soundEntry(id) {
    return {
        category: "player",
        sounds: [{ name: `sounds/emotecraft/${id}`, stream: true, volume: 1.0, load_on_low_memory: true }],
    };
}

function normaliseId(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48) || "emote";
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let EMOTES = [];
let soundDefinitions = {};
let LANG = {};
let PYTHON = null;

function main() {
    EMOTES = [];
    soundDefinitions = {};
    let jarPath = DEFAULT_EMOTE_JAR;
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '--jar') jarPath = path.resolve(process.argv[++i]);
    }
    if (!fs.existsSync(jarPath)) {
        throw new Error(`Emote JAR not found: ${jarPath}\nUse --jar <path> to point at the Emotecraft jar.`);
    }

    const zip = readZip(jarPath);
    PYTHON = findPython();
    if (!PYTHON) console.warn('! python/soundfile unavailable - keeping any existing .ogg files');

    const langRaw = zip.get('assets/emotecraft/lang/en_US.json');
    LANG = langRaw ? JSON.parse(langRaw.data.toString('utf8')) : {};

    for (const dir of [OUT_ANIM, OUT_TEX, OUT_SND, OUT_DATA]) fs.mkdirSync(dir, { recursive: true });

    // --- emotes shipped inside the Java mod ------------------------------
    const emoteFiles = [...zip.keys()]
        .filter(n => n.startsWith('assets/emotecraft/emotes/') && n.endsWith('.json'))
        .sort();

    for (const entry of emoteFiles) {
        const id = path.basename(entry, '.json');
        const raw = JSON.parse(zip.get(entry).data.toString('utf8').replace(/^\uFEFF/, ''));
        const zipped = name => (zip.has(name) ? zip.get(name).data : undefined);
        convertOne({
            id,
            raw,
            readBinary: zipped,
            hasAudio: zip.has(`assets/emotecraft/emotes/${id}.opus`),
            audioBytes: zip.get(`assets/emotecraft/emotes/${id}.opus`)?.data,
        });
    }

    // --- user supplied emotes (bedrock/custom/*.json) ---------------------
    if (fs.existsSync(CUSTOM_DIR)) {
        const customFiles = fs
            .readdirSync(CUSTOM_DIR)
            .filter(f => f.toLowerCase().endsWith('.json'))
            .sort();
        for (const file of customFiles) {
            const id = normaliseId(path.basename(file, path.extname(file)));
            const full = path.join(CUSTOM_DIR, file);
            try {
                const raw = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
                const iconPath = path.join(CUSTOM_DIR, path.basename(file, path.extname(file)) + '.png');
                const audioPath = path.join(CUSTOM_DIR, path.basename(file, path.extname(file)) + '.ogg');
                convertOne({
                    id,
                    raw,
                    custom: true,
                    readBinary: name => {
                        if (name.endsWith('.png') && fs.existsSync(iconPath)) return fs.readFileSync(iconPath);
                        if (name.endsWith('.ogg') && fs.existsSync(audioPath)) return fs.readFileSync(audioPath);
                        return undefined;
                    },
                    hasAudio: fs.existsSync(audioPath),
                    audioBytes: fs.existsSync(audioPath) ? fs.readFileSync(audioPath) : undefined,
                    audioIsVorbis: true,
                });
            } catch (error) {
                console.warn(`  ! custom/${file}: ${error.message}`);
            }
        }
    }

    fs.writeFileSync(
        path.join(RP, 'sounds', 'sound_definitions.json'),
        JSON.stringify({ format_version: '1.14.0', sound_definitions: soundDefinitions }, null, 2) + '\n',
    );

    fs.writeFileSync(
        path.join(OUT_DATA, 'emotes.js'),
        `// Generated by tools/convert.js - do not edit by hand.\nexport const EMOTES = ${JSON.stringify(EMOTES, null, 4)};\n`,
    );

    const texts = path.join(RP, 'texts');
    fs.mkdirSync(texts, { recursive: true });
    fs.writeFileSync(path.join(texts, 'languages.json'), JSON.stringify(['en_US'], null, 2) + '\n');
    const lines = ['pack.name=Emotecraft for Bedrock', 'pack.description=Emotecraft emotes for Bedrock Edition.', ''];
    for (const emote of EMOTES) {
        lines.push(`emote.${emote.id}=${emote.name}`);
        if (emote.description) lines.push(`emote.${emote.id}.desc=${emote.description}`);
    }
    fs.writeFileSync(path.join(texts, 'en_US.lang'), lines.join('\n') + '\n');

    console.log(`\n${EMOTES.length} emotes -> ${path.relative(process.cwd(), OUT_ANIM)} (${FPS} fps)`);
    console.log(`${Object.keys(soundDefinitions).length} sound events`);
}

function stringify(value) {
    return JSON.stringify(value, null, 2) + '\n';
}

main();
