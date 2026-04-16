import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import logger from "./ihorizon-tools/logger.ts";

const API_BASE_URL = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const OPCode = Object.freeze({
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	STATUS_UPDATE: 3,
	VOICE_STATE_UPDATE: 4,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
	STREAM_CREATE: 18,
	STREAM_DELETE: 19,
	STREAM_WATCH: 20,
	STREAM_PING: 21,
	STREAM_SET_PAUSED: 22,
});

type GatewayPayload = {
	op: number;
	d?: any;
	s?: number | null;
	t?: string | null;
};

type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

type JoinVCConfig = {
	token: string;
	guildId?: string | null;
	channelId: string;
	status?: PresenceStatus | string;
	selfMute?: boolean;
	selfDeaf?: boolean;
	selfVideo?: boolean;
	selfStream?: boolean;
};

type ChannelResponse = {
	id: string;
	type: number;
	guild_id?: string;
	name?: string;
};

type VoiceStateUpdatePayload = {
	guild_id: string | null;
	channel_id: string | null;
	self_mute: boolean;
	self_deaf: boolean;
	self_video: boolean;
	flags: number;
};

type StreamState = {
	active: boolean;
	paused: boolean;
	rtcServerId: string | null;
	endpoint: string | null;
	token: string | null;
	region: string | null;
	viewerIds: string[];
	streamKey: string | null;
};

function generateClientSessionProps(): {
	client_launch_id: string;
	launch_signature: string;
	client_heartbeat_session_id: string;
} {
	const uuid = () => randomUUID();

	return {
		client_launch_id: uuid(),
		launch_signature: uuid(),
		client_heartbeat_session_id: uuid(),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

class JoinVC {
	sessionId = "";
	voiceSessionId = "";
	channelId: string | null = null;
	guildId: string | null = null;

	private readonly config: JoinVCConfig;
	private ws: WebSocket | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private heartbeatAck = true;
	private sequenceNumber: number | null = null;
	private currentUser: { id: string; username?: string; discriminator?: string } | null = null;
	private resumeGatewayUrl: string | null = null;
	private shouldResume = false;
	private shuttingDown = false;
	private channelType: number | null = null;
	private voiceServer = {
		endpoint: null as string | null,
		token: null as string | null,
	};
	private streamState: StreamState = {
		active: false,
		paused: false,
		rtcServerId: null,
		endpoint: null,
		token: null,
		region: null,
		viewerIds: [],
		streamKey: null,
	};

	constructor(config: JoinVCConfig) {
		this.config = {
			selfDeaf: true,
			selfMute: true,
			selfStream: false,
			selfVideo: false,
			status: "online",
			...config,
		};
		this.channelId = null;
		this.guildId = this.config.guildId ?? null;
	}

	private log(message: string): void {
		const userId = this.currentUser?.id ? ` ${this.currentUser.id}` : "";
		logger.log(`[JoinVC]${userId} ${message}`);
	}

	private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers ?? {});
		headers.set("Authorization", this.config.token);
		headers.set("Content-Type", "application/json");

		const response = await fetch(`${API_BASE_URL}${path}`, {
			...init,
			headers,
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Discord API ${response.status}: ${errorBody || response.statusText}`);
		}

		return response.json() as Promise<T>;
	}

	private normalizeStatus(status?: string): PresenceStatus {
		switch (status) {
			case "idle":
			case "dnd":
			case "invisible":
			case "online":
				return status;
			default:
				return "online";
		}
	}

	private get targetChannelId(): string {
		return this.config.channelId;
	}

	private get currentChannelId(): string | null {
		return this.channelId ?? this.targetChannelId;
	}

	private get streamKey(): string | null {
		if (!this.currentUser?.id || !this.currentChannelId) {
			return null;
		}

		if (this.guildId) {
			return `guild:${this.guildId}:${this.currentChannelId}:${this.currentUser.id}`;
		}

		return `call:${this.currentChannelId}:${this.currentUser.id}`;
	}

	private get streamType(): "guild" | "call" {
		return this.guildId ? "guild" : "call";
	}

	private sendPayload(op: number, d: any): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		this.ws.send(JSON.stringify({ op, d }));
		return true;
	}

	private startHeartbeat(intervalMs: number): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
		}

		this.heartbeatAck = true;
		this.heartbeatInterval = setInterval(() => {
			if (!this.heartbeatAck) {
				this.log("Gateway heartbeat timed out, reconnecting...");
				this.ws?.close(4000, "Missing heartbeat ack");
				return;
			}

			this.heartbeatAck = false;
			this.sendPayload(OPCode.HEARTBEAT, this.sequenceNumber);
		}, intervalMs);
	}

	private identify(): void {
		this.sendPayload(OPCode.IDENTIFY, {
			token: this.config.token,
			properties: {
				$os: process.platform,
				$browser: "vc.ts",
				$device: "vc.ts",
				...generateClientSessionProps(),
			},
			compress: false,
			large_threshold: 50,
			intents: (1 << 0) | (1 << 7) | (1 << 9) | (1 << 12),
			presence: {
				status: this.normalizeStatus(this.config.status),
				since: null,
				activities: [],
				afk: false,
			},
		});
	}

	private resume(): void {
		if (!this.sessionId || this.sequenceNumber === null) {
			this.identify();
			return;
		}

		this.sendPayload(OPCode.RESUME, {
			token: this.config.token,
			session_id: this.sessionId,
			seq: this.sequenceNumber,
		});
	}

	private buildVoiceStatePayload(
		overrides: Partial<VoiceStateUpdatePayload> = {},
	): VoiceStateUpdatePayload {
		return {
			guild_id: this.guildId,
			channel_id: this.currentChannelId,
			self_mute: Boolean(this.config.selfMute),
			self_deaf: Boolean(this.config.selfDeaf),
			self_video: Boolean(this.config.selfVideo),
			flags: 2,
			...overrides,
		};
	}

	private async resolveChannelMetadata(): Promise<void> {
		const channel = await this.api<ChannelResponse>(`/channels/${this.targetChannelId}`);
		this.guildId = channel.guild_id ?? null;
		this.channelType = channel.type;
		this.log(
			`Resolved channel ${channel.id}${channel.guild_id ? ` in guild ${channel.guild_id}` : ""}${
				channel.name ? ` (${channel.name})` : ""
			}`,
		);
	}

	private async reconnectGateway(resume = true): Promise<void> {
		if (this.shuttingDown) {
			return;
		}

		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onclose = null;
			this.ws.onerror = null;

			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close(1000);
			}

			this.ws = null;
		}

		await delay(2_000);
		this.connectGateway(resume);
	}

	private async ensureMediaState(): Promise<void> {
		if (this.config.selfVideo) {
			await this.setCameraEnabled(true);
		}

		if (this.config.selfStream) {
			await this.startStream(true);
		}
	}

	private handleReady(data: any): void {
		this.currentUser = data.user;
		this.sessionId = data.session_id;

		if (typeof data.resume_gateway_url === "string" && data.resume_gateway_url.length > 0) {
			const resumeUrl = data.resume_gateway_url.startsWith("wss://")
				? data.resume_gateway_url
				: `wss://${data.resume_gateway_url}/?v=10&encoding=json`;
			this.resumeGatewayUrl = resumeUrl.includes("?")
				? resumeUrl
				: `${resumeUrl}/?v=10&encoding=json`;
		}

		this.log(
			`Logged in as ${data.user.username}#${data.user.discriminator} | gateway session ${data.session_id}`,
		);
		this.sendStatusUpdate(this.normalizeStatus(this.config.status));

		setTimeout(() => {
			void this.joinVoiceChannel();
		}, 1_000);
	}

	private handleSelfVoiceState(data: any): void {
		const newChannelId = data.channel_id ?? null;
		this.channelId = newChannelId;
		this.guildId = data.guild_id ?? this.guildId;
		this.voiceSessionId = data.session_id ?? this.voiceSessionId;

		if (newChannelId === this.targetChannelId) {
			this.log(
				`Voice state ready in ${newChannelId} | mute=${Boolean(data.self_mute)} deaf=${Boolean(
					data.self_deaf,
				)} video=${Boolean(data.self_video)}`,
			);
			void this.ensureMediaState();
			return;
		}

		if (newChannelId) {
			this.log(`Moved to ${newChannelId}, restoring target channel ${this.targetChannelId}...`);
		} else {
			this.log(`Left voice channel, restoring target channel ${this.targetChannelId}...`);
		}

		this.streamState.active = false;
		this.streamState.streamKey = null;

		setTimeout(() => {
			void this.joinVoiceChannel();
		}, 1_500);
	}

	private matchesOwnStream(data: any): boolean {
		return typeof data?.stream_key === "string" && data.stream_key === this.streamKey;
	}

	private handleStreamDispatch(eventType: string, data: any): void {
		if (!this.matchesOwnStream(data)) {
			return;
		}

		this.streamState.streamKey = data.stream_key;

		switch (eventType) {
			case "STREAM_CREATE":
				this.streamState.active = true;
				this.streamState.rtcServerId = data.rtc_server_id ?? null;
				this.log(`Stream created for ${data.stream_key}`);
				break;

			case "STREAM_SERVER_UPDATE":
				this.streamState.endpoint = data.endpoint ?? null;
				this.streamState.token = data.token ?? null;
				this.log(`Stream server update: ${data.endpoint ?? "no endpoint"}`);
				break;

			case "STREAM_UPDATE":
				this.streamState.active = true;
				this.streamState.paused = Boolean(data.paused);
				this.streamState.region = data.region ?? null;
				this.streamState.viewerIds = Array.isArray(data.viewer_ids) ? data.viewer_ids : [];
				this.log(
					`Stream update: paused=${this.streamState.paused} viewers=${this.streamState.viewerIds.length}`,
				);
				break;

			case "STREAM_DELETE":
				this.log("Stream deleted");
				this.streamState = {
					active: false,
					paused: false,
					rtcServerId: null,
					endpoint: null,
					token: null,
					region: null,
					viewerIds: [],
					streamKey: null,
				};

				if (!this.shuttingDown && this.config.selfStream && this.currentChannelId) {
					setTimeout(() => {
						void this.startStream(true);
					}, 1_500);
				}
				break;
		}
	}

	private handleDispatch(eventType: string, data: any): void {
		switch (eventType) {
			case "READY":
				this.handleReady(data);
				break;

			case "RESUMED":
				this.log("Gateway session resumed");
				void this.joinVoiceChannel();
				break;

			case "VOICE_STATE_UPDATE":
				if (data.user_id === this.currentUser?.id) {
					this.handleSelfVoiceState(data);
				}
				break;

			case "VOICE_SERVER_UPDATE":
				if (data.guild_id === this.guildId) {
					this.voiceServer.endpoint = data.endpoint ?? null;
					this.voiceServer.token = data.token ?? null;
					this.log(`Voice server update: ${data.endpoint ?? "no endpoint"}`);
				}
				break;

			case "STREAM_CREATE":
			case "STREAM_SERVER_UPDATE":
			case "STREAM_UPDATE":
			case "STREAM_DELETE":
				this.handleStreamDispatch(eventType, data);
				break;
		}
	}

	private handleGatewayMessage(payload: GatewayPayload): void {
		const { op, d, s, t } = payload;

		if (typeof s === "number") {
			this.sequenceNumber = s;
		}

		switch (op) {
			case OPCode.HELLO:
				this.log("Connected to Discord gateway");
				this.startHeartbeat(d.heartbeat_interval);
				if (this.shouldResume) {
					this.resume();
				} else {
					this.identify();
				}
				break;

			case OPCode.HEARTBEAT_ACK:
				this.heartbeatAck = true;
				break;

			case OPCode.INVALID_SESSION:
				this.log(`Invalid session received (resumable=${Boolean(d)})`);
				this.shouldResume = Boolean(d);
				void this.reconnectGateway(Boolean(d));
				break;

			case OPCode.RECONNECT:
				this.log("Gateway requested reconnect");
				void this.reconnectGateway(true);
				break;

			case OPCode.DISPATCH:
				if (t) {
					this.handleDispatch(t, d);
				}
				break;
		}
	}

	private connectGateway(resume = false): void {
		const gatewayUrl =
			resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : GATEWAY_URL;
		this.shouldResume = Boolean(resume && this.sessionId && this.sequenceNumber !== null);
		this.ws = new WebSocket(gatewayUrl);

		this.ws.onopen = () => {
			this.log(`Gateway socket opened${this.shouldResume ? " (resume)" : ""}`);
		};

		this.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data.toString()) as GatewayPayload;
				this.handleGatewayMessage(data);
			} catch (error) {
				logger.err("[JoinVC] Failed to parse gateway payload:", error);
			}
		};

		this.ws.onclose = (event) => {
			this.log(`Gateway closed: ${event.code} ${event.reason || "no reason"}`);

			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
				this.heartbeatInterval = null;
			}

			if (!this.shuttingDown) {
				void this.reconnectGateway(true);
			}
		};

		this.ws.onerror = (error) => {
			logger.err("[JoinVC] Gateway error:", error);
		};
	}

	sendStatusUpdate(status: PresenceStatus | string): void {
		const normalizedStatus = this.normalizeStatus(status);
		this.config.status = normalizedStatus;

		this.sendPayload(OPCode.STATUS_UPDATE, {
			since: null,
			activities: [],
			status: normalizedStatus,
			afk: false,
		});
	}

	async joinVoiceChannel(): Promise<boolean> {
		if (!this.targetChannelId) {
			return false;
		}

		if (!this.guildId && this.channelType !== 1 && this.channelType !== 3) {
			await this.resolveChannelMetadata();
		}

		this.log(`Joining voice channel ${this.targetChannelId} via gateway...`);

		return this.sendPayload(
			OPCode.VOICE_STATE_UPDATE,
			this.buildVoiceStatePayload({
				channel_id: this.targetChannelId,
			}),
		);
	}

	async leaveVoiceChannel(): Promise<boolean> {
		this.streamState.active = false;
		this.streamState.streamKey = null;

		return this.sendPayload(
			OPCode.VOICE_STATE_UPDATE,
			this.buildVoiceStatePayload({
				channel_id: null,
				self_video: false,
			}),
		);
	}

	async setCameraEnabled(enabled: boolean): Promise<boolean> {
		this.config.selfVideo = enabled;

		if (!this.currentChannelId) {
			return false;
		}

		this.log(`${enabled ? "Enabling" : "Disabling"} camera via VOICE_STATE_UPDATE`);

		return this.sendPayload(
			OPCode.VOICE_STATE_UPDATE,
			this.buildVoiceStatePayload({
				channel_id: this.currentChannelId,
				self_video: enabled,
			}),
		);
	}

	async startStream(startPaused = true): Promise<boolean> {
		const streamKey = this.streamKey;
		if (!streamKey || !this.currentChannelId) {
			return false;
		}

		this.config.selfStream = true;
		this.streamState.streamKey = streamKey;
		this.log(`Creating stream ${streamKey}`);

		const created = this.sendPayload(OPCode.STREAM_CREATE, {
			type: this.streamType,
			guild_id: this.guildId,
			channel_id: this.currentChannelId,
			preferred_region: null,
		});

		if (created) {
			await delay(250);
			await this.setStreamPaused(startPaused);
		}

		return created;
	}

	async setStreamPaused(paused: boolean): Promise<boolean> {
		const streamKey = this.streamKey;
		if (!streamKey) {
			return false;
		}

		this.streamState.streamKey = streamKey;
		this.streamState.paused = paused;
		this.log(`${paused ? "Pausing" : "Unpausing"} stream ${streamKey}`);

		return this.sendPayload(OPCode.STREAM_SET_PAUSED, {
			stream_key: streamKey,
			paused,
		});
	}

	async stopStream(): Promise<boolean> {
		const streamKey = this.streamState.streamKey ?? this.streamKey;
		if (!streamKey) {
			return false;
		}

		this.config.selfStream = false;
		this.log(`Deleting stream ${streamKey}`);

		const deleted = this.sendPayload(OPCode.STREAM_DELETE, {
			stream_key: streamKey,
		});

		if (deleted) {
			this.streamState.active = false;
			this.streamState.streamKey = null;
		}

		return deleted;
	}

	async initialize(): Promise<void> {
		if (!this.config.token || !this.targetChannelId) {
			throw new Error("Missing token or channelId");
		}

		this.shuttingDown = false;
		await this.resolveChannelMetadata();
		this.connectGateway(false);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.log("Shutdown requested");

		if (this.config.selfStream) {
			await this.stopStream();
		}

		await this.leaveVoiceChannel();

		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onclose = null;
			this.ws.onerror = null;

			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close(1000, "Shutdown");
			}

			this.ws = null;
		}
	}
}

export { JoinVC, OPCode, type JoinVCConfig, type PresenceStatus };
