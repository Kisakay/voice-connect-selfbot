import { Client, Options } from "discord.js-selfbot-v13";
import { logger } from "ihorizon-tools";
import tokens from "./tokens.json";

const consolePrefix = {
    prefix_ok: `[`.gray.boldText + `✅`.green + `]`.gray.boldText,
    prefix_error: `[`.gray.boldText + `❌`.red + `]`.gray.boldText,
};

let configs = [];
let clients = [];
let voiceConnections = new Map();

function configParser() {
    for (let tokenConfig of tokens) {
        const { selfDeaf, selfMute, selfStream, selfVideo, status, token, voiceChannelId } = tokenConfig;
        configs.push({
            discord_token: token,
            voice_channel_id: voiceChannelId,
            status: status,
            config: {
                selfMute,
                selfDeaf,
                selfVideo,
                selfStream,
            }
        });
    }
    logger.legacy(consolePrefix.prefix_ok + ` Loaded ${configs.length} configurations.`.green);
}

async function joinVoiceChannel(self, client) {
    try {
        const channel = self.channels.cache.get(client.voice_channel_id);

        if (!channel) {
            logger.err(consolePrefix.prefix_error + " " + self.user.id + " Voice channel not found.");
            return null;
        }

        const voiceConnection = await self.voice.joinChannel(channel.id, {
            selfDeaf: client.config.selfDeaf,
            selfMute: client.config.selfMute,
            selfVideo: client.config.selfVideo,
        });

        if (client.config.selfStream) {
            await voiceConnection.createStreamConnection();
        }

        logger.legacy(consolePrefix.prefix_ok + " " + self.user.id + " Connected to voice channel.");
        return voiceConnection;
    } catch (error) {
        logger.err(consolePrefix.prefix_error + " " + self.user.id + " Failed to join voice channel:", error.message);
        return null;
    }
}

function startVoiceMonitoring(self, client) {
    const checkInterval = setInterval(async () => {
        try {
            const channel = self.channels.cache.get(client.voice_channel_id);

            if (!channel) {
                logger.err(consolePrefix.prefix_error + " " + self.user.id + " Voice channel not found.");
                return;
            }

            const currentConnection = voiceConnections.get(self.user.id);
            const isInChannel = channel.members.has(self.user.id);


            if (!isInChannel || !currentConnection) {
                logger.legacy(`[ℹ️] ${self.user.id} Not in voice channel, reconnecting...`);
                const newConnection = await joinVoiceChannel(self, client);
                if (newConnection) {
                    voiceConnections.set(self.user.id, newConnection);
                }
                return;
            }


            if (client.config.selfStream) {
                const streamConnection = currentConnection.streamConnection;

                if (!streamConnection || streamConnection.status !== 'ready') {
                    logger.legacy(`[ℹ️] ${self.user.id} Stream connection lost, recreating...`);
                    try {
                        await currentConnection.createStreamConnection();
                        logger.legacy(consolePrefix.prefix_ok + " " + self.user.id + " Stream reconnected.");
                    } catch (error) {
                        logger.err(consolePrefix.prefix_error + " " + self.user.id + " Failed to recreate stream:", error.message);
                    }
                }
            }


            if (currentConnection.status === 'disconnected' || currentConnection.status === 'destroyed') {
                logger.legacy(`[ℹ️] ${self.user.id} Voice connection lost, reconnecting...`);
                const newConnection = await joinVoiceChannel(self, client);
                if (newConnection) {
                    voiceConnections.set(self.user.id, newConnection);
                }
            }
        } catch (error) {
            logger.err(consolePrefix.prefix_error + " " + self.user.id + " Error in monitoring:", error.message);
        }
    }, 5000);

    return checkInterval;
}

configParser();

for (let client of configs) {
    const self = new Client({
        makeCache: Options.cacheWithLimits({
            MessageManager: 0,
            UserManager: 0,
            PresenceManager: 0,
            ReactionManager: 0,
            GuildEmojiManager: 0,
            ThreadManager: 0,
            ReactionUserManager: 0,
            AutoModerationRuleManager: 0,
            ApplicationCommandManager: 0,
            GuildBanManager: 0,
            BaseGuildEmojiManager: 0,
            GuildInviteManager: 0,
            GuildStickerManager: 0,
            ThreadMemberManager: 0
        })
    });

    self.on("ready", async () => {
        clients.push(self);
        logger.legacy(consolePrefix.prefix_ok + ` Logged in as ${self.user.tag}`);


        self.user.setStatus(client.status);


        const voiceConnection = await joinVoiceChannel(self, client);
        if (voiceConnection) {
            voiceConnections.set(self.user.id, voiceConnection);
        }


        startVoiceMonitoring(self, client);
    });

    self.login(client.discord_token).catch((error) => {
        logger.err(consolePrefix.prefix_error + ` Failed to login:`, error.message);
    });
}

process.on("SIGINT", () => {
    logger.legacy(`[ℹ️] Shutting down...`);
    clients.forEach(client => {
        client.destroy();
    });
    voiceConnections.clear();
    process.exit();
});

process.on("unhandledRejection", (error) => {
    logger.err(consolePrefix.prefix_error + " Unhandled Rejection:", error);
});

process.on("uncaughtException", (error) => {
    logger.err(consolePrefix.prefix_error + " Uncaught Exception:", error);
});
