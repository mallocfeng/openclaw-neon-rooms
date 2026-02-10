import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { IncomingForm, type Fields, type File as FormidableFile, type Files, type Part } from "formidable";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [react(), uploadsApiPlugin()],
});
