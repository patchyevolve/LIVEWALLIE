import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { EMPTY_STATE, isSceneState, type SceneState } from "./sceneState.js";

const BACKOFF_STEPS = [1, 2, 4, 8, 10]; // seconds
const STALE_AFTER_MS = 5000; // no update for 5s -> degrade toward idle

/**
 * IPC client for the sampler's Unix socket ($XDG_RUNTIME_DIR/live-wallpaper/scene.sock).
 *
 * - Consumes the sampler's two-rate stream as-is: the latest SceneState is kept
 *   and renderers sample it at their own frame rate. Nothing here forces
 *   telemetry to audio cadence (or vice versa).
 * - Reconnect policy per contract §5: 1s, 2s, 4s, 8s, 10s backoff, then hold
 *   at 10s. Never throws; all failures are logged via console.warn.
 */
export class SceneClient {
    private _path: string;
    private _client: Gio.SocketClient | null = null;
    private _connection: Gio.SocketConnection | null = null;
    private _input: Gio.DataInputStream | null = null;
    private _cancellable: Gio.Cancellable;
    private _retryTimeoutId: number | null = null;
    private _retryStep = 0;
    private _destroyed = false;

    private _state: SceneState = EMPTY_STATE;
    private _lastUpdateMs = 0;
    // Latest pulse batch + id. Every layer polls for new batches itself, so
    // all monitors apply the SAME pulses (no one drains the queue for others).
    private _pulseBatch: SceneState["pulses"] = [];
    private _pulseBatchId = 0;
    private _lastStreams: SceneState["streams"] = [];

    private _onState: ((state: SceneState) => void) | null = null;
    private _onConnectionChange: ((connected: boolean) => void) | null = null;

    constructor(socketPath: string) {
        this._path = socketPath;
        this._cancellable = new Gio.Cancellable();
    }

    /** Called with every validated SceneState as it arrives. */
    setOnState(cb: (state: SceneState) => void) {
        this._onState = cb;
    }

    /** Called on connect/disconnect (for logging/debug only). */
    setOnConnectionChange(cb: (connected: boolean) => void) {
        this._onConnectionChange = cb;
    }

    connect() {
        this._connectOnce();
    }

    private _connectOnce() {
        if (this._destroyed) return;
        try {
            const address = Gio.UnixSocketAddress.new(this._path);
            const client = new Gio.SocketClient();
            client.connect_async(address, this._cancellable, (c, res) => {
                if (this._destroyed) return;
                try {
                    const connection = c?.connect_finish(res);
                    if (connection) {
                        this._onConnected(connection);
                    } else {
                        this._scheduleRetry();
                    }
                } catch (e) {
                    this._scheduleRetry();
                }
            });
            this._client = client;
        } catch (e) {
            console.warn(
                `[live-wallpaper] socket connect failed: ${e}; retrying`
            );
            this._scheduleRetry();
        }
    }

    private _onConnected(connection: Gio.SocketConnection) {
        this._connection = connection;
        this._retryStep = 0;
        this._input = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
            close_base_stream: true,
        });
        this._onConnectionChange?.(true);
        this._readLine();
    }

    private _readLine() {
        if (this._destroyed || !this._input) return;
        this._input.read_line_async(0, this._cancellable, (input, res) => {
            if (this._destroyed) return;
            try {
                const [line] = input?.read_line_finish(res) ?? [null];
                if (line === null) {
                    // EOF: server closed the socket (shutdown/restart).
                    this._onDisconnected();
                    return;
                }
                this._handleLine(new TextDecoder().decode(line));
                this._readLine();
            } catch (e) {
                this._onDisconnected();
            }
        });
    }

    private _handleLine(line: string) {
        if (!line) return;
        try {
            const msg = JSON.parse(line);
            // The sampler publishes plain SceneState JSON. A wrapped form
            // {type: "scene_update", body: SceneState} is also tolerated.
            const body = msg?.type === "scene_update" ? msg.body ?? msg : msg;
            if (isSceneState(body)) {
                this._state = body;
                this._lastUpdateMs = Date.now();
                if (body.pulses.length > 0) {
                    this._pulseBatch = body.pulses;
                    this._pulseBatchId++;
                }
                this._lastStreams = body.streams;
                this._onState?.(body);
            }
        } catch (e) {
            console.warn(`[live-wallpaper] bad IPC line: ${e}`);
        }
    }

    private _onDisconnected() {
        if (this._destroyed) return;
        this._closeConnection();
        this._onConnectionChange?.(false);
        this._scheduleRetry();
    }

    private _closeConnection() {
        try {
            this._input?.close(null);
        } catch (e) {}
        try {
            this._connection?.close(null);
        } catch (e) {}
        this._input = null;
        this._connection = null;
    }

    private _scheduleRetry() {
        if (this._destroyed || this._retryTimeoutId !== null) return;
        const delay = BACKOFF_STEPS[Math.min(this._retryStep, BACKOFF_STEPS.length - 1)];
        this._retryStep++;
        this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryTimeoutId = null;
            if (!this._destroyed) this._connectOnce();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Latest validated SceneState; never null after construction. */
    getState(): SceneState {
        return this._state;
    }

    /** True if no SceneState arrived within the last 5s. */
    isStale(): boolean {
        return this._lastUpdateMs > 0 && Date.now() - this._lastUpdateMs > STALE_AFTER_MS;
    }

    /** Latest pulse batch, plus its id. Pass the id you last applied to detect new beats. */
    getPulseBatch(lastAppliedId: number): { id: number; pulses: SceneState["pulses"] } {
        return { id: this._pulseBatchId, pulses: this._pulseBatch };
    }

    /** Current stream state (replaced wholesale by each publish). */
    getStreams() {
        return this._lastStreams;
    }

    destroy() {
        this._destroyed = true;
        if (this._retryTimeoutId !== null) {
            GLib.source_remove(this._retryTimeoutId);
            this._retryTimeoutId = null;
        }
        this._cancellable.cancel();
        this._closeConnection();
        this._client = null;
        this._onState = null;
        this._onConnectionChange = null;
    }
}