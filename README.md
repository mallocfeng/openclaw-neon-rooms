# OpenClaw Neon Rooms

Language / 语言: [English](#english) | [中文](#中文)

---

## English

A futuristic web chat client for OpenClaw Gateway.

This app provides a 3D robot scene, room-based agent routing, real-time Q&A, and image/file attachments.

### Features

- Direct WebSocket connection to OpenClaw Gateway
- Token-based authentication
- Room system with per-room agent binding
- Persistent room settings in browser local storage
- 3D robot scene (React + Three.js)
- Real-time chat streaming (`delta` / `final`)
- Paste image from clipboard into input
- Drag-and-drop file upload into composer
- Attachment storage in local project directory
- In-chat image preview and fullscreen modal
- Agent model labels in room cards

### Tech Stack

- React 19 + TypeScript
- Vite 7
- Three.js via `@react-three/fiber` + `@react-three/drei`
- Native WebSocket Gateway protocol client

### Architecture

- `src/lib/openclawGateway.ts`: Gateway transport + protocol handshake
- `src/hooks/useOpenClawChat.ts`: connection/chat/session state management
- `src/components/FutureScene.tsx`: 3D robot scene
- `src/App.tsx`: layout, room settings, chat UI, upload interactions
- `vite.config.ts`: local upload API middleware (`/api/uploads`)

### Requirements

- Node.js 18+ (recommended 20+)
- npm 9+
- Local OpenClaw Gateway running (default: `ws://127.0.0.1:18789`)
- Valid Gateway token

### Installation

```bash
npm install
```

### Configuration

Create local config from template:

```bash
cp .env.example .env
```

Then edit `.env`:

```env
VITE_OPENCLAW_WS_URL=ws://127.0.0.1:18789
VITE_OPENCLAW_TOKEN=your_token_here
```

You can also edit URL/token directly in the app header.

### Run

```bash
npm run dev
```

Default URL:

- http://localhost:5173

### Build

```bash
npm run build
npm run preview
```

### Lint

```bash
npm run lint
```

### Attachment Storage

Uploaded files are saved under project root:

- `uploads/files/` (binary files)
- `uploads/uploads-log.jsonl` (append-only upload log)

### Room and Agent Flow

- `main` room always exists
- Each room maps to exactly one agent
- Switching room switches active agent session
- If no custom room is configured, `main` room is used

### Gateway Protocol Coverage

Implemented flow includes:

- `connect.challenge` -> signed `connect`
- `hello-ok` handshake handling
- `chat.send` (text + image attachments)
- `chat.history` backfill
- `chat` event stream handling (`delta`, `final`, `aborted`, `error`)
- `agents.list`, `sessions.list`, `sessions.resolve`

### Troubleshooting

- `HTTP 404` on upload:
  - start app with `npm run dev` (or `npm run preview`) so `/api/uploads` middleware is available
- Connection error:
  - verify Gateway URL/token and local gateway status
- Image understanding error from model:
  - this usually indicates provider/model-side image validation or quota limits, not local upload failure

### Security Notes

- Do not commit real tokens
- Keep `.env` private
- Use least-privileged Gateway tokens where possible

---

## 中文

一个面向 OpenClaw Gateway 的未来感 Web 聊天客户端。

这个应用提供 3D 机器人场景、房间与 Agent 绑定、实时问答，以及图片/附件上传能力。

### 功能特性

- 直接通过 WebSocket 连接 OpenClaw Gateway
- Token 鉴权连接
- 房间系统（每个房间绑定一个 Agent）
- 房间配置持久化到浏览器本地存储
- 3D 机器人场景（React + Three.js）
- 实时流式对话（`delta` / `final`）
- 输入框支持剪贴板粘贴图片
- 输入区支持拖拽文件上传
- 附件保存到项目本地目录
- 对话区支持图片缩略图与大图预览
- 房间卡片展示对应模型信息

### 技术栈

- React 19 + TypeScript
- Vite 7
- Three.js（`@react-three/fiber` + `@react-three/drei`）
- 原生 WebSocket Gateway 协议客户端

### 项目结构

- `src/lib/openclawGateway.ts`：Gateway 传输与握手协议
- `src/hooks/useOpenClawChat.ts`：连接、会话、对话状态管理
- `src/components/FutureScene.tsx`：3D 机器人场景
- `src/App.tsx`：布局、房间设置、聊天 UI、上传交互
- `vite.config.ts`：本地上传 API 中间件（`/api/uploads`）

### 环境要求

- Node.js 18+（推荐 20+）
- npm 9+
- 本地已启动 OpenClaw Gateway（默认 `ws://127.0.0.1:18789`）
- 可用的 Gateway token

### 安装

```bash
npm install
```

### 配置

先从模板复制：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
VITE_OPENCLAW_WS_URL=ws://127.0.0.1:18789
VITE_OPENCLAW_TOKEN=your_token_here
```

也可以在页面顶部直接填写 URL 与 Token。

### 启动

```bash
npm run dev
```

默认访问地址：

- http://localhost:5173

### 构建与预览

```bash
npm run build
npm run preview
```

### 代码检查

```bash
npm run lint
```

### 附件存储位置

上传文件会保存到项目目录下：

- `uploads/files/`（二进制文件）
- `uploads/uploads-log.jsonl`（上传日志，追加写入）

### 房间与 Agent 机制

- `main` 房间始终存在
- 每个房间只能绑定一个 Agent
- 切换房间会切换对应 Agent 会话
- 未配置自定义房间时，默认使用 `main`

### Gateway 协议支持范围

已实现的协议流程包括：

- `connect.challenge` -> 签名 `connect`
- `hello-ok` 握手处理
- `chat.send`（文本 + 图片附件）
- `chat.history` 历史回填
- `chat` 事件流处理（`delta`、`final`、`aborted`、`error`）
- `agents.list`、`sessions.list`、`sessions.resolve`

### 常见问题

- 上传返回 `HTTP 404`：
  - 请使用 `npm run dev`（或 `npm run preview`）启动，确保 `/api/uploads` 中间件可用
- 连接失败：
  - 检查 Gateway URL、token、以及本地网关状态
- 模型报图片无效：
  - 通常是模型/服务商侧的图片校验或配额问题，不是本地上传失败

### 安全建议

- 不要提交真实 token
- `.env` 仅本地使用
- 尽量使用最小权限的 Gateway token
