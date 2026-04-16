import { pathToFileURL } from "node:url";
import tokens from "./tokens.json" with { type: "json" };
import { JoinVC } from "./module.ts";

const consolePrefix = {
	ok: "[OK]",
	error: "[ERR]",
	info: "[INFO]",
};

const logger = {
	legacy(message, ...optionalParams) {
		console.log(message, ...optionalParams);
	},
	err(message, ...optionalParams) {
		console.error(message, ...optionalParams);
	},
};

const connections = new Map();

function normalizeTokenConfig(tokenConfig) {
	return {
		token: tokenConfig.token,
		channelId: tokenConfig.voiceChannelId,
		status: tokenConfig.status,
		selfMute: Boolean(tokenConfig.selfMute),
		selfDeaf: Boolean(tokenConfig.selfDeaf),
		selfVideo: Boolean(tokenConfig.selfVideo),
		selfStream: Boolean(tokenConfig.selfStream),
	};
}

async function startConnection(tokenConfig) {
	const config = normalizeTokenConfig(tokenConfig);
	const connection = new JoinVC(config);

	await connection.initialize();
	connections.set(config.token, connection);
	logger.legacy(
		`${consolePrefix.ok} Prepared voice gateway for channel ${config.channelId} (camera=${config.selfVideo} stream=${config.selfStream})`,
	);

	return connection;
}

async function shutdownAll() {
	logger.legacy(`${consolePrefix.info} Shutting down...`);

	await Promise.allSettled(
		Array.from(connections.values(), async (connection) => {
			await connection.shutdown();
		}),
	);

	connections.clear();
}

async function bootstrap() {
	if (!Array.isArray(tokens) || tokens.length === 0) {
		throw new Error("tokens.json is empty or invalid");
	}

	logger.legacy(`${consolePrefix.ok} Loaded ${tokens.length} configuration(s).`);

	const results = await Promise.allSettled(tokens.map((tokenConfig) => startConnection(tokenConfig)));
	const failures = results.filter((result) => result.status === "rejected");

	for (const failure of failures) {
		logger.err(`${consolePrefix.error} Failed to initialize connection:`, failure.reason);
	}

	if (failures.length === results.length) {
		process.exitCode = 1;
	}
}

function registerProcessHandlers() {
	process.on("SIGINT", () => {
		void shutdownAll().finally(() => {
			process.exit();
		});
	});

	process.on("SIGTERM", () => {
		void shutdownAll().finally(() => {
			process.exit();
		});
	});

	process.on("unhandledRejection", (error) => {
		logger.err(`${consolePrefix.error} Unhandled rejection:`, error);
	});

	process.on("uncaughtException", (error) => {
		logger.err(`${consolePrefix.error} Uncaught exception:`, error);
	});
}

const isDirectRun =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
	registerProcessHandlers();
	void bootstrap();
}

export { bootstrap, shutdownAll };
