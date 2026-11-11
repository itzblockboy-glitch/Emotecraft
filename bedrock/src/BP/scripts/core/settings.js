/**
 * Per-player settings, stored as dynamic properties on the player entity so they
 * survive world reloads (the Bedrock equivalent of Emotecraft's client config).
 *
 * Available toggles mirror the Java mod's "Other config" screen:
 *   - enabled        master switch (hide emotes from this player)
 *   - broadcast      announce emote names to nearby players
 *   - showHud        show the "playing X" toast on the action bar
 *   - wheel          quick-select wheel enabled
 *   - cooldown       minimum seconds between emotes
 *   - volume         emote audio volume multiplier
 */
import { world } from "@minecraft/server";

export const DEFAULTS = Object.freeze({
    enabled: true,
    broadcast: true,
    showHud: true,
    wheel: true,
    cooldown: 0.25,
    volume: 1,
});

const PREFIX = "emotecraft:cfg:";

const FAVORITES_KEY = "emotecraft:fav";

export class Settings {
    constructor(player) {
        this.player = player;
        this.values = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            const stored = player.getDynamicProperty(PREFIX + key);
            if (typeof stored === "boolean" && typeof DEFAULTS[key] === "boolean") this.values[key] = stored;
            else if (typeof stored === "number" && typeof DEFAULTS[key] === "number") this.values[key] = stored;
        }
    }

    get(key) {
        return this.values[key];
    }

    set(key, value) {
        if (!(key in DEFAULTS)) return false;
        this.values[key] = value;
        try {
            this.player.setDynamicProperty(PREFIX + key, value);
        } catch (error) {
            console.warn(`[emotecraft] could not persist ${key}: ${error}`);
        }
        return true;
    }

    toggle(key) {
        if (typeof DEFAULTS[key] !== "boolean") return this.values[key];
        this.set(key, !this.values[key]);
        return this.values[key];
    }

    /** Ordered list of emote ids on the player's quick wheel. */
    favorites() {
        const stored = this.player.getDynamicProperty(FAVORITES_KEY);
        if (typeof stored !== "string" || !stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
        } catch {
            return stored.split(",").filter(Boolean);
        }
    }

    setFavorites(list) {
        const clean = [...new Set(list.filter(id => typeof id === "string"))].slice(0, 16);
        try {
            this.player.setDynamicProperty(FAVORITES_KEY, JSON.stringify(clean));
        } catch (error) {
            console.warn(`[emotecraft] could not persist wheel: ${error}`);
        }
        return clean;
    }

    toggleFavorite(id) {
        const list = this.favorites();
        const index = list.indexOf(id);
        if (index >= 0) list.splice(index, 1);
        else list.push(id);
        return this.setFavorites(list);
    }
}

/** Explains the defaults in the config UI. */
export const SETTING_LABELS = {
    enabled: "Emotes enabled",
    broadcast: "Announce emotes in chat",
    showHud: "Show emote toast",
    wheel: "Quick emote wheel",
};

export function settingsFor(player) {
    return new Settings(player);
}

/** Used by the one-time welcome message. */
export function markWelcome(player) {
    if (player.getDynamicProperty("emotecraft:welcomed")) return false;
    player.setDynamicProperty("emotecraft:welcomed", true);
    return true;
}

export function onlinePlayers() {
    return world.getAllPlayers();
}
