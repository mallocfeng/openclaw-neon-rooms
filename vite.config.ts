import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { IncomingForm, type Fields, type File as FormidableFile, type Files, type Part } from "formidable";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type UploadManifestItem = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  uploadedAt: string;
};

type DevRequest = IncomingMessage & { url?: string; method?: string };
type DevResponse = ServerResponse<IncomingMessage>;
type NextHandler = (error?: Error) => void;

const workspaceRoot = process.cwd();
const uploadRootDir = path.resolve(workspaceRoot, "uploads");
const uploadFilesDir = path.resolve(uploadRootDir, "files");
const uploadLogPath = path.resolve(uploadRootDir, "uploads-log.jsonl");
const roomsConfigPath = path.resolve(uploadRootDir, "rooms.json");
const roomsBackupDir = path.resolve(uploadRootDir, "rooms-backups");
const gatewayProxyPath = "/api/gateway/ws";

function sanitizeFileName(name: string): string {
  const stripped = name.replace(/[/\\?%*:|"<>]/g, "-").trim();
  return stripped || "file";
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function collectFiles(files: Files): FormidableFile[] {
  const result: FormidableFile[] = [];
  for (const value of Object.values(files)) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      result.push(...value);
      continue;
    }
    result.push(value);
  }
  return result;
}

function sendJson(res: DevResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: DevRequest): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

async function appendUploadLog(items: UploadManifestItem[]): Promise<void> {
  if (items.length === 0) {
    return;
  }
  await fs.mkdir(uploadRootDir, { recursive: true });
  const lines = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await fs.appendFile(uploadLogPath, lines, "utf8");
}

function createUploadMiddleware() {
  return (req: DevRequest, res: DevResponse, next: NextHandler): void => {
    const requestUrl = req.url ?? "/";
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    if (!(pathname === "/api/uploads" || pathname.endsWith("/api/uploads"))) {
      next();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return;
    }

    const run = async () => {
      await fs.mkdir(uploadFilesDir, { recursive: true });
      let responded = false;
      const reply = (statusCode: number, payload: unknown) => {
        if (responded || res.writableEnded) {
          return;
        }
        responded = true;
        sendJson(res, statusCode, payload);
      };
      const form = new IncomingForm({
        multiples: true,
        keepExtensions: true,
        uploadDir: uploadFilesDir,
        maxFiles: 20,
        maxFileSize: 25 * 1024 * 1024,
        filename: (_name: string, _ext: string, part: Part) => {
          const originalName = sanitizeFileName(part.originalFilename ?? "file");
          return `${Date.now()}-${randomUUID()}-${originalName}`;
        },
      });

      form.parse(req, (error: Error | null, _fields: Fields, files: Files) => {
        if (error) {
          reply(400, { ok: false, error: `上传失败: ${error.message}` });
          return;
        }

        void (async () => {
          const uploadedFiles = collectFiles(files);
          if (uploadedFiles.length === 0) {
            reply(400, { ok: false, error: "未接收到文件" });
            return;
          }

          const now = new Date().toISOString();
          const resultFiles: UploadManifestItem[] = uploadedFiles.map((file) => {
            const absolutePath = path.resolve(file.filepath);
            const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));
            return {
              id: randomUUID(),
              fileName: sanitizeFileName(file.originalFilename ?? path.basename(absolutePath)),
              mimeType: file.mimetype ?? "application/octet-stream",
              size: file.size,
              relativePath,
              absolutePath,
              uploadedAt: now,
            };
          });

          await appendUploadLog(resultFiles);
          reply(200, { ok: true, files: resultFiles });
        })().catch((callbackError: unknown) => {
          const message = callbackError instanceof Error ? callbackError.message : String(callbackError);
          reply(500, { ok: false, error: `上传处理异常: ${message}` });
        });
      });
    };

    void run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: `上传服务异常: ${message}` });
    });
  };
}

function matchesApiPath(requestUrl: string | undefined, suffix: string): boolean {
  const pathname = new URL(requestUrl ?? "/", "http://localhost").pathname;
  return pathname === suffix || pathname.endsWith(suffix);
}

function uploadsApiPlugin(): Plugin {
  const middleware = createUploadMiddleware();
  return {
    name: "openclaw-uploads-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

type StoredRoom = {
  id: string;
  name: string;
  agentId: string;
};

function sanitizeRoomsPayload(value: unknown): StoredRoom[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: StoredRoom[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      continue;
    }
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
    const agentId = typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : "main";
    result.push({ id, name, agentId });
  }
  return result;
}

async function readStoredRooms(): Promise<StoredRoom[]> {
  try {
    const raw = await fs.readFile(roomsConfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    return sanitizeRoomsPayload(record.rooms);
  } catch {
    return [];
  }
}

async function writeStoredRooms(rooms: StoredRoom[]): Promise<void> {
  await fs.mkdir(uploadRootDir, { recursive: true });
  try {
    const existing = await fs.readFile(roomsConfigPath, "utf8");
    if (existing.trim()) {
      await fs.mkdir(roomsBackupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(roomsBackupDir, `rooms-${stamp}.json`);
      await fs.writeFile(backupPath, existing, "utf8");

      const backupEntries = await fs.readdir(roomsBackupDir);
      const roomBackups = backupEntries
        .filter((name) => name.startsWith("rooms-") && name.endsWith(".json"))
        .sort()
        .reverse();
      const keepLimit = 20;
      if (roomBackups.length > keepLimit) {
        for (const fileName of roomBackups.slice(keepLimit)) {
          await fs.rm(path.join(roomsBackupDir, fileName), { force: true });
        }
      }
    }
  } catch {
    // Ignore missing previous file.
  }

  const payload = JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      rooms,
    },
    null,
    2,
  );
  await fs.writeFile(roomsConfigPath, `${payload}\n`, "utf8");
}

function createRoomsMiddleware() {
  return (req: DevRequest, res: DevResponse, next: NextHandler): void => {
    const requestUrl = req.url ?? "/";
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    if (!(pathname === "/api/rooms" || pathname.endsWith("/api/rooms"))) {
      next();
      return;
    }

    const run = async () => {
      if (req.method === "GET") {
        const rooms = await readStoredRooms();
        sendJson(res, 200, { ok: true, rooms });
        return;
      }
      if (req.method === "POST" || req.method === "PUT") {
        const body = await readJsonBody(req);
        const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const rooms = sanitizeRoomsPayload(payload.rooms);
        await writeStoredRooms(rooms);
        sendJson(res, 200, { ok: true, rooms });
        return;
      }
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    };

    void run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: `房间配置服务异常: ${message}` });
    });
  };
}

function roomsApiPlugin(): Plugin {
  const middleware = createRoomsMiddleware();
  return {
    name: "openclaw-rooms-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function gatewayWsProxyPlugin(options: { target: string; pathSuffix?: string; upstreamOrigin?: string }): Plugin {
  const target = options.target.trim() || "ws://127.0.0.1:18789";
  const pathSuffix = options.pathSuffix ?? gatewayProxyPath;
  const attachedServers = new WeakSet<object>();

  type UpgradeCapableServer = {
    on(event: "upgrade", listener: (request: IncomingMessage, socket: Socket, head: Buffer) => void): void;
  };

  const wireUpgrades = (httpServer: unknown) => {
    if (!httpServer || typeof httpServer !== "object" || attachedServers.has(httpServer)) {
      return;
    }
    const server = httpServer as Partial<UpgradeCapableServer>;
    if (typeof server.on !== "function") {
      return;
    }
    attachedServers.add(httpServer);

    const inboundWss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (!matchesApiPath(request.url, pathSuffix)) {
        return;
      }
      inboundWss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        inboundWss.emit("connection", websocket, request);
      });
    });

    inboundWss.on("connection", (clientSocket: WebSocket, request: IncomingMessage) => {
      const requestUrl = new URL(request.url ?? pathSuffix, "http://localhost");
      const targetUrl = new URL(target);
      targetUrl.search = requestUrl.search;
      const upstreamOrigin =
        options.upstreamOrigin?.trim() ||
        `${targetUrl.protocol === "wss:" ? "https" : "http"}://${targetUrl.host}`;
      const upstreamSocket = new WebSocket(targetUrl.toString(), { origin: upstreamOrigin });
      const pendingToUpstream: Array<{ data: RawData; isBinary: boolean }> = [];
      let closed = false;

      const closeBoth = (code = 1011, reason = "ws proxy closed") => {
        if (closed) {
          return;
        }
        closed = true;
        if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
          clientSocket.close(code, reason);
        }
        if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
          upstreamSocket.close();
        }
      };

      clientSocket.on("message", (data: RawData, isBinary: boolean) => {
        if (upstreamSocket.readyState === WebSocket.OPEN) {
          upstreamSocket.send(data, { binary: isBinary });
          return;
        }
        if (upstreamSocket.readyState === WebSocket.CONNECTING) {
          pendingToUpstream.push({ data, isBinary });
        }
      });

      upstreamSocket.on("message", (data: RawData, isBinary: boolean) => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(data, { binary: isBinary });
        }
      });

      upstreamSocket.on("open", () => {
        for (const frame of pendingToUpstream.splice(0, pendingToUpstream.length)) {
          if (upstreamSocket.readyState !== WebSocket.OPEN) {
            break;
          }
          upstreamSocket.send(frame.data, { binary: frame.isBinary });
        }
      });

      clientSocket.on("close", () => closeBoth(1000, "client closed"));
      upstreamSocket.on("close", () => closeBoth(1000, "upstream closed"));
      clientSocket.on("error", () => closeBoth(1011, "client socket error"));
      upstreamSocket.on("error", () => closeBoth(1011, "upstream socket error"));
    });
  };

  return {
    name: "openclaw-gateway-ws-proxy",
    configureServer(server) {
      wireUpgrades(server.httpServer);
    },
    configurePreviewServer(server) {
      wireUpgrades(server.httpServer);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, "");
  const gatewayTarget =
    env.OPENCLAW_GATEWAY_WS_URL?.trim() || env.VITE_OPENCLAW_WS_URL?.trim() || "ws://127.0.0.1:18789";
  const gatewayUpstreamOrigin = env.OPENCLAW_GATEWAY_WS_ORIGIN?.trim();

  return {
    plugins: [
      react(),
      uploadsApiPlugin(),
      roomsApiPlugin(),
      gatewayWsProxyPlugin({
        target: gatewayTarget,
        pathSuffix: gatewayProxyPath,
        upstreamOrigin: gatewayUpstreamOrigin,
      }),
    ],
  };
});
