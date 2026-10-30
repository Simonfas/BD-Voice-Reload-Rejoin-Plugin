/**
 * @name VoiceReloadRejoin
 * @author Simonfas
 * @version 1.5.0
 * @description Rejoins your last voice channel after a Discord reload.
 */
module.exports = class VoiceReloadRejoin {
    constructor() {
        this.api = new BdApi("VoiceReloadRejoin");
        this.active = false;
        this.unloading = false;
        this.rejoining = false;
        this.timer = null;
        this.restoreTimer = null;
        this.leaveTimer = null;
        this.target = null;
        this.lastActive = null;
        this.account = null;
        this.attempts = 0;
        this.logs = [];

        this.onUnload = () => {
            this.unloading = true;
            this.cancelLeave();

            const id = this.actualVoice();

            if (id) {
                this.save(id, "before reload");
            }
        };
    }

    log(...parts) {
        const line = parts.map(String).join(" ");

        this.logs.push(
            `${new Date().toLocaleTimeString()} ${line}`
        );

        this.logs = this.logs.slice(-30);

        console.log("[VoiceReloadRejoin]", ...parts);
    }

    init() {
        const w = this.api.Webpack;

        this.voice = w.getStore("VoiceStateStore");
        this.channels = w.getStore("ChannelStore");
        this.users = w.getStore("UserStore");
        this.selected = w.getStore("SelectedChannelStore");

        this.actions = w.getByKeys("selectVoiceChannel") ||
            w.getModule(
                m => typeof m?.selectVoiceChannel === "function",
                {searchExports: true}
            );
    }

    userId() {
        return this.users?.getCurrentUser?.()?.id || null;
    }

    voiceChannel(id) {
        const channel = id &&
            this.channels?.getChannel?.(id);

        return channel && [
            2,
            13,
            "GUILD_VOICE",
            "GUILD_STAGE_VOICE"
        ].includes(channel.type)
            ? channel
            : null;
    }

    actualVoice() {
        try {
            const uid = this.userId();

            if (!uid) return null;

            const state =
                this.voice?.getVoiceStateForUser?.(uid);

            const candidates = [
                state?.channelId,
                state?.channel_id,
                this.voice?.getCurrentClientVoiceChannelId?.()
            ];

            return candidates.find(
                id => typeof id === "string" &&
                    this.voiceChannel(id)
            ) || null;

        } catch (error) {
            this.log("Voice lookup failed:", error);
            return null;
        }
    }

    read() {
        try {
            return this.api.Data.load("lastVoice");
        } catch (error) {
            this.log("Storage read failed:", error);
            return null;
        }
    }

    save(id, source) {
        const userId = this.userId();
        const channel = this.voiceChannel(id);

        if (!userId || !channel) return;

        const old = this.read();

        if (
            old?.userId === userId &&
            old?.channelId === id
        ) {
            return;
        }

        const record = {
            userId,
            channelId: id,
            guildId: channel.guild_id ||
                channel.guildId ||
                null
        };

        try {
            this.api.Data.save("lastVoice", record);

            this.log(
                "Saved:",
                id,
                "source:",
                source
            );
        } catch (error) {
            this.log("Storage write failed:", error);
        }
    }

    clear(reason) {
        if (this.unloading) return;

        try {
            this.api.Data.delete("lastVoice");
        } catch (error) {
            this.log("Storage delete failed:", error);
        }

        this.target = null;
        this.log("Cleared:", reason);
    }

    cancelLeave() {
        clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
    }

    pendingManualLeave() {
        if (
            this.leaveTimer ||
            this.unloading ||
            this.rejoining
        ) {
            return;
        }

        this.leaveTimer = setTimeout(() => {
            this.leaveTimer = null;

            if (
                !this.active ||
                this.unloading ||
                this.rejoining
            ) {
                return;
            }

            if (!this.actualVoice()) {
                this.clear("manual disconnect");
            }
        }, 8000);
    }

    observe() {
        if (!this.active || this.unloading) return;

        const uid = this.userId();

        if (!uid) return;

        if (
            this.account &&
            uid !== this.account
        ) {
            this.account = uid;
            this.target = null;
            this.lastActive = null;

            this.cancelLeave();
            clearTimeout(this.restoreTimer);

            this.log(
                "Account switched; restore cancelled"
            );

            return;
        }

        this.account = uid;

        const id = this.actualVoice();

        if (id) {
            this.cancelLeave();

            if (this.lastActive !== id) {
                this.save(id, "voice state");
            }

            this.lastActive = id;

            if (this.target?.channelId === id) {
                this.log("Rejoin confirmed:", id);
                this.target = null;
            }
        } else {
            this.lastActive = null;
        }
    }

    start() {
        this.active = true;
        this.unloading = false;

        this.init();

        this.account = this.userId();

        const current = this.actualVoice();

        if (current) {
            this.lastActive = current;
            this.save(current, "startup");
        }

        this.log(
            "Started; saved:",
            this.read()?.channelId || "none"
        );

        if (
            typeof this.actions?.selectVoiceChannel ===
            "function"
        ) {
            this.api.Patcher.before(
                this.actions,
                "selectVoiceChannel",
                (_, args) => {
                    if (
                        !this.active ||
                        this.unloading ||
                        this.rejoining
                    ) {
                        return;
                    }

                    const id = args[0];

                    if (id == null) {
                        this.pendingManualLeave();
                    } else if (this.voiceChannel(id)) {
                        this.cancelLeave();
                        this.save(id, "join action");
                        this.target = null;
                    }
                }
            );
        } else {
            this.log("Join action unavailable");
        }

        window.addEventListener(
            "beforeunload",
            this.onUnload
        );

        window.addEventListener(
            "pagehide",
            this.onUnload
        );

        this.timer = setInterval(
            () => this.observe(),
            1000
        );

        this.restoreTimer = setTimeout(
            () => this.restore(),
            5500
        );
    }

    restore() {
        if (!this.active || this.unloading) return;

        const uid = this.userId();

        if (!uid) {
            this.restoreTimer = setTimeout(
                () => this.restore(),
                2000
            );

            return;
        }

        if (this.actualVoice()) return;

        const saved = this.read();

        if (
            saved?.userId !== uid ||
            !this.voiceChannel(saved?.channelId)
        ) {
            this.log("No valid saved voice channel");
            return;
        }

        this.target = saved;

        if (
            typeof this.actions?.selectVoiceChannel !==
            "function"
        ) {
            this.log(
                "Cannot restore: join action missing"
            );

            return;
        }

        this.attempts = 1;
        this.rejoining = true;

        this.log(
            "Rejoin requested:",
            saved.channelId
        );

        try {
            Promise.resolve(
                this.actions.selectVoiceChannel(
                    saved.channelId
                )
            )
                .then(() => {
                    this.log("Join action completed");
                })
                .catch(error => {
                    this.log(
                        "Join action rejected:",
                        error
                    );
                })
                .finally(() => {
                    this.rejoining = false;
                });

        } catch (error) {
            this.rejoining = false;

            this.log(
                "Join action threw:",
                error
            );
        }

        setTimeout(() => {
            if (
                !this.active ||
                this.unloading ||
                !this.target
            ) {
                return;
            }

            if (
                this.actualVoice() === saved.channelId
            ) {
                this.log(
                    "Rejoin confirmed:",
                    saved.channelId
                );

                this.target = null;
            } else {
                this.log(
                    "Join sent; voice state not confirmed " +
                    "(no repeated joins)"
                );
            }
        }, 10000);
    }

    getSettingsPanel() {
        const root = document.createElement("div");

        root.style.cssText =
            "padding:16px;color:var(--text-normal)";

        const status = document.createElement("pre");

        status.style.cssText =
            "white-space:pre-wrap;" +
            "overflow-wrap:anywhere;" +
            "user-select:text";

        const button = document.createElement("button");

        button.textContent = "Refresh status";

        button.style.cssText =
            "padding:8px 14px;" +
            "cursor:pointer;" +
            "margin-top:12px";

        const refresh = () => {
            status.textContent = [
                `Actual voice: ${
                    this.actualVoice() || "none"
                }`,

                `Selected voice: ${
                    this.selected?.getVoiceChannelId?.() ||
                    "none"
                }`,

                `Saved voice: ${
                    this.read()?.channelId || "none"
                }`,

                `Restore target: ${
                    this.target?.channelId || "none"
                }`,

                `Join requests: ${this.attempts}`,

                "",
                "Recent logs:",

                ...this.logs.slice(-15)
            ].join("\n");
        };

        button.onclick = refresh;

        root.append(status, button);

        refresh();

        return root;
    }

    stop() {
        const id = this.actualVoice();

        if (id) {
            this.save(id, "plugin stopped");
        }

        this.active = false;
        this.cancelLeave();

        clearInterval(this.timer);
        clearTimeout(this.restoreTimer);

        window.removeEventListener(
            "beforeunload",
            this.onUnload
        );

        window.removeEventListener(
            "pagehide",
            this.onUnload
        );

        this.api.Patcher.unpatchAll();
    }
};
