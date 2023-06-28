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
    maxRetryAge?: number,
    debugging?: boolean
}

const defaultConfig: GoPTSClientConfig = {
    socket: undefined,
    url: undefined,
    retryDelay: 5000, // 5 seconds
    maxRetryAge: 12 * 60 * 60, // 12 hours in seconds
    exponentialRetryBackoff: true,
    debugging: false,
};

function timeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class GoPTSClient {
    private closed: boolean = false;
    private initTime: Date;
    private config: GoPTSClientConfig;
    private connectingPromise?: Promise<void>;
    private ws?: WebSocket;
    private handler: ChannelHandlerStore = {};
    private currentRetryDelay = 0;
    private subscribedChannels: string[] = [];

    constructor(config: GoPTSClientConfig = {}) {
        this.initTime = new Date();
        this.config = {
            ...defaultConfig,
            ...config
        }
    }

    private connect(delay: number = 0, isReconnect: boolean = false): Promise<void> {
        if (this.closed) return Promise.reject();
        if (!this.connectingPromise) {
            this.connectingPromise = new Promise<void>(async (res, rej) => {
                await timeout(delay);

                let promiseDone = false;
                let newSocket: WebSocket;

                if (this.config.socket != null) {
                    newSocket = this.config.socket;
                } else {
                    newSocket = new WebSocket(this.config.url!);
                }

                newSocket.onerror = (err) => {
                    this.debug("error", err);
                    if (promiseDone) return;
                    this.connectingPromise = undefined;
                    rej();
                    this.retryConnect();
                };

                const runOnSuccess = () => {
                    if (promiseDone) return;

                    this.debug("connected");
                    
                    promiseDone = true;
                    this.currentRetryDelay = 0;

                    this.addSocketHandler(newSocket);
                    this.ws = newSocket;
                    this.triggerConnectionStatusEvent(true);

                    this.connectingPromise = undefined;
                    res();
                    
                    if (isReconnect) {
                        this.handleReconnect();
                    }
                };
                
                if (newSocket.readyState == newSocket.OPEN) {
                    runOnSuccess();
                } else {
                    newSocket.onopen = runOnSuccess;
                }
            });
        }
        return this.connectingPromise!;
    }

    private addSocketHandler(socket: WebSocket) {
        socket.onmessage = (m) => {
            const data: IncommingMessage = JSON.parse(m.data);
            this.handleMessage(data);
        };

        socket.onclose = () => {
            this.triggerConnectionStatusEvent(false);
            this.debug("disconnected");
            this.ws = undefined;
            this.retryConnect();
        };
    }

    async retryConnect() {
        if (this.closed) return;

        const timeSinceInit = (new Date()).getTime() - this.initTime.getTime();
        if (this.config.maxRetryAge && timeSinceInit > this.config.maxRetryAge * 1000) {
            return;
        }

        this.currentRetryDelay = this.config.exponentialRetryBackoff ? this.currentRetryDelay * 2 : this.config.retryDelay!;
        this.connect(this.currentRetryDelay, true);
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
        this.subscribedChannels.push(channel);
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
        this.subscribedChannels = this.subscribedChannels.filter((c) => c !== channel);
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

    private async lazyInit(): Promise<void> {
        if (this.ws) {
            return;
        }

        if (this.connectingPromise) {
            this.debug("waiting for lazy init");
            await this.connectingPromise;
            return;
        }

        this.debug("lazy init");
        return this.connect(0, false);
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

    private async handleReconnect(): Promise<void> {
        this.debug("reconnected");

        // Re-Subscribe to all channels
        for (const channel of this.subscribedChannels) {
            await this.send(channel, {
                type: RealtimeMessageTypes.RealtimeMessageTypeSubscribe,
            });
            this.debug("Re-Subscribed", channel);
        }
    }

    public async close() {
        this.debug("closing");
        this.closed = true;
        if (this.connectingPromise) {
            await this.connectingPromise;
        }
        if (this.ws) {
            this.ws.close();
        }
        this.debug("closed");
    }
}
