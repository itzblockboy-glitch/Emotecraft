/**
 * Emote catalogue: wraps the generated `data/emotes.js` and adds convenience
 * lookups (by id, by display name, fuzzy search) used by the UI and commands.
 */
import { EMOTES } from "../data/emotes.js";

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export class Catalogue {
    constructor(entries) {
        this.emotes = entries.map(entry => ({
            ...entry,
            key: normalize(entry.name),
            aliases: [normalize(entry.id), normalize(entry.name), normalize(entry.description)].filter(Boolean),
        }));
        this.byId = new Map();
        for (const emote of this.emotes) {
            this.byId.set(emote.id, emote);
        }
    }

    get length() {
        return this.emotes.length;
    }

    all() {
        return this.emotes;
    }

    get(id) {
        return this.byId.get(String(id || "").toLowerCase());
    }

    /** Exact match on id or display name. */
    find(query) {
        const key = normalize(query);
        if (!key) return undefined;
        return this.emotes.find(emote => emote.aliases.includes(key)) ?? this.emotes.find(emote => emote.aliases.some(a => a.startsWith(key)));
    }

    /** Ranked fuzzy search: word-prefix matches score above substring matches. */
    search(query, limit = 20) {
        const key = normalize(query);
        if (!key) return this.emotes.slice(0, limit);
        const scored = [];
        for (const emote of this.emotes) {
            let best = 0;
            for (const alias of emote.aliases) {
                if (!alias) continue;
                if (alias === key) best = Math.max(best, 100);
                else if (alias.startsWith(key)) best = Math.max(best, 80);
                else if (alias.split(" ").some(word => word.startsWith(key))) best = Math.max(best, 60);
                else if (alias.includes(key)) best = Math.max(best, 40);
            }
            if (best > 0) scored.push({ emote, best });
        }
        scored.sort((a, b) => b.best - a.best || a.emote.name.localeCompare(b.emote.name));
        return scored.slice(0, limit).map(entry => entry.emote);
    }

    ids() {
        return this.emotes.map(emote => emote.id);
    }
}

export const catalogue = new Catalogue(EMOTES);
