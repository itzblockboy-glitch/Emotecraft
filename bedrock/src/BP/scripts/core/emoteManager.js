/**
 * Emote playback controller.
 *
 * Emotecraft's playback model:
 *   - an emote is a keyframe timeline, baked here to a 20 fps Bedrock clip;
 *   - `beginTick` is a short wind-up before the motion starts;
 *   - `returnTick` is where a looping emote jumps back to;
 *   - `stopTick` is the hard end, after which the body blends to rest;
 *   - an emote can be cancelled at any time, which fades the pose out.
 *
 * Bedrock plays the actual bone motion client-side from the generated resource
 * pack animations; this manager only sequences clips, audio and cleanup.
 */
import { system, world } from "@minecraft/server";
import { settingsFor } from "./settings.js";

const SESSION_KEY = "emotecraft:playing";

export class EmoteSession {
    constructor(player, emote) {
        this.player = player;
        this.emote = emote;
        this.startedAt = Date.now();
        this.done = false;
        this.timers = new Set();
        this.soundHandle = null;

        this.duration = Math.max(0.2, Number(emote.duration) || 1);
        this.loopStart = Math.max(0, Number(emote.loopStart) || 0);
        this.loop = Boolean(emote.loop);
    }

    /** Runs `fn` after `ticks`, unless the session ended first. */
    later(ticks, fn) {
        const id = system.runTimeout(() => {
            this.timers.delete(id);
            if (this.done) return;
            try {
                fn();
            } catch (error) {
                console.warn(`[emotecraft] scheduled step failed: ${error}`);
            }
        }, Math.max(1, Math.round(ticks)));
        this.timers.add(id);
        return id;
    }

    clearTimers() {
        for (const id of this.timers) {
            try {
                system.clearRun(id);
            } catch {
                /* already fired */
            }
        }
        this.timers.clear();
    }

    stopSound() {
        if (!this.soundHandle) return;
        try {
            this.soundHandle.stop();
        } catch {
            /* finished already */
        }
        this.soundHandle = null;
    }
}

export class EmoteManager {
    constructor(catalogue) {
        this.catalogue = catalogue;
        this.sessions = new Map();
        this.lastUsed = new Map();
    }

    current(player) {
        const session = this.sessions.get(player.id);
        return session && !session.done ? session : undefined;
    }

    isPlaying(player) {
        return Boolean(this.current(player));
    }

    /**
     * Plays `emote` on `player`.
     * @returns {{ok: boolean, reason?: string, session?: EmoteSession}}
     */
    play(player, emote, options = {}) {
        if (!player || player.isValid === false) return { ok: false, reason: "invalid" };
        if (!emote) return { ok: false, reason: "unknown" };
        if (!emote.animation) return { ok: false, reason: "no-animation" };

        const settings = settingsFor(player);
        if (!settings.get("enabled") && !options.force) return { ok: false, reason: "disabled" };

        const cooldown = Math.max(0, Number(settings.get("cooldown")) || 0) * 1000;
        const last = this.lastUsed.get(player.id) ?? 0;
        if (cooldown > 0 && Date.now() - last < cooldown) {
            return { ok: false, reason: "cooldown" };
        }

        this.stop(player, { silent: true, keepProperty: true });

        const session = new EmoteSession(player, emote);
        this.sessions.set(player.id, session);
        this.lastUsed.set(player.id, Date.now());

        try {
            player.playAnimation(emote.animation, { blendOutTime: 0.2 });
        } catch (error) {
            console.warn(`[emotecraft] playAnimation("${emote.animation}") failed: ${error}`);
            this.sessions.delete(player.id);
            return { ok: false, reason: "engine" };
        }

        if (emote.sound) {
            try {
                session.soundHandle = player.playSound(emote.sound, {
                    volume: Math.max(0, Math.min(1, Number(settings.get("volume")) || 1)),
                    pitch: 1,
                });
            } catch (error) {
                console.warn(`[emotecraft] could not play "${emote.sound}": ${error}`);
            }
        }

        if (session.loop && emote.loopAnimation) {
            // Intro -> loop. The loop clip repeats until the emote is stopped.
            session.later(Math.max(2, session.loopStart * 20), () => {
                if (session.done) return;
                try {
                    player.playAnimation(emote.loopAnimation, { blendOutTime: 0.1 });
                } catch (error) {
                    console.warn(`[emotecraft] loop clip failed: ${error}`);
                }
            });
        }

        // Both looping and one-shot emotes end at stopTick.
        const stopTicks = Math.max(4, (Number(emote.stop) || session.duration + 0.1) * 20);
        session.later(stopTicks, () => this.finish(session));

        this.writeProperty(player, emote.id);
        return { ok: true, session };
    }

    finish(session) {
        if (!session || session.done) return;
        session.done = true;
        session.clearTimers();
        session.stopSound();
        const player = session.player;
        if (this.sessions.get(player.id) === session) this.sessions.delete(player.id);
        // Blend the pose away: re-assert the vanilla idle so the body resets.
        try {
            player.playAnimation("animation.player.bob", { blendOutTime: 0.3 });
        } catch {
            /* cosmetic */
        }
        this.writeProperty(player, undefined);
    }

    /** Cancels the player's emote, if any. */
    stop(player, options = {}) {
        const session = this.sessions.get(player.id);
        if (!session) return false;
        session.done = true;
        session.clearTimers();
        session.stopSound();
        this.sessions.delete(player.id);
        if (!options.silent) {
            try {
                player.playAnimation("animation.player.bob", { blendOutTime: 0.3 });
            } catch {
                /* cosmetic */
            }
        }
        if (!options.keepProperty) this.writeProperty(player, undefined);
        return true;
    }

    stopAll() {
        for (const player of world.getAllPlayers()) this.stop(player, { silent: true });
    }

    writeProperty(player, value) {
        try {
            player.setDynamicProperty(SESSION_KEY, value);
        } catch {
            /* dynamic properties are best effort */
        }
    }
}
