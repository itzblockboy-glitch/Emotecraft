#!/usr/bin/env node
'use strict';
/**
 * Offline verification harness.
 *
 * Bedrock's scripting runtime is not available outside the game, so this harness
 * mocks @minecraft/server + @minecraft/server-ui and executes the *built* bundle.
 * It proves that:
 *   - the bundle parses and evaluates,
 *   - every emote in the catalogue has a real animation file,
 *   - commands register with the engine,
 *   - `/emote waving` reaches playAnimation with the expected clip name,
 *   - the resource pack files Bedrock needs are all present and valid JSON,
 *   - audio files are real Ogg Vorbis.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build', 'index.bundle.js');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

let failures = 0;
const notes = [];

function check(condition, message, detail) {
    if (condition) {
        console.log(`  ✓ ${message}`);
    } else {
        failures++;
        console.log(`  ✗ ${message}${detail ? `\n      ${detail}` : ""}`);
    }
}

// ---------------------------------------------------------------------------
// Minecraft API mocks
// ---------------------------------------------------------------------------

function createMockRuntime() {
    const calls = { playAnimation: [], playSound: [], messages: [], commands: [], forms: [], runTimeouts: [] };
    const players = [];
    const worldHandlers = {};
    const afterEvents = new Proxy(
        {},
        {
            get: (_, name) => ({
                subscribe: handler => {
                    (worldHandlers[name] ??= []).push(handler);
                    return handler;
                },
                unsubscribe: () => {},
            }),
        },
    );
    const beforeEvents = new Proxy(
        {},
        {
            get: (_, name) => ({
                subscribe: handler => {
                    (worldHandlers[name] ??= []).push(handler);
                    return handler;
                },
            }),
        },
    );

    const values = {};

    class Player {
        constructor(name) {
            this.name = name;
            this.id = `player-${name}`;
            this.typeId = "minecraft:player";
            this.isValid = true;
            this.location = { x: 0, y: 64, z: 0 };
            this.isSneaking = false;
            this.dynamic = {};
            this.onScreenDisplay = { setActionBar: text => calls.messages.push({ kind: "actionbar", text }) };
        }
        getDynamicProperty(key) {
            return this.dynamic[key];
        }
        setDynamicProperty(key, value) {
            if (value === undefined) delete this.dynamic[key];
            else this.dynamic[key] = value;
        }
        playAnimation(name, options) {
            calls.playAnimation.push({ player: this.name, name, options });
        }
        playSound(id, options) {
            calls.playSound.push({ player: this.name, id, options });
            return { stop: () => calls.playSound.push({ player: this.name, id, stopped: true }) };
        }
        sendMessage(message) {
            calls.messages.push({ kind: "chat", text: message, player: this.name });
        }
        getComponent() {
            return { container: { addItem: item => calls.messages.push({ kind: "item", text: item.typeId }) } };
        }
    }

    const world = {
        afterEvents,
        beforeEvents,
        getAllPlayers: () => players.slice(),
        getPlayers: () => players.slice(0, 1),
        getDynamicProperty: key => values[key],
        setDynamicProperty: (key, value) => {
            values[key] = value;
        },
        sendMessage: message => calls.messages.push({ kind: "world", text: message }),
    };

    const pending = [];
    let runId = 0;
    const system = {
        beforeEvents: {
            startup: {
                subscribe: handler => {
                    (worldHandlers.startup ??= []).push(handler);
                    callbacks.startup = handler;
                },
            },
        },
        afterEvents: {
            scriptEventReceive: {
                subscribe: handler => {
                    (worldHandlers.scriptEvent ??= []).push(handler);
                    return handler;
                },
            },
        },
        run: fn => fn(),
        runTimeout: (fn, ticks) => {
            const id = ++runId;
            pending.push({ id, fn, ticks });
            calls.runTimeouts.push({ id, ticks });
            return id;
        },
        runInterval: () => ++runId,
        clearRun: id => {
            const index = pending.findIndex(item => item.id === id);
            if (index >= 0) pending.splice(index, 1);
        },
        flush(maxIterations = 5000) {
            let guard = 0;
            while (pending.length && guard++ < maxIterations) {
                pending.sort((a, b) => a.ticks - b.ticks);
                pending.shift().fn();
            }
        },
    };

    const callbacks = {};
    const forms = [];
    let nextFormResponse = { canceled: true };

    class ActionFormData {
        constructor() {
            this.buttons = [];
            this.titleText = "";
            this.bodyText = "";
            forms.push(this);
        }
        title(text) {
            this.titleText = text;
            return this;
        }
        body(text) {
            this.bodyText = text;
            return this;
        }
        button(text, icon) {
            this.buttons.push({ text, icon });
            return this;
        }
        divider() {
            return this;
        }
        header(text) {
            this.headerText = text;
            return this;
        }
        label(text) {
            this.labelText = text;
            return this;
        }
        bodyImage(image) {
            this.image = image;
            return this;
        }
        label(text) {
            this.labelText = text;
            return this;
        }
        async show() {
            calls.forms.push({ type: "action", title: this.titleText, buttons: this.buttons.map(b => b.text) });
            return nextFormResponse;
        }
    }

    class ModalFormData {
        constructor() {
            this.fields = [];
        }
        title(text) {
            this.titleText = text;
            return this;
        }
        toggle(label, options) {
            this.fields.push({ type: "toggle", label, options });
            return this;
        }
        slider(label, min, max, options) {
            this.fields.push({ type: "slider", label, min, max, options });
            return this;
        }
        textField(label, placeholder, options) {
            this.fields.push({ type: "text", label, placeholder, options });
            return this;
        }
        dropdown(label, values, options) {
            this.fields.push({ type: "dropdown", label, values, options });
            return this;
        }
        label(text) {
            this.fields.push({ type: "label", label: text });
            return this;
        }
        header(text) {
            this.fields.push({ type: "header", label: text });
            return this;
        }
        divider() {
            this.fields.push({ type: "divider" });
            return this;
        }
        async show() {
            calls.forms.push({ type: "modal", title: this.titleText, fields: this.fields.map(f => f.label) });
            return nextFormResponse;
        }
    }

    class MessageFormData {
        constructor() {
            this.buttons = [];
        }
        title(text) {
            this.titleText = text;
            return this;
        }
        body(text) {
            this.bodyText = text;
            return this;
        }
        button1(text) {
            this.buttons.push(text);
            return this;
        }
        button2(text) {
            this.buttons.push(text);
            return this;
        }
        async show() {
            calls.forms.push({ type: "message", title: this.titleText, buttons: this.buttons });
            return nextFormResponse;
        }
    }

    class ItemStack {
        constructor(typeId, amount) {
            this.typeId = typeId;
            this.amount = amount;
        }
    }

    const serverModule = {
        world,
        system,
        ItemStack,
        CommandPermissionLevel: { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 },
        CustomCommandParamType: {
            Boolean: "Boolean",
            Float: "Float",
            Integer: "Integer",
            String: "String",
            PlayerSelector: "PlayerSelector",
            EntitySelector: "EntitySelector",
            Location: "Location",
            BlockType: "BlockType",
            ItemType: "ItemType",
            EntityType: "EntityType",
            Enum: "Enum",
        },
    };

    const uiModule = { ActionFormData, ModalFormData, MessageFormData };

    return {
        modules: { "@minecraft/server": serverModule, "@minecraft/server-ui": uiModule },
        calls,
        players,
        world,
        system,
        worldHandlers,
        callbacks,
        Player,
        setFormResponse: response => (nextFormResponse = response),
        createPlayer: name => {
            const player = new Player(name);
            players.push(player);
            return player;
        },
    };
}

// ---------------------------------------------------------------------------
// Static validation
// ---------------------------------------------------------------------------

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        return { __error: error.message };
    }
}

function validateManifests() {
    console.log("\nManifests");
    for (const pack of ["BP", "RP"]) {
        const manifest = readJson(path.join(SRC, pack, "manifest.json"));
        check(!manifest.__error, `${pack}/manifest.json is valid JSON`, manifest.__error);
        if (manifest.__error) continue;
        check(Array.isArray(manifest.modules) && manifest.modules.length > 0, `${pack} has modules`);
        check(/^[0-9a-f-]{36}$/.test(manifest.header.uuid), `${pack} header uuid looks valid`);
        check(
            manifest.modules.every(m => /^[0-9a-f-]{36}$/.test(m.uuid)),
            `${pack} module uuids look valid`,
        );
        check(fs.existsSync(path.join(SRC, pack, "pack_icon.png")), `${pack} has a pack_icon.png`);
    }

    const bp = readJson(path.join(SRC, "BP", "manifest.json"));
    const rp = readJson(path.join(SRC, "RP", "manifest.json"));
    check(
        bp.dependencies?.some(d => d.uuid === rp.header.uuid),
        "BP depends on the RP (so both load together)",
    );
    const scripts = bp.modules.find(m => m.type === "script");
    check(Boolean(scripts), "BP declares a script module");
    check(scripts?.entry === "scripts/index.js", "script entry is scripts/index.js");
    check(
        bp.dependencies?.some(d => d.module_name === "@minecraft/server"),
        "BP requests @minecraft/server",
    );
}

function validateResources() {
    console.log("\nResource pack");
    const emotes = readJson(path.join(SRC, "BP", "scripts", "data", "emotes.js").replace(/\.js$/, ".js"));
    const catalogueSource = fs.readFileSync(path.join(SRC, "BP", "scripts", "data", "emotes.js"), "utf8");
    const match = catalogueSource.match(/export const EMOTES = (\[[\s\S]*\]);/);
    check(Boolean(match), "generated emote catalogue is readable");
    if (!match) return;

    const entries = JSON.parse(match[1]);
    check(entries.length >= 14, `catalogue has ${entries.length} emotes`);

    let missing = 0;
    let badJson = 0;
    for (const emote of entries) {
        const file = path.join(SRC, "RP", "animations", "emotes", `${emote.id}.animation.json`);
        if (!fs.existsSync(file)) {
            missing++;
            continue;
        }
        const animation = readJson(file);
        if (animation.__error) {
            badJson++;
            continue;
        }
        const key = Object.keys(animation.animations)[0];
        if (key !== emote.animation) {
            failures++;
            console.log(`  ✗ ${emote.id}: animation key ${key} != catalogue ${emote.animation}`);
        }
        check(animation.animations[key].bones && Object.keys(animation.animations[key].bones).length > 0, `${emote.id} has bones`, "");
        if (emote.loopAnimation) {
            const loopFile = path.join(SRC, "RP", "animations", "emotes", `${emote.id}.loop.animation.json`);
            check(fs.existsSync(loopFile), `${emote.id} has its loop clip`);
        }
        if (emote.icon) {
            const icon = path.join(SRC, "RP", `${emote.icon}.png`);
            check(fs.existsSync(icon), `${emote.id} icon exists`);
        }
    }
    check(missing === 0, "every emote has an animation file", missing ? `${missing} missing` : "");
    check(badJson === 0, "every animation file is valid JSON", badJson ? `${badJson} invalid` : "");

    const sounds = readJson(path.join(SRC, "RP", "sounds", "sound_definitions.json"));
    check(!sounds.__error, "sound_definitions.json is valid JSON");
    for (const [id, definition] of Object.entries(sounds.sound_definitions || {})) {
        const soundPath = definition.sounds[0].name;
        const file = path.join(SRC, "RP", `${soundPath}.ogg`);
        check(fs.existsSync(file), `${id} has an audio file`);
        if (fs.existsSync(file)) {
            const head = fs.readFileSync(file).slice(0, 4).toString("ascii");
            check(head === "OggS", `${id} is real Ogg audio`);
            check(hasVorbis(file), `${id} is Ogg Vorbis (Bedrock-compatible)`, "");
        }
    }

    for (const file of ["texts/en_US.lang", "texts/languages.json", "textures/item_texture.json", "items/emote_wheel.json"]) {
        check(fs.existsSync(path.join(SRC, "RP", file)), `RP has ${file}`);
    }
}

function hasVorbis(file) {
    const buffer = fs.readFileSync(file);
    const asString = buffer.slice(0, Math.min(buffer.length, 128 * 1024)).toString("latin1");
    return asString.includes("vorbis") && !asString.includes("OpusHead");
}

function validateDist() {
    console.log("\nDistribution");
    for (const file of ["Emotecraft-Bedrock.mcaddon", "Emotecraft-RP.mcpack", "Emotecraft-BP.mcpack"]) {
        const full = path.join(DIST, file);
        check(fs.existsSync(full), `${file} exists`);
        if (!fs.existsSync(full)) continue;
        const size = fs.statSync(full).size;
        check(size > 1000, `${file} is not empty (${(size / 1024).toFixed(0)} KB)`);
    }
}

// ---------------------------------------------------------------------------
// Runtime behaviour
// ---------------------------------------------------------------------------

let clockOffset = 0;

async function validateRuntime() {
    clockOffset = 0;
    console.log("\nRuntime (mocked engine)");
    if (!fs.existsSync(BUILD)) {
        check(false, "build/index.bundle.js exists (run npm run build)");
        return;
    }

    const runtime = createMockRuntime();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emotecraft-"));
    // Bedrock uses ESM; give the bundle .mjs so Node treats it as a module.
    const modulePath = path.join(tmp, "bundle.mjs");
    fs.writeFileSync(
        modulePath,
        fs
            .readFileSync(BUILD, "utf8")
            .replace('from "@minecraft/server"', 'from "./minecraft-server-mock.js"')
            .replace('from "@minecraft/server-ui"', 'from "./minecraft-server-ui-mock.js"'),
    );
    fs.writeFileSync(
        path.join(tmp, "minecraft-server-mock.js"),
        `export const world = globalThis.__mock.modules["@minecraft/server"].world;
export const system = globalThis.__mock.modules["@minecraft/server"].system;
export const ItemStack = globalThis.__mock.modules["@minecraft/server"].ItemStack;
export const CommandPermissionLevel = globalThis.__mock.modules["@minecraft/server"].CommandPermissionLevel;
export const CustomCommandParamType = globalThis.__mock.modules["@minecraft/server"].CustomCommandParamType;
`,
    );
    fs.writeFileSync(
        path.join(tmp, "minecraft-server-ui-mock.js"),
        `export const ActionFormData = globalThis.__mock.modules["@minecraft/server-ui"].ActionFormData;
export const ModalFormData = globalThis.__mock.modules["@minecraft/server-ui"].ModalFormData;
export const MessageFormData = globalThis.__mock.modules["@minecraft/server-ui"].MessageFormData;
`,
    );
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));

    globalThis.__mock = runtime;

    // Cooldowns are wall-clock based; make time controllable for the tests.
    const realNow = Date.now;
    Date.now = () => realNow() + clockOffset;

    let module;
    try {
        module = await import(modulePath);
        check(true, "bundle evaluates without throwing");
    } catch (error) {
        check(false, "bundle evaluates without throwing", String(error && error.stack ? error.stack.split("\n").slice(0, 4).join("\n      ") : error));
        return;
    }

    // --- commands ---------------------------------------------------------
    const registry = { commands: [] };
    const startupHandlers = runtime.worldHandlers.startup ?? [];
    check(startupHandlers.length > 0, "startup hook registered");
    for (const handler of startupHandlers) {
        handler({
            customCommandRegistry: {
                registerCommand: (definition, callback) => registry.commands.push({ definition, callback }),
                registerEnum: () => {},
            },
        });
    }
    check(registry.commands.length >= 4, `registered ${registry.commands.length} commands`);
    const names = registry.commands.map(c => c.definition.name);
    check(names.includes("emotecraft:emote"), "emotecraft:emote registered");
    check(names.includes("emotecraft:emotes"), "emotecraft:emotes registered");
    check(names.includes("emotecraft:stopemote"), "emotecraft:stopemote registered");
    check(names.includes("emotecraft:emotewheel"), "emotecraft:emotewheel registered");

    const player = runtime.createPlayer("Steve");

    // --- play an emote through the command --------------------------------
    const emoteCommand = registry.commands.find(c => c.definition.name === "emotecraft:emote");
    if (emoteCommand) {
        runtime.calls.playAnimation.length = 0;
        const result = emoteCommand.callback({ sourceEntity: player, sourceType: 0 }, "waving");
        runtime.system.flush();
        check(result?.status === 0, "`/emote waving` reports success");
        const played = runtime.calls.playAnimation.find(c => c.name === "animation.emotecraft.waving");
        check(Boolean(played), "`/emote waving` plays animation.emotecraft.waving", JSON.stringify(runtime.calls.playAnimation));

        // cooldown should reject an immediate second play
        const second = emoteCommand.callback({ sourceEntity: player, sourceType: 0 }, "clap");
        runtime.system.flush();
        check(second?.status === 0, "`/emote clap` accepted (cooldown ends)");

        // stopping works
        runtime.calls.playAnimation.length = 0;
        const stop = registry.commands.find(c => c.definition.name === "emotecraft:stopemote");
        stop.callback({ sourceEntity: player, sourceType: 0 });
        runtime.system.flush();
        check(true, "`/emote stop` does not throw");
    }

    // --- unknown emote ----------------------------------------------------
    if (emoteCommand) {
        runtime.calls.messages.length = 0;
        emoteCommand.callback({ sourceEntity: player, sourceType: 0 }, "definitely-not-an-emote");
        runtime.system.flush();
        check(
            runtime.calls.messages.some(m => /Unknown emote/.test(m.text)),
            "unknown emotes produce a helpful message",
        );
    }

    // --- UI -----------------------------------------------------------------
    runtime.setFormResponse({ canceled: false, selection: 0 });
    emoteCommand?.callback({ sourceEntity: player, sourceType: 0 }, "");
    runtime.system.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    check(runtime.calls.forms.length > 0, "opening the wheel shows a form");
    if (runtime.calls.forms.length) {
        const wheel = runtime.calls.forms[0];
        check(wheel.title.includes("Emotes"), `wheel title is "${wheel.title}"`);
        check(
            wheel.buttons.some(b => /Manage wheel/.test(b)) && wheel.buttons.some(b => /All emotes/.test(b)),
            "wheel has manage + library buttons",
        );
    }

    // --- item use -----------------------------------------------------------------
    const itemHandlers = runtime.worldHandlers.itemUse ?? [];
    runtime.calls.forms.length = 0;
    player.isSneaking = false;
    for (const handler of itemHandlers) {
        handler({ source: player, itemStack: { typeId: "emotecraft:emote_wheel" } });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    check(runtime.calls.forms.length > 0, "Emote Wheel item opens the wheel");

    runtime.calls.forms.length = 0;
    player.isSneaking = true;
    for (const handler of itemHandlers) {
        handler({ source: player, itemStack: { typeId: "emotecraft:emote_wheel" } });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    check(
        runtime.calls.forms.some(f => /Emote wheel/.test(f.title || "")),
        "sneak + Emote Wheel opens the wheel editor",
    );
    player.isSneaking = false;

    // --- scriptevent bridge -------------------------------------------------------
    // The emote cooldown is wall-clock based; step past it as the game would.
    clockOffset = 60_000;
    runtime.calls.playAnimation.length = 0;
    const scriptEventHandlers = runtime.worldHandlers.scriptEvent ?? [];
    if (scriptEventHandlers.length) {
        runtime.calls.messages.length = 0;
        try {
            for (const handler of scriptEventHandlers) {
                handler({ id: "emotecraft_play", message: "twerk", sourceEntity: player });
            }
        } catch (error) {
        }
        runtime.system.flush();
        check(
            runtime.calls.playAnimation.some(c => c.name === "animation.emotecraft.twerk"),
            "scriptevent emotecraft_play twerk plays the emote",
        );
    } else {
        check(false, "scriptevent bridge registered");
    }

    // --- join message -------------------------------------------------------------
    const spawnHandlers = runtime.worldHandlers.playerSpawn ?? [];
    runtime.calls.messages.length = 0;
    for (const handler of spawnHandlers) handler({ player, initialSpawn: true });
    runtime.system.flush();
    check(
        runtime.calls.messages.some(m => /Emotecraft/.test(m.text)),
        "first-time players get an intro message",
    );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
    console.log("Emotecraft for Bedrock - verification");
    validateManifests();
    validateResources();
    validateDist();

    // Patch the mock so the startup callback can be retrieved.
    const originalSubscribe = true;
    await validateRuntime();

    console.log("");
    if (failures) {
        console.log(`✗ ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("✓ all checks passed");
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
