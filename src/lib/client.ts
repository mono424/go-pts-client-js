const PAGE_LOADED = new Date();

// eslint-disable-next-line no-explicit-any
type MessageHandlerFn = (payload: any) => void;

const RealtimeMessageTypes = {
    RealtimeMessageTypeSubscribe: "subscribe",
    RealtimeMessageTypeUnsubscribe: "unsubscribe",
    RealtimeMessageTypeChannelMessage: "message",
};

interface ChannelHandlerStore {
    [key: string]: MessageHandlerFn[]
}

export interface IncommingMessage {
    channel: string
    payload: any
}

export interface GoPTSClientConfig {
    socket?: WebSocket
    url?: string
    retryDelay?: number
    exponentialRetryBackoff?: boolean
    debugging?: boolean
}

const defaultConfig: GoPTSClientConfig = {
    socket: undefined,
    url: undefined,
    retryDelay: 5000,
    exponentialRetryBackoff: true,
    debugging: false,
};

export class GoPTSClient {
    private config: GoPTSClientConfig
    private connectingPromise?: Promise<void>;
    private ws?: WebSocket;
    private handler: ChannelHandlerStore = {};

    constructor(config: GoPTSClientConfig = {}) {
        this.config = {
            ...defaultConfig,
            ...config
        }
    }

    public connect(): Promise<void> {
        return this._connect(this.config.retryDelay!)
    }

    private _connect(retryDelay: number): Promise<void> {
        if (!this.connectingPromise) {
            this.connectingPromise = new Promise<void>((res) => {
                let promiseDone = false;

                if (this.config.socket != null) {
                    this.ws = this.config.socket;
                } else {
                    this.ws = new WebSocket(this.config.url!);
                }

                this.ws.onmessage = (m) => {
                    const data: IncommingMessage = JSON.parse(m.data);
                    this.handleMessage(data);
                };

                this.ws.onclose = () => {
                    this.triggerConnectionStatusEvent(false);
                    this.debug("disconnected");
                    // connection closed, discard old websocket and create a new one after backoff
                    // don't recreate new connection if page has been loaded more than 12 hours ago
                    if (new Date().valueOf() - PAGE_LOADED.valueOf() > 1000 * 60 * 60 * 12) {
                        return;
                    }

                    this.ws = undefined;
                    setTimeout(
                        () => this._connect(this.config.exponentialRetryBackoff ? retryDelay * 2: retryDelay), // Exponential Backoff
                        retryDelay,
                    );
                };

                this.ws.onerror = (err) => {
                    this.debug("error", err);
                };
                
                if (this.ws.readyState == this.ws.OPEN) {
                    this.afterConnect();
                    this.triggerConnectionStatusEvent(true);
                    if (!promiseDone) {
                        promiseDone = true;
                        this.connectingPromise = undefined;
                        res();
                    }
                } else {
                    this.ws.onopen = () => {
                        this.afterConnect();
                        this.triggerConnectionStatusEvent(true);
                        if (!promiseDone) {
                            promiseDone = true;
                            this.connectingPromise = undefined;
                            res();
                        }
                    };
                }
            });
        }
        return this.connectingPromise!;
    }

    async send(channel: string, { payload = {}, type = RealtimeMessageTypes.RealtimeMessageTypeChannelMessage }) {
        await this.lazyInit();
        await this.ws!.send(
            JSON.stringify({
                type: type,
                channel: channel,
                payload: payload,
            }),
        );
        this.debug("🔵 Send", { type, channel, payload });
    }

    public async subscribeChannel(channel: string, handler?: MessageHandlerFn) {
        await this.lazyInit();
        if (handler) this.registerHandler(channel, handler);
        await this.send(channel, {
            type: RealtimeMessageTypes.RealtimeMessageTypeSubscribe,
        });
        this.debug("Subscribed", channel);
    }

    public async unsubscribeChannel(channel: string, { unregisterHandler = true }) {
        await this.lazyInit();
        if (unregisterHandler) {
            delete this.handler[channel];
        }
        await this.send(channel, {
            type: RealtimeMessageTypes.RealtimeMessageTypeUnsubscribe,
        });
        this.debug("Unsubscribed", channel);
    }

    public registerHandler(channel: string, handler: MessageHandlerFn) {
        if (!this.handler[channel]) this.handler[channel] = [];
        this.handler[channel].push(handler);
    }

    public unregisterHandler(channel: string, handler: MessageHandlerFn) {
        if (this.handler[channel]) {
            this.handler[channel] = this.handler[channel].filter((fn) => fn === handler);
        }
    }

    private async lazyInit() {
        if (this.connectingPromise) {
            this.debug("waiting for lazy init");
            await this.connectingPromise;
            return this.ws;
        }

        this.debug("lazy init");
        return this.connect();
    }

    private handleMessage({ channel, payload } : IncommingMessage) {
        this.debug("⚪️️ Received", { channel, payload });
        if (this.handler[channel]) {
            for (const handler of this.handler[channel]) {
                handler(payload);
            }
        }
    }

    private debug(description: string, ...data: any[]) {
        if (!this.config.debugging) return;
        console.info("[WS_REALTIME_DEBUG]", description, ...data);
    }

    private triggerConnectionStatusEvent(status: boolean) {
        const event = new CustomEvent("wsrealtimeconnectionchange", { detail: { status } });
        window.dispatchEvent(event);
    }

    private async afterConnect(): Promise<void> {
        this.debug("connected");

        // Re-Subscribe to all channels
        for (const channel of Object.keys(this.handler)) {
            await this.send(channel, {
                type: RealtimeMessageTypes.RealtimeMessageTypeSubscribe,
            });
            this.debug("Re-Subscribed", channel);
        }
    }
}
