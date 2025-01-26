import { Client } from "discord.js-selfbot-v13";
import fs from "fs";
import { logger } from "ihorizon-tools";

const consolePrefix = {
    prefix_ok: `[`.gray.boldText + `✅`.green + `]`.gray.boldText,
    prefix_error: `[`.gray.boldText + `❌`.red + `]`.gray.boldText,
};

let configs = [];
let clients = [];

function configParser(str) {
    str.split("\n").forEach(line => {
        let [token, channel_id, status, muted, deafen, camera] = line.split(":");

        configs.push
            ({
                discord_token: token,
                voice_channel_id: channel_id,
                status: status,
                config: {
                    selfMute: muted === "yes" ? true : false,
                    selfDeaf: deafen === "yes" ? true : false,
                    selfVideo: camera === "yes" ? true : false,
                }
            });
    });

    logger.legacy(consolePrefix.prefix_ok + `Loaded ${configs.length} self.`.green);
}

configParser(fs.readFileSync("tokens.txt", "utf-8"));

for (let client of configs) {
    const self = new Client();

    self.on("ready", () => {
        clients.push(self);

        logger.legacy(consolePrefix.prefix_ok + `Logged in as ${self.user.tag}`);

        const channel = self.channels.cache.get(client.voice_channel_id);

        self.user.setStatus(client.status);
        if (!channel) {
            logger.err(consolePrefix.prefix_error + " " + self.user.id + " Voice channel not found.");
            return;
        }

        self.voice.joinChannel(channel.id, {
            selfDeaf: client.config.selfDeaf,
            selfMute: client.config.selfMute,
            selfVideo: client.config.selfVideo,
        }).then(() => {
            logger.legacy(consolePrefix.prefix_ok + " " + self.user.id + " Connected to voice channel.");
        }).catch(console.error);

        setInterval(() => {
            // check if the bot is connected to a voice channel
            if (channel.members.filter(member => member.id === self.user.id).size === 0) {
                // reconnect to the voice channel
                self.voice.joinChannel(channel.id, {
                    selfDeaf: client.config.selfDeaf,
                    selfMute: client.config.selfMute,
                    selfVideo: client.config.selfVideo,
                }).catch(console.error);
            }
        }, 1000);
    });

    self.login(client.discord_token)
}

process.on("SIGINT", () => {
    clients.forEach(client => {
        client.destroy();
    });
    process.exit();
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);