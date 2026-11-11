/**
 * UI layer, built with @minecraft/server-ui.
 *
 * Mirrors the Java mod's screens:
 *   - emote wheel   (fast-select wheel: pick favourites, play with one tap)
 *   - emote library (searchable catalogue of every emote)
 *   - config        (the toggles from Emotecraft's options screen)
 */
import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { catalogue } from "../core/catalogue.js";
import { settingsFor, SETTING_LABELS } from "../core/settings.js";

const TITLE_COLOR = "§b";
const DIM = "§7";
const GOLD = "§6";

function header(text) {
    return `${TITLE_COLOR}${text}`;
}

function subtitle(text) {
    return `${DIM}${text}`;
}

/** Shows a form, retrying after the "player is busy" failure. */
async function showForm(player, form) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const response = await form.show(player);
        if (response.canceled && response.cancelationReason === "UserBusy") {
            await waitTicks(10);
            continue;
        }
        return response;
    }
    return { canceled: true, cancelationReason: "UserBusy" };
}

function waitTicks(ticks) {
    return new Promise(resolve => {
        system.runTimeout(resolve, ticks);
    });
}

// Filled in by index.js to avoid a circular import between UI and the manager.
let helpers = {
    playEmote: () => ({ ok: false, reason: "uninitialised" }),
    isPlaying: () => false,
    stopEmote: () => false,
};

export function bindHelpers(bindings) {
    helpers = { ...helpers, ...bindings };
}

// ---------------------------------------------------------------------------
// Emote wheel
// ---------------------------------------------------------------------------

export async function openWheel(player) {
    const settings = settingsFor(player);
    // First run: seed the wheel with a handful of emotes so the feature is
    // discoverable instead of showing an empty page.
    if (!settings.favorites().length && !player.getDynamicProperty("emotecraft:wheel-seeded")) {
        settings.setFavorites(catalogue.ids().slice(0, 6));
        try {
            player.setDynamicProperty("emotecraft:wheel-seeded", true);
        } catch {
            /* best effort */
        }
    }
    const favorites = settings.favorites();
    const form = new ActionFormData()
        .title(`${header("Emotes")}`)
        .body(
            favorites.length
                ? subtitle("Tap an emote to play it.")
                : subtitle("Your wheel is empty. Use §fManage wheel§7 to add emotes."),
        );

    if (helpers.isPlaying(player)) {
        form.button("§cStop current emote", "textures/ui/icon_trash");
    }
    for (const id of favorites) {
        const emote = catalogue.get(id);
        if (!emote) continue;
        form.button(`${GOLD}${emote.name}\n${DIM}${emote.author || "Emotecraft"}`, emote.icon ?? undefined);
    }
    form.button(`${TITLE_COLOR}Manage wheel`, "textures/ui/icon_setting");
    form.button(`${TITLE_COLOR}All emotes`, "textures/ui/magnifyingGlass");

    const response = await showForm(player, form);
    if (response.canceled || response.selection === undefined) return;

    let index = response.selection;
    if (helpers.isPlaying(player)) {
        if (index === 0) {
            helpers.stopEmote(player);
            player.sendMessage(`${DIM}Emote stopped.`);
            return;
        }
        index -= 1;
    }

    if (index < favorites.length) {
        playFromWheel(player, favorites[index]);
        return;
    }
    index -= favorites.length;
    if (index === 0) return openWheelEditor(player);
    return openLibrary(player);
}

function playFromWheel(player, id) {
    const emote = catalogue.get(id);
    if (!emote) {
        player.sendMessage("§cThat emote is no longer available.");
        return;
    }
    const result = helpers.playEmote(player, emote);
    if (!result.ok && result.reason === "cooldown") {
        player.sendMessage(`${DIM}Slow down a little.`);
    } else if (!result.ok && result.reason === "disabled") {
        player.sendMessage("§cEmotes are disabled. Enable them in §f/emote config§c.");
    } else if (!result.ok && result.reason !== "invalid") {
        player.sendMessage("§cCould not play that emote.");
    }
}

export async function openWheelEditor(player) {
    const settings = settingsFor(player);
    const all = catalogue.all();
    const favorites = new Set(settings.favorites());

    const form = new ModalFormData().title(header("Emote wheel"));
    form.label(
        subtitle("Tick the emotes you want on your wheel (max 16). The wheel remembers its order as listed here."),
    );

    // Bedrock modal forms get unwieldy with dozens of toggles, but 14 emotes is fine.
    const order = catalogue.all();
    for (const emote of order) {
        form.toggle(`${emote.name} ${DIM}(${emote.id})`, { defaultValue: favorites.has(emote.id) });
    }

    const response = await showForm(player, form);
    if (response.canceled || !response.formValues) return;

    const selected = [];
    order.forEach((emote, i) => {
        if (response.formValues[i] === true) selected.push(emote.id);
    });
    settings.setFavorites(selected);
    player.sendMessage(`${TITLE_COLOR}Wheel updated: §f${selected.length} emote(s)`);
    if (!selected.length && all.length) {
        player.sendMessage(`${DIM}Tip: add emotes so you can play them from the wheel.`);
    }
}

// ---------------------------------------------------------------------------
// Emote library
// ---------------------------------------------------------------------------

export async function openLibrary(player, options = {}) {
    const query = options.query ?? "";
    const results = query ? catalogue.search(query, 25) : catalogue.all();
    const form = new ActionFormData()
        .title(header("Emote library"))
        .body(
            subtitle(
                query
                    ? `${results.length} result(s) for “${query}”`
                    : `${catalogue.length} emotes available`,
            ),
        );

    for (const emote of results) {
        const tags = [];
        if (emote.loop) tags.push("loop");
        if (emote.sound) tags.push("audio");
        if (emote.author) tags.push(emote.author);
        form.button(`${emote.name}\n${DIM}${tags.join(" · ")}`, emote.icon ?? undefined);
    }

    form.button(`${TITLE_COLOR}Search…`, "textures/ui/magnifyingGlass");
    if (query) form.button(`${TITLE_COLOR}Clear search`);
    form.button(`${TITLE_COLOR}My wheel`, "textures/ui/icon_setting");

    const response = await showForm(player, form);
    if (response.canceled || response.selection === undefined) return;

    if (response.selection < results.length) {
        return openEmoteDetails(player, results[response.selection]);
    }
    const offset = response.selection - results.length;
    if (offset === 0) return openSearch(player);
    if (query && offset === 1) return openLibrary(player, {});
    return openWheel(player);
}

export async function openSearch(player) {
    const form = new ModalFormData()
        .title(header("Search emotes"))
        .textField("Name or id", "e.g. wave, dance, clap", { defaultValue: "" });

    const response = await showForm(player, form);
    if (response.canceled || !response.formValues) return;
    const query = String(response.formValues[0] || "").trim();
    return openLibrary(player, { query });
}

export async function openEmoteDetails(player, emote) {
    const fav = settingsFor(player).favorites().includes(emote.id);
    const form = new ActionFormData()
        .title(header(emote.name))
        .body(
            [
                emote.description ? `${emote.description}` : subtitle("No description"),
                "",
                `${DIM}Author: §f${emote.author || "unknown"}`,
                `${DIM}Length: §f${emote.duration.toFixed(2)}s${emote.loop ? " (loop)" : ""}`,
                `${DIM}Id: §f${emote.id}`,
            ].join("\n"),
        );

    if (emote.icon && typeof form.bodyImage === "function") {
        try {
            form.bodyImage(emote.icon);
        } catch {
            /* older engines without body images */
        }
    }

    form.button(`${GOLD}Play`, "textures/ui/play");
    form.button(fav ? "§cRemove from wheel" : "§aAdd to wheel", "textures/ui/icon_setting");
    form.button("§fBack");

    const response = await showForm(player, form);
    if (response.canceled || response.selection === undefined) return;

    if (response.selection === 0) {
        const result = helpers.playEmote(player, emote);
        if (!result.ok && result.reason === "cooldown") player.sendMessage(`${DIM}Slow down a little.`);
        else if (!result.ok && result.reason === "disabled") player.sendMessage("§cEmotes are disabled.");
        return;
    }
    if (response.selection === 1) {
        const settings = settingsFor(player);
        settings.toggleFavorite(emote.id);
        player.sendMessage(
            `${TITLE_COLOR}${settings.favorites().includes(emote.id) ? "Added to" : "Removed from"} your wheel.`,
        );
        return openEmoteDetails(player, emote);
    }
    return openLibrary(player);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function openConfig(player) {
    const settings = settingsFor(player);
    const values = settings.values;

    const form = new ModalFormData()
        .title(header("Emotecraft options"))
        .toggle(SETTING_LABELS.enabled, { defaultValue: values.enabled })
        .toggle(SETTING_LABELS.broadcast, { defaultValue: values.broadcast })
        .toggle(SETTING_LABELS.showHud, { defaultValue: values.showHud })
        .toggle(SETTING_LABELS.wheel, { defaultValue: values.wheel })
        .slider("Emote volume", 0, 100, { valueStep: 5, defaultValue: Math.round(values.volume * 100) })
        .slider("Cooldown (ticks between emotes)", 0, 40, { valueStep: 1, defaultValue: Math.round(values.cooldown * 20) });

    const response = await showForm(player, form);
    if (response.canceled || !response.formValues) return;

    const [enabled, broadcast, showHud, wheel, volume, cooldown] = response.formValues;
    settings.set("enabled", Boolean(enabled));
    settings.set("broadcast", Boolean(broadcast));
    settings.set("showHud", Boolean(showHud));
    settings.set("wheel", Boolean(wheel));
    settings.set("volume", Number(volume) / 100);
    settings.set("cooldown", Number(cooldown) / 20);
    player.sendMessage(`${TITLE_COLOR}Settings saved.`);
}

export async function openHelp(player) {
    const form = new ActionFormData()
        .title(header("Emotecraft"))
        .body(
            [
                "§fHow to emote",
                `${DIM}• §f/emote§7 opens the emote wheel`,
                `${DIM}• §f/emote <name>§7 plays an emote directly`,
                `${DIM}• §f/emotes§7 opens the full library`,
                `${DIM}• §f/emote stop§7 cancels your current emote`,
                "",
                "§fCustom emotes",
                `${DIM}Drop your Emotecraft §f.json§7 files (plus optional .png icon`,
                `${DIM}and .ogg/.opus audio) into §fbedrock/custom/§7, then run`,
                `${DIM}§fnpm run build§7 in the bedrock folder. Every emote you add`,
                `${DIM}is converted and shows up in this menu.`,
                "",
                "§fOther ways to emote",
                `${DIM}• §f/scriptevent emotecraft_play <id>§7 - command blocks, NPCs`,
                `${DIM}• §f/emotewheel§7 - get the Emote Wheel item (survival craftable)`,
            ].join("\n"),
        );

    if (emote.icon && typeof form.bodyImage === "function") {
        try {
            form.bodyImage(emote.icon);
        } catch {
            /* older engines without body images */
        }
    }

    form.button(`${GOLD}Play`, "textures/ui/play");
    form.button(fav ? "§cRemove from wheel" : "§aAdd to wheel", "textures/ui/icon_setting");
    form.button("§fBack");

    const response = await showForm(player, form);
    if (response.canceled || response.selection === undefined) return;

    if (response.selection === 0) {
        const result = helpers.playEmote(player, emote);
        if (!result.ok && result.reason === "cooldown") player.sendMessage(`${DIM}Slow down a little.`);
        else if (!result.ok && result.reason === "disabled") player.sendMessage("§cEmotes are disabled.");
        return;
    }
    if (response.selection === 1) {
        const settings = settingsFor(player);
        settings.toggleFavorite(emote.id);
        player.sendMessage(
            `${TITLE_COLOR}${settings.favorites().includes(emote.id) ? "Added to" : "Removed from"} your wheel.`,
        );
        return openEmoteDetails(player, emote);
    }
    return openLibrary(player);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function openConfig(player) {
    const settings = settingsFor(player);
    const values = settings.values;

    const form = new ModalFormData()
        .title(header("Emotecraft options"))
        .toggle(SETTING_LABELS.enabled, { defaultValue: values.enabled })
        .toggle(SETTING_LABELS.broadcast, { defaultValue: values.broadcast })
        .toggle(SETTING_LABELS.showHud, { defaultValue: values.showHud })
        .toggle(SETTING_LABELS.wheel, { defaultValue: values.wheel })
        .slider("Emote volume", 0, 100, { valueStep: 5, defaultValue: Math.round(values.volume * 100) })
        .slider("Cooldown (ticks between emotes)", 0, 40, { valueStep: 1, defaultValue: Math.round(values.cooldown * 20) });

    const response = await showForm(player, form);
    if (response.canceled || !response.formValues) return;

    const [enabled, broadcast, showHud, wheel, volume, cooldown] = response.formValues;
    settings.set("enabled", Boolean(enabled));
    settings.set("broadcast", Boolean(broadcast));
    settings.set("showHud", Boolean(showHud));
    settings.set("wheel", Boolean(wheel));
    settings.set("volume", Number(volume) / 100);
    settings.set("cooldown", Number(cooldown) / 20);
    player.sendMessage(`${TITLE_COLOR}Settings saved.`);
}

export async function openHelp(player) {
    const form = new ActionFormData()
        .title(header("Emotecraft"))
        .body(
            [
                "§fHow to emote",
                `${DIM}• §f/emote§7 opens the emote wheel`,
                `${DIM}• §f/emote <name>§7 plays an emote directly`,
                `${DIM}• §f/emotes§7 opens the full library`,
                `${DIM}• §f/emote stop§7 cancels your current emote`,
                "",
                "§fCustom emotes",
                `${DIM}Drop Emotecraft .json emotes into the behaviour pack's`,
                `${DIM}§fscripts/data/custom§7 folder and run §f/reload§7.`,
                `${DIM}They are converted in-game, no Java needed.`,
            ].join("\n"),
        )
        .button("§fOpen wheel")
        .button("§fLibrary")
        .button("§fOptions");

    const response = await showForm(player, form);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection === 0) return openWheel(player);
    if (response.selection === 1) return openLibrary(player);
    return openConfig(player);
}

export async function confirm(player, title, body) {
    const form = new MessageFormData().title(header(title)).body(body).button1("§aYes").button2("§cNo");
    const response = await showForm(player, form);
    return !response.canceled && response.selection === 0;
}
