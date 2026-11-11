/**
 * Emotecraft for Bedrock Edition - script entry point.
 *
 * Port of the Emotecraft Java/Fabric mod:
 *   - every emote the Java mod ships is converted to Bedrock bone animations;
 *   - `/emote` plays by name and `/emote` with no arguments opens the wheel;
 *   - the Emote Wheel item (right click) opens the same wheel anywhere;
 *   - per-player options mirror the Java mod's config screen;
 *   - emote audio is streamed from the resource pack;
 *   - other players see the animation because Bedrock plays it client-side.
 */
import { world, system, ItemStack, CustomCommandParamType, CommandPermissionLevel } from "@minecraft/server";
import { catalogue } from "./core/catalogue.js";
import { EmoteManager } from "./core/emoteManager.js";
import { settingsFor, markWelcome } from "./core/settings.js";
import { openWheel, openWheelEditor, openLibrary, openConfig, openHelp, bindHelpers } from "./ui/forms.js";

export const WHEEL_ITEM = "emotecraft:emote_wheel";
const VERSION = "1.0.0";

const manager = new EmoteManager(catalogue);

bindHelpers({
    playEmote: (player, emote) => playEmote(player, emote),
    isPlaying: player => manager.isPlaying(player),
    stopEmote: player => manager.stop(player),
});

// ---------------------------------------------------------------------------
// Playing emotes
// ---------------------------------------------------------------------------

/**
 * Central play routine: handles permissions, cooldowns, announcements and the
 * on-screen toast for both the UI and the commands.
 */
export function playEmote(player, emote, options = {}) {
    const settings = settingsFor(player);
    const result = manager.play(player, emote, options);

    if (!result.ok) {
        if (result.reason === "disabled") player.sendMessage("§cEmotes are disabled. Enable them in §f/emote config§c.");
        else if (result.reason === "no-animation") player.sendMessage("§cThat emote has no animation data.");
        return result;
    }

    if (settings.get("showHud")) {
        try {
            player.onScreenDisplay.setActionBar(`§b${emote.name}§r §7— ${emote.author || "Emotecraft"}`);
        } catch {
            /* action bar unavailable */
        }
    }

    if (settings.get("broadcast") && options.announce !== false) {
        const message = `§7* §f${player.name} §7is doing §b${emote.name}§7`;
        for (const other of world.getAllPlayers()) {
            if (other.id === player.id) continue;
            if (distanceSquared(other, player) > 32 * 32) continue;
            try {
                other.sendMessage(message);
            } catch {
                /* player left */
            }
        }
    }

    return result;
}

function distanceSquared(a, b) {
    try {
        const dx = a.location.x - b.location.x;
        const dy = a.location.y - b.location.y;
        const dz = a.location.z - b.location.z;
        return dx * dx + dy * dy + dz * dz;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const registerCommands = init => {
    const registry = init.customCommandRegistry;
    const permissionLevel = CommandPermissionLevel.Any;

    registry.registerCommand(
        {
            name: "emotecraft:emote",
            description: "Play an emote, or open the emote wheel",
            permissionLevel,
            cheatsRequired: false,
            optionalParameters: [{ name: "emote", type: CustomCommandParamType.String }],
        },
        (origin, emoteArg) => handleEmoteCommand(origin, emoteArg),
    );

    registry.registerCommand(
        {
            name: "emotecraft:emotes",
            description: "Open the emote library",
            permissionLevel,
            cheatsRequired: false,
        },
        origin => {
            const player = resolvePlayer(origin);
            if (!player) return { status: 1, message: "This command can only be used by a player." };
            system.run(() => openLibrary(player));
            return { status: 0 };
        },
    );

    registry.registerCommand(
        {
            name: "emotecraft:stopemote",
            description: "Stop your current emote",
            permissionLevel,
            cheatsRequired: false,
        },
        origin => {
            const player = resolvePlayer(origin);
            if (!player) return { status: 1 };
            const stopped = manager.stop(player);
            if (stopped) player.sendMessage("§7Emote stopped.");
            return { status: 0 };
        },
    );

    registry.registerCommand(
        {
            name: "emotecraft:emotewheel",
            description: "Give yourself the Emote Wheel item",
            permissionLevel,
            cheatsRequired: true,
        },
        origin => {
            const player = resolvePlayer(origin);
            if (!player) return { status: 1 };
            system.run(() => {
                player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(WHEEL_ITEM, 1));
                player.sendMessage("§bEmote Wheel§7 added to your inventory.");
            });
            return { status: 0 };
        },
    );
};

function resolvePlayer(origin) {
    const entity = origin?.sourceEntity ?? origin?.initiator;
    if (entity && entity.typeId === "minecraft:player") return entity;
    return undefined;
}

function handleEmoteCommand(origin, emoteArg) {
    const player = resolvePlayer(origin);
    if (!player) return { status: 1, message: "Run this as a player." };

    const arg = typeof emoteArg === "string" ? emoteArg.trim() : "";

    if (!arg) {
        system.run(() => openWheel(player));
        return { status: 0 };
    }

    const lowered = arg.toLowerCase();

    if (lowered === "stop" || lowered === "cancel") {
        const stopped = manager.stop(player);
        system.run(() => player.sendMessage(stopped ? "§7Emote stopped." : "§7You are not emoting."));
        return { status: 0 };
    }
    if (lowered === "config" || lowered === "options" || lowered === "settings") {
        system.run(() => openConfig(player));
        return { status: 0 };
    }
    if (lowered === "help") {
        system.run(() => openHelp(player));
        return { status: 0 };
    }
    if (lowered === "list" || lowered === "library" || lowered === "all") {
        system.run(() => openLibrary(player));
        return { status: 0 };
    }

    const emote = catalogue.find(arg) ?? catalogue.search(arg, 1)[0];
    if (!emote) {
        system.run(() =>
            player.sendMessage(`§cUnknown emote “${arg}”.§7 Try §f/emote list§7 to browse them.`),
        );
        return { status: 1 };
    }

    system.run(() => playEmote(player, emote));
    return { status: 0 };
}

// ---------------------------------------------------------------------------
// Emote Wheel item
// ---------------------------------------------------------------------------

/**
 * Emote Wheel item: use it to open the wheel, sneak-use it to edit which emotes
 * are on the wheel (the Bedrock equivalent of Emotecraft's wheel editor).
 */
const onItemUse = event => {
    const { source: player, itemStack } = event;
    if (!player || player.typeId !== "minecraft:player") return;
    if (itemStack?.typeId !== WHEEL_ITEM) return;
    const open = player.isSneaking ? openWheelEditor : openWheel;
    Promise.resolve(open(player)).catch(error => console.warn(`[emotecraft] wheel failed: ${error}`));
};

// ---------------------------------------------------------------------------
// scriptevent bridge
// ---------------------------------------------------------------------------

/**
 * `/scriptevent emotecraft_play <emoteId>` (or `emotecraft:play`) lets command
 * blocks, NPC dialogues and other packs trigger an emote on the nearest player.
 * This is the Bedrock equivalent of the Java mod's "play emote" command surface.
 */
const onScriptEvent = event => {
    const id = String(event.id || "").toLowerCase();
    if (!["emotecraft_play", "emotecraft:play", "emotecraft_emote", "emotecraft:emote", "emotecraft_stop", "emotecraft:stop", "emotecraft_wheel", "emotecraft:wheel"].includes(id)) return;
    const [player] = world.getPlayers({
        location: event.sourceEntity?.location,
        maxDistance: 32,
        closest: 1,
    });
    const target =
        event.sourceEntity && event.sourceEntity.typeId === "minecraft:player"
            ? event.sourceEntity
            : player;
    if (!target) return;

    const action = String(event.message || "").trim().toLowerCase();
    if (id.endsWith("stop") || action === "stop") {
        manager.stop(target);
        return;
    }
    if (id.endsWith("wheel") || !action) {
        openWheel(target).catch(() => {});
        return;
    }
    const emote = catalogue.find(action) ?? catalogue.search(action, 1)[0];
    if (emote) playEmote(target, emote);
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const onPlayerSpawn = event => {
    if (!event.initialSpawn) return;
    const player = event.player;
    if (!markWelcome(player)) return;
    system.runTimeout(() => {
        try {
            player.sendMessage(
                `§b§lEmotecraft §7v${VERSION}§r §7- ${catalogue.length} emotes loaded\n` +
                    `§7Type §f/emote§7 to open the wheel, §f/emote list§7 to browse, §f/emote help§7 for help.`,
            );
        } catch {
            /* player left */
        }
    }, 40);
};

const onPlayerLeave = event => {
    const playerId = event.playerId;
    for (const [id, session] of manager.sessions) {
        if (session.player.id === playerId) {
            session.done = true;
            session.clearTimers();
            session.stopSound();
            manager.sessions.delete(id);
        }
    }
};

/** Drops sessions whose player has gone, so timers cannot pile up. */
const reapSessions = () => {
    for (const [id, session] of manager.sessions) {
        if (!session.player.isValid) {
            session.done = true;
            session.clearTimers();
            session.stopSound();
            manager.sessions.delete(id);
        }
    }
};

/**
 * Boots the add-on. Called on script load, and again (idempotently) by the test
 * harness so the wiring can be exercised outside the game.
 */
export function init() {
    if (init.done) return { catalogue, manager };
    init.done = true;

    const startupEvents = system.beforeEvents?.startup;
    if (startupEvents && typeof startupEvents.subscribe === "function") {
        startupEvents.subscribe(registerCommands);
    } else {
        // Engines older than 1.21.90 have no custom command registry; the UI and
        // the Emote Wheel item keep working, so this is not fatal.
        console.warn("[emotecraft] custom commands unavailable on this engine version - use /give emotecraft:emote_wheel");
    }

    world.afterEvents.itemUse.subscribe(onItemUse);
    world.afterEvents.playerSpawn.subscribe(onPlayerSpawn);
    world.afterEvents.playerLeave.subscribe(onPlayerLeave);
    system.afterEvents.scriptEventReceive.subscribe(onScriptEvent);
    system.runInterval(reapSessions, 200);

    console.info(`[emotecraft] loaded ${catalogue.length} emotes`);
    return { catalogue, manager };
}

init();

export { manager, catalogue, playEmote as playEmoteForTest };
