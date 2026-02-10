type JsonRecord = Record<string, unknown>;

const DEVICE_STORE_KEY = "openclaw.gateway.device.v1";
const WS_CONNECT_TIMEOUT_MS = 700;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function supportsEd25519(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(bytes.length);
  normalized.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized);
  return bytesToHex(new Uint8Array(digest));
}

type StoredDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};

async function importStoredPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function createAndPersistDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (!supportsEd25519()) {
    return null;
  }

  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    );
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    const publicKey = toBase64Url(publicRaw);
    const deviceId = await sha256Hex(publicRaw);

    const stored: StoredDeviceIdentity = {
      deviceId,
      publicKey,
      privateKeyJwk,
    };
    localStorage.setItem(DEVICE_STORE_KEY, JSON.stringify(stored));

    return {
      deviceId,
      publicKey,
      privateKey: keyPair.privateKey,
    };
  } catch {
    return null;
  }
}

async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (!supportsEd25519()) {
    return null;
  }

  try {
    const raw = localStorage.getItem(DEVICE_STORE_KEY);
    if (!raw) {
      return createAndPersistDeviceIdentity();
    }

    const stored = JSON.parse(raw) as StoredDeviceIdentity;
    if (
      typeof stored.deviceId !== "string" ||
      typeof stored.publicKey !== "string" ||
      !isRecord(stored.privateKeyJwk)
    ) {
      return createAndPersistDeviceIdentity();
    }

    const privateKey = await importStoredPrivateKey(stored.privateKeyJwk);
    const normalizedPublicKey = toBase64Url(fromBase64Url(stored.publicKey));
    return {
      deviceId: stored.deviceId,
      publicKey: normalizedPublicKey,
      privateKey,
    };
  } catch {
    return createAndPersistDeviceIdentity();
  }
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce?: string;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const payload = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
  ];

  if (version === "v2") {
    payload.push(params.nonce ?? "");
  }

  return payload.join("|");
}

async function signDevicePayload(privateKey: CryptoKey, payload: string): Promise<string> {
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
  return toBase64Url(new Uint8Array(signature));
}

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    message?: string;
  };
};

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayFrame = GatewayResponseFrame | GatewayEventFrame;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type SnapshotSessionDefaults = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

type SnapshotShape = {
  sessionDefaults?: SnapshotSessionDefaults;
};

export type HelloOkPayload = {
  type: "hello-ok";
  protocol: number;
  features?: {
    methods?: string[];
    events?: string[];
  };
  snapshot?: SnapshotShape;
  policy?: {
    tickIntervalMs?: number;
  };
};

type ClientOptions = {
  url: string;
  token?: string;
  clientId?: string;
  clientVersion?: string;
  onHello?: (hello: HelloOkPayload) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
};

export class OpenClawGatewayClient {
  private readonly options: ClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<(frame: GatewayEventFrame) => void>();
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private disposed = false;
  private deviceIdentityPromise: Promise<DeviceIdentity | null> | null = null;
  private readonly instanceId = createId();
  hello: HelloOkPayload | null = null;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stop();
    this.disposed = false;
    this.hello = null;
    this.ws = new WebSocket(this.options.url);
    this.ws.addEventListener("open", this.handleOpen);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose);
    this.ws.addEventListener("error", this.handleSocketError);
  }

  stop(): void {
    this.disposed = true;
    this.clearConnectTimer();
    this.connectSent = false;
    this.connectNonce = null;
    if (this.ws) {
      this.ws.close(1000, "client stop");
      this.ws = null;
    }
    this.flushPending(new Error("gateway client stopped"));
  }

  onEvent(handler: (frame: GatewayEventFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }

    const id = createId();
    const frame: GatewayRequestFrame = {
      type: "req",
      id,
      method,
      params,
    };

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.ws.send(JSON.stringify(frame));
    return promise;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private flushPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private readonly handleOpen = (): void => {
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, WS_CONNECT_TIMEOUT_MS);
  };

  private readonly handleSocketError = (): void => {
    this.options.onError?.(new Error("websocket transport error"));
  };

  private readonly handleClose = (event: CloseEvent): void => {
    this.clearConnectTimer();
    this.connectSent = false;
    this.connectNonce = null;
    this.flushPending(new Error(`gateway closed (${event.code}): ${event.reason || "no reason"}`));
    this.ws = null;
    if (!this.disposed) {
      this.options.onClose?.(event.code, event.reason || "");
    }
  };

  private readonly handleMessage = (event: MessageEvent<string>): void => {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (frame.type === "event") {
      if (frame.event === "connect.challenge" && isRecord(frame.payload)) {
        const nonce = frame.payload.nonce;
        if (typeof nonce === "string" && nonce.length > 0) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
      }

      for (const handler of this.eventHandlers) {
        handler(frame);
      }
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }

    let message = "request failed";
    if (isRecord(frame.error) && typeof frame.error.message === "string") {
      message = frame.error.message;
    }
    pending.reject(new Error(message));
  };

  private async getDeviceIdentity(): Promise<DeviceIdentity | null> {
    if (!this.deviceIdentityPromise) {
      this.deviceIdentityPromise = loadOrCreateDeviceIdentity();
    }
    return this.deviceIdentityPromise;
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.connectSent = true;
    this.clearConnectTimer();

    const clientId = this.options.clientId ?? "webchat-ui";
    const clientMode = "webchat";
    const role = "operator";
    const scopes = ["operator.admin"];
    const token = this.options.token?.trim() || null;
    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce?: string;
        }
      | undefined;

    try {
      const identity = await this.getDeviceIdentity();
      if (identity) {
        const signedAt = Date.now();
        const payload = buildDeviceAuthPayload({
          deviceId: identity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs: signedAt,
          token,
          nonce: this.connectNonce ?? undefined,
        });
        const signature = await signDevicePayload(identity.privateKey, payload);
        device = {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature,
          signedAt,
          nonce: this.connectNonce ?? undefined,
        };
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }

    const connectParams: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: this.options.clientVersion ?? "0.1.0",
        platform: navigator.platform || "web",
        mode: clientMode,
        instanceId: this.instanceId,
      },
      role,
      scopes,
      caps: [],
      locale: navigator.language,
      userAgent: navigator.userAgent,
    };

    if (token) {
      connectParams.auth = { token };
    }
    if (device) {
      connectParams.device = device;
    }

    try {
      const hello = await this.request<HelloOkPayload>("connect", connectParams);
      this.hello = hello;
      this.options.onHello?.(hello);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.ws?.close(4008, "connect failed");
    }
  }
}
