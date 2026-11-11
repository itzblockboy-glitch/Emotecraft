'use strict';
/**
 * Emotecraft emote reader + baker.
 *
 * Reads Emotecraft `.json` emotes and bakes them into flat, runtime-friendly
 * tracks that the Bedrock pack plays back with `player.playAnimation()`.
 *
 * Two source schemas are supported:
 *   1. "legacy"  - `{ emote: { moves: [...] } }` with *absolute* model-part
 *                  positions in pixels (schema 1/2/3, what most community
 *                  emotes use).
 *   2. "PAL"     - `{ animations: { id: { bones: {...} } } }`, the Blender /
 *                  PlayerAnimationLibrary export Emotecraft 3.x ships its own
 *                  emotes in. Rotations are degrees, positions are *offsets*.
 *
 * Coordinate convention
 * ---------------------
 * Emotecraft stores poses in Minecraft model-part space, which is the same
 * right-handed space Bedrock uses:
 *   rotation = (pitch, yaw, roll) -> Bedrock (x, y, z) in degrees
 *   position = pixels / 16        -> Bedrock blocks (16 px per block)
 * Emotecraft's own Geyser bridge forwards the axes unchanged, which is what
 * confirms this is 1:1.
 */

const PX_PER_BLOCK = 16;
const TICKS_PER_SECOND = 20;

/**
 * Java player model rest pose, in pixels. Emotecraft emotes that store absolute
 * positions use exactly these pivots (see `waving.json`, `twerk.json`, ...).
 */
const REST_POSE = {
    body:      { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    torso:     { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    head:      { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    rightArm:  { x: -5,   y: 2,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    leftArm:   { x: 5,    y: 2,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    rightLeg:  { x: -1.9, y: 12, z: 0.1, pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    leftLeg:   { x: 1.9,  y: 12, z: 0.1, pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    leftItem:  { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    rightItem: { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    cape:      { x: 0,    y: 0,  z: 0,   pitch: 0, yaw: 0, roll: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
};

/** Emotecraft/legacy part name -> internal bone name. */
const PART_ALIASES = {
    body: 'body',
    torso: 'torso',
    head: 'head',
    leftarm: 'leftArm',
    left_arm: 'leftArm',
    rightarm: 'rightArm',
    right_arm: 'rightArm',
    leftleg: 'leftLeg',
    left_leg: 'leftLeg',
    rightleg: 'rightLeg',
    right_leg: 'rightLeg',
    leftitem: 'leftItem',
    left_item: 'leftItem',
    rightitem: 'rightItem',
    right_item: 'rightItem',
    cape: 'cape',
};

/**
 * PlayerAnimationLibrary rig -> internal bones.
 *
 * PAL's player rig adds two helper bones on top of the vanilla skeleton:
 *   body_control (root, pivot y=12) -> waist (pivot y=12) -> torso/head/arms
 *                                   -> left_leg/right_leg
 * `body` in PAL is the chest cube (pivot y=24). Both helper bones are folded
 * onto the internal `body` bone (which maps to Bedrock's `waist`), while PAL
 * `torso`/`body` fold onto the internal `torso` (Bedrock's chest bone `body`).
 */
const PAL_BONE_MAP = {
    body_control: 'body',
    waist: 'body',
    body: 'torso',
    torso: 'torso',
    head: 'head',
    left_arm: 'leftArm',
    right_arm: 'rightArm',
    left_leg: 'leftLeg',
    right_leg: 'rightLeg',
    cape: 'cape',
    left_item: 'leftItem',
    right_item: 'rightItem',
};

/** Internal bone -> Bedrock humanoid bone used in the generated animations. */
const BEDROCK_BONES = {
    body: 'waist',
    torso: 'body',
    head: 'head',
    rightArm: 'rightArm',
    leftArm: 'leftArm',
    rightLeg: 'rightLeg',
    leftLeg: 'leftLeg',
    cape: 'cape',
};

const SAMPLE_BONES = ['body', 'torso', 'head', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg', 'cape'];
const CHANNELS = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'bend', 'scaleX', 'scaleY', 'scaleZ'];
const POSITION_CHANNELS = ['x', 'y', 'z'];
const ROTATION_CHANNELS = ['pitch', 'yaw', 'roll'];
const SCALE_CHANNELS = ['scaleX', 'scaleY', 'scaleZ'];

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

const EASE_FNS = {
    linear: t => t,
    constant: () => 0,
    insine: t => 1 - Math.cos((t * Math.PI) / 2),
    outsine: t => Math.sin((t * Math.PI) / 2),
    inoutsine: t => -(Math.cos(Math.PI * t) - 1) / 2,
    inquad: t => t * t,
    outquad: t => 1 - (1 - t) * (1 - t),
    inoutquad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    incubic: t => t * t * t,
    outcubic: t => 1 - Math.pow(1 - t, 3),
    inoutcubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    inquart: t => t ** 4,
    outquart: t => 1 - Math.pow(1 - t, 4),
    inoutquart: t => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
    inquint: t => t ** 5,
    outquint: t => 1 - Math.pow(1 - t, 5),
    inoutquint: t => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
    inexpo: t => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
    outexpo: t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inoutexpo: t =>
        t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
    incirc: t => 1 - Math.sqrt(1 - t * t),
    outcirc: t => Math.sqrt(1 - (t - 1) * (t - 1)),
    inoutcirc: t =>
        t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,
    inback: t => 2.70158 * t * t * t - 1.70158 * t * t,
    outback: t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
    inoutback: t =>
        t < 0.5
            ? ((2 * t) ** 2 * (3.5949 * 2 * t - 1.5949)) / 2
            : ((2 * t - 2) ** 2 * (3.5949 * (2 * t - 2) + 1.5949) + 2) / 2,
};

function normalizeEaseName(name) {
    return String(name || 'linear')
        .toLowerCase()
        .replace(/^ease/, '')
        .replace(/[^a-z]/g, '');
}

function ease(name, t) {
    const key = normalizeEaseName(name);
    if (EASE_FNS[key]) return EASE_FNS[key](t);
    if (!key || key === 'none' || key === 'default') return t;
    // Unknown easings (cubic bezier / catmull-rom exports) get a smooth ramp.
    return EASE_FNS.inoutsine(t);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function asNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function boolish(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0' || v === '') return false;
    }
    return fallback;
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function parseTransform(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    let any = false;
    for (const key of CHANNELS) {
        const n = asNumber(raw[key]);
        if (n !== undefined) {
            out[key] = n;
            any = true;
        }
    }
    if (typeof raw.axis === 'string' && ['x', 'y', 'z'].includes(raw.axis.toLowerCase())) {
        out.axis = raw.axis.toLowerCase();
        any = true;
    }
    return any ? out : null;
}

// ---------------------------------------------------------------------------
// Legacy schema: { emote: { moves: [...] } }
// ---------------------------------------------------------------------------

function readLegacySchema(raw, fallbackName) {
    const emote = raw.emote;
    const moves = [];

    for (const move of emote.moves) {
        if (!move || typeof move !== 'object') continue;
        const tick = Math.max(0, asNumber(move.tick) || 0);
        const parts = {};
        for (const [key, value] of Object.entries(move)) {
            if (key === 'tick' || key === 'easing' || key === 'easingArgs' || key === 'turn') continue;
            if (key === 'custom' && value && typeof value === 'object') {
                for (const [bone, transform] of Object.entries(value)) {
                    const t = parseTransform(transform);
                    if (t) parts[bone] = t;
                }
                continue;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const bone = PART_ALIASES[key.toLowerCase()] || key;
            const t = parseTransform(value);
            if (t) parts[bone] = t;
        }
        if (!Object.keys(parts).length) continue;
        moves.push({
            tick,
            easing: move.easing !== undefined ? String(move.easing) : undefined,
            turn: asNumber(move.turn) || 0,
            parts,
        });
    }
    moves.sort((a, b) => a.tick - b.tick);

    return {
        schema: 'emotecraft',
        name: localize(raw.name, fallbackName),
        description: localize(raw.description, ''),
        author: localizeAuthor(raw.author),
        uuid: typeof raw.uuid === 'string' ? raw.uuid : undefined,
        beginTick: Math.max(0, asNumber(emote.beginTick) ?? 0),
        endTick: asNumber(emote.endTick) ?? lastTick(moves),
        stopTick: asNumber(emote.stopTick),
        returnTick: asNumber(emote.returnTick) ?? 0,
        loop: boolish(emote.isLoop, false),
        degrees: boolish(emote.degrees, true),
        easeBeforeKeyframe: boolish(emote.easeBeforeKeyframe, false),
        relativePositions: false,
        moves,
    };
}

function lastTick(moves) {
    let last = 0;
    for (const move of moves) last = Math.max(last, move.tick);
    return last;
}

// ---------------------------------------------------------------------------
// PAL / PlayerAnimationLibrary schema: { animations: { id: { bones: {...} } } }
// ---------------------------------------------------------------------------

function readAnimationSchema(raw, fallbackName) {
    const animations = raw.animations;
    const keys = Object.keys(animations);
    if (!keys.length) throw new Error('Emote file contains no animations');

    const id = keys[0];
    const anim = animations[id] || {};
    const meta = anim.player_animation_library || raw.player_animation_library || {};
    const bones = anim.bones || {};

    // tick -> { parts: { bone: channels } }
    const byTick = new Map();
    const boneFor = boneName => PAL_BONE_MAP[boneName] || PART_ALIASES[boneName.toLowerCase()] || null;

    const push = (tick, bone, channels, values) => {
        if (!bone) return;
        let entry = byTick.get(tick);
        if (!entry) {
            entry = { tick, easing: 'linear', parts: {} };
            byTick.set(tick, entry);
        }
        const part = entry.parts[bone] || (entry.parts[bone] = {});
        SCALE_CHANNELS; // (documents that scales flow through the same path)
        for (let i = 0; i < channels.length; i++) {
            const v = values[i];
            if (Number.isFinite(v)) part[channels[i]] = v;
        }
        if (!entry.easingChosen) entry.easingChosen = true;
    };

    for (const [boneName, groups] of Object.entries(bones)) {
        if (!groups || typeof groups !== 'object') continue;
        const bone = boneFor(boneName);
        if (!bone) continue; // custom rig bone the Bedrock skeleton has no match for

        applyChannelGroup(groups.rotation, ROTATION_CHANNELS, (tick, values, easing) => {
            push(tick, bone, ROTATION_CHANNELS, values);
            applyEasing(byTick, tick, easing);
        });
        applyChannelGroup(groups.position, POSITION_CHANNELS, (tick, values) => {
            push(tick, bone, POSITION_CHANNELS, values);
        });
        applyChannelGroup(groups.scale, SCALE_CHANNELS, (tick, values) => {
            push(tick, bone, SCALE_CHANNELS, values);
        });
    }

    const moves = [...byTick.values()].sort((a, b) => a.tick - b.tick);
    const lengthSec = asNumber(anim.animation_length);
    const endTick = lengthSec !== undefined ? lengthSec * TICKS_PER_SECOND : lastTick(moves);
    const loopTick = asNumber(anim.loopTick);

    return {
        schema: 'pal',
        name: localize(meta.name, localize(raw.name, fallbackName || id)),
        description: localize(meta.description, ''),
        author: localizeAuthor(meta.author),
        uuid: typeof meta.uuid === 'string' ? meta.uuid : undefined,
        beginTick: 0,
        endTick,
        stopTick: endTick + 1,
        returnTick: loopTick !== undefined ? loopTick * TICKS_PER_SECOND : 0,
        loop: boolish(anim.loop, false),
        degrees: true,
        easeBeforeKeyframe: false,
        // PAL exports store bone positions as offsets from the rest pose.
        relativePositions: true,
        moves,
    };
}

function applyEasing(byTick, tick, easing) {
    const entry = byTick.get(tick);
    if (entry && easing) entry.easing = easing;
}

/**
 * Walks a GeckoLib/PAL channel (`5`, `[x,y,z]`, `{ "0.0": {...} }`) and calls
 * `emit(tick, [x,y,z], easing)` for every usable keyframe.
 */
function applyChannelGroup(channel, channels, emit) {
    if (channel === undefined || channel === null) return;

    const handle = (tick, value) => {
        if (typeof value === 'number') {
            emit(tick, [value, value, value]);
            return;
        }
        if (typeof value === 'string') return; // molang expression: unsupported at build time
        if (Array.isArray(value)) {
            const nums = value.map(v => asNumber(v));
            if (nums.every(n => n === undefined)) return;
            emit(tick, nums.map((n, i) => (n === undefined ? nums.find(x => x !== undefined) ?? 0 : n)));
            return;
        }
        if (value && typeof value === 'object') {
            const easing = value.easing;
            const raw = value.post ?? value.vector ?? value.pre;
            if (raw === undefined) return;
            if (typeof raw === 'number') {
                emit(tick, [raw, raw, raw], easing);
            } else if (Array.isArray(raw)) {
                const nums = raw.map(v => asNumber(v));
                const fallback = nums.find(n => n !== undefined) ?? 0;
                emit(tick, nums.map(n => (n === undefined ? fallback : n)), easing);
            }
        }
    };

    if (typeof channel === 'number' || Array.isArray(channel)) {
        handle(0, channel);
        return;
    }
    if (typeof channel !== 'object') return;

    // Per-axis easing is reduced to the X axis easing (Bedrock applies one
    // easing per segment; X is the dominant channel for the exported dances).
    for (const [time, value] of Object.entries(channel)) {
        const tick = Math.max(0, (asNumber(time) ?? 0) * TICKS_PER_SECOND);
        handle(tick, value);
    }
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function localize(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if (typeof value.literal === 'string') return value.literal;
        if (typeof value.text === 'string') return value.text;
        if (typeof value.translate === 'string') return humanizeKey(value.translate);
    }
    return fallback;
}

function humanizeKey(key) {
    const tail = String(key).split('.').filter(Boolean);
    const candidate = tail.length >= 2 ? tail[tail.length - 2] : tail[tail.length - 1] || key;
    return candidate.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function localizeAuthor(author) {
    if (!author) return '';
    if (typeof author === 'string') return author;
    const extra = Array.isArray(author.extra) ? author.extra.join('') : '';
    return extra.replace(/[§&][0-9a-fk-or]/gi, '').trim();
}

// ---------------------------------------------------------------------------
// Reading entry point
// ---------------------------------------------------------------------------

function readEmote(raw, fallbackName) {
    if (!raw || typeof raw !== 'object') throw new Error('Emote file is not a JSON object');
    if (raw.animations && typeof raw.animations === 'object') return readAnimationSchema(raw, fallbackName);
    if (raw.emote && Array.isArray(raw.emote.moves)) return readLegacySchema(raw, fallbackName);
    if (Array.isArray(raw.moves)) return readLegacySchema({ emote: raw }, fallbackName);
    throw new Error('Unrecognised emote format (no `emote.moves` or `animations`)');
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

function baseFor(bone, emote) {
    const rest = REST_POSE[bone] || REST_POSE.body;
    if (!emote.relativePositions) return rest;
    return { ...rest, x: 0, y: 0, z: 0 };
}

function fullValues(values, fallback) {
    const out = {};
    for (const channel of [...POSITION_CHANNELS, ...ROTATION_CHANNELS]) {
        const own = values[channel];
        out[channel] = own !== undefined ? own : fallback[channel] !== undefined ? fallback[channel] : 0;
    }
    for (const channel of SCALE_CHANNELS) {
        const own = values[channel];
        out[channel] = own !== undefined ? own : fallback[channel] !== undefined ? fallback[channel] : 1;
    }
    return out;
}

function blendBone(target, from, to, alpha, rest, turn) {
    const fromValues = fullValues(from, rest);
    const toValues = to ? fullValues(to, fromValues) : fromValues;
    const yawTurn = (turn || 0) * 360;
    for (const channel of [...POSITION_CHANNELS, ...ROTATION_CHANNELS]) {
        const a = fromValues[channel] ?? 0;
        let b = toValues[channel] ?? 0;
        if (channel === 'yaw' && yawTurn) b += yawTurn;
        target[channel] = a + (b - a) * alpha;
    }
    for (const channel of SCALE_CHANNELS) {
        const a = fromValues[channel] ?? 1;
        const b = toValues[channel] ?? 1;
        target[channel] = a + (b - a) * alpha;
    }
}

/**
 * Resolves the pose at `tick`.
 *
 * Emotecraft semantics (mirrored from its timeline):
 *  - a channel absent from a keyframe inherits the previous keyframe's value,
 *    while a channel present with 0 is an explicit zero;
 *  - a segment uses the easing of the *next* keyframe unless the emote sets
 *    `easeBeforeKeyframe`;
 *  - samples before a bone's first keyframe ease in from the rest pose.
 */
function resolvePose(track, tick, emote) {
    const pose = {};
    const beginTick = emote.beginTick || 0;
    const easeBefore = !!emote.easeBeforeKeyframe;

    for (const bone of SAMPLE_BONES) {
        const rest = baseFor(bone, emote);
        const keys = track[bone];
        if (!keys || !keys.length) {
            pose[bone] = { ...rest };
            continue;
        }

        let prev = null;
        let next = null;
        for (const key of keys) {
            if (key.tick <= tick) prev = key;
            else {
                next = key;
                break;
            }
        }

        if (!prev) {
            const span = Math.max(1e-6, next.tick - beginTick);
            const alpha = ease(next.easing, clamp01((tick - beginTick) / span));
            pose[bone] = { ...rest };
            blendBone(pose[bone], rest, next.values, alpha, rest, next.turn);
            continue;
        }

        const from = fullValues(prev.values, rest);
        if (!next) {
            pose[bone] = { ...rest };
            blendBone(pose[bone], from, null, 1, rest, prev.turn);
            continue;
        }
        const to = fullValues(next.values, from);
        const span = next.tick - prev.tick;
        const alpha = ease(easeBefore ? prev.easing : next.easing ?? prev.easing, clamp01(span <= 0 ? 1 : (tick - prev.tick) / span));
        pose[bone] = { ...rest };
        blendBone(pose[bone], from, to, alpha, rest, next.turn);
    }
    return pose;
}

function isStatic(vectors) {
    if (!vectors.length) return true;
    const first = vectors[0];
    for (const v of vectors) {
        for (let i = 0; i < first.length; i++) {
            if (Math.abs(v[i] - first[i]) > 1e-3) return false;
        }
    }
    return true;
}

/**
 * Bakes an emote at `fps` samples per second into flat tracks:
 *   { time: [...], tracks: { bone: { rotation[][], position[][], scale[][] } } }
 */
function bakeEmote(emote, options = {}) {
    const fps = options.fps || TICKS_PER_SECOND;
    const endTick = Math.max(emote.endTick || 0, lastTick(emote.moves), 1);

    const track = {};
    for (const move of emote.moves) {
        for (const [bone, values] of Object.entries(move.parts)) {
            (track[bone] = track[bone] || []).push({
                tick: move.tick,
                easing: move.easing,
                turn: move.turn,
                values,
            });
        }
    }
    for (const keys of Object.values(track)) keys.sort((a, b) => a.tick - b.tick);

    const sampleCount = Math.max(2, Math.ceil((endTick / TICKS_PER_SECOND) * fps) + 1);
    const time = [];
    const tracks = {};
    for (const bone of SAMPLE_BONES) {
        tracks[bone] = { rotation: [], position: [], scale: [] };
    }

    const rotScale = emote.degrees ? 1 : 180 / Math.PI;

    for (let i = 0; i < sampleCount; i++) {
        const tick = (i / (sampleCount - 1)) * endTick;
        time.push(Number((tick / TICKS_PER_SECOND).toFixed(4)));
        const pose = resolvePose(track, tick, emote);

        for (const bone of SAMPLE_BONES) {
            const rest = baseFor(bone, emote);
            const p = pose[bone];
            // Angles pass through untouched: Emotecraft interpolates the raw
            // values, so a spin stays a spin here too.
            tracks[bone].rotation.push([
                round(p.pitch * rotScale),
                round(p.yaw * rotScale),
                round(p.roll * rotScale),
            ]);
            tracks[bone].position.push([
                round((p.x - rest.x) / PX_PER_BLOCK, 4),
                round((p.y - rest.y) / PX_PER_BLOCK, 4),
                round((p.z - rest.z) / PX_PER_BLOCK, 4),
            ]);
            tracks[bone].scale.push([round(p.scaleX, 3), round(p.scaleY, 3), round(p.scaleZ, 3)]);
        }
    }

    // Drop bones that never move so the generated animations stay small.
    const compact = {};
    for (const [bone, data] of Object.entries(tracks)) {
        if (isStatic(data.rotation) && isStatic(data.position) && isStatic(data.scale)) continue;
        if (isStatic(data.rotation) && isStatic(data.scale) && data.position.every(p => Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) < 1e-4) && isZero(data.rotation)) {
            continue;
        }
        compact[bone] = data;
    }

    // Emit an explicit final rest frame only when the emote's last keyframe is
    // not already a rest pose (handled by the converter's settleToRest option).

    const durationSec = endTick / TICKS_PER_SECOND;
    return {
        name: emote.name,
        description: emote.description,
        author: emote.author,
        uuid: emote.uuid,
        schema: emote.schema,
        loop: emote.loop,
        duration: Number(durationSec.toFixed(4)),
        begin: Number(((emote.beginTick || 0) / TICKS_PER_SECOND).toFixed(4)),
        returnAt: Number(((emote.returnTick || 0) / TICKS_PER_SECOND).toFixed(4)),
        stop: Number(((emote.stopTick ?? endTick + 1) / TICKS_PER_SECOND).toFixed(4)),
        time: time.map(v => round(v, 3)),
        tracks: compact,
    };
}

function isZero(vectors) {
    for (const v of vectors) for (const value of v) if (Math.abs(value) > 1e-4) return false;
    return true;
}

function round(value, decimals = 3) {
    const p = 10 ** decimals;
    const r = Math.round(value * p) / p;
    return Object.is(r, -0) ? 0 : r;
}

module.exports = {
    PX_PER_BLOCK,
    TICKS_PER_SECOND,
    REST_POSE,
    PART_ALIASES,
    PAL_BONE_MAP,
    BEDROCK_BONES,
    SAMPLE_BONES,
    readEmote,
    bakeEmote,
    ease,
    localize,
};
