# Zeabur Mail

一个用于接收临时邮件的轻量服务，基于 `Express + SQLite + JWT`，适合配合 Business Gemini 或类似场景使用。

项目提供：

- 临时邮箱创建与登录
- 邮件列表查询与详情查看
- Webhook 收信入口
- Cloudflare Email Routing Worker 转发
- SQLite 本地持久化
- 简单 Web 界面

## 项目结构

```text
.
├─ src/index.js              # 主服务，API + Web UI
├─ cloudflare-worker.js      # Cloudflare Email Worker
├─ data/                     # SQLite 数据目录
├─ Dockerfile
└─ README.md
```

## 环境要求

- Node.js `>= 18`
- 可写数据目录
- 一个可用于收信的域名

## 环境变量

| 变量名 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务监听端口 | `3000` |
| `JWT_SECRET` | JWT 密钥，生产环境必须修改 | `your-secret-key-change-in-production` |
| `DATA_DIR` | SQLite 数据目录 | `./data` |
| `MAIL_DOMAIN` | 临时邮箱域名 | `tempmail.example.com` |

## 本地运行

```bash
npm install
npm run dev
```

访问：`http://localhost:3000`

## API 概览

### 创建邮箱

```http
POST /api/mailboxes
```

响应示例：

```json
{
  "id": "mailbox-id",
  "address": "abcd1234@example.com",
  "token": "jwt-token",
  "url": "https://your-domain/?jwt=jwt-token"
}
```

### 邮箱登录

```http
POST /api/login
Content-Type: application/json
```

请求体：

```json
{
  "address": "abcd1234@example.com",
  "password": "mailbox-password"
}
```

### 获取邮件列表

```http
GET /api/emails?jwt=<token>&limit=50&offset=0
```

### 获取单封邮件

```http
GET /api/emails/:id?jwt=<token>
```

### 删除邮件

```http
DELETE /api/emails/:id?jwt=<token>
```

### Webhook 收信

```http
POST /api/webhook/receive
Content-Type: application/json
```

请求体：

```json
{
  "to": "user@example.com",
  "from": "sender@example.com",
  "from_name": "Sender",
  "subject": "Hello",
  "text": "Plain text body",
  "html": "<p>HTML body</p>"
}
```

### 调试接口

```http
GET /api/debug/mailboxes
```

### 发送测试邮件

```http
POST /api/test/send
Content-Type: application/json
```

请求体：

```json
{
  "to": "user@example.com",
  "from": "test@example.com",
  "subject": "Test mail",
  "text": "Hello",
  "code": 123456
}
```

## Cloudflare Email Routing 配置

这个项目本身不是 SMTP 服务，它依赖第三方收信入口把邮件转成 HTTP 请求送到 `/api/webhook/receive`。当前仓库内置了 Cloudflare Worker 方案。

### 1. 配置 Email Routing

1. 打开 Cloudflare Dashboard。
2. 选择你的域名。
3. 进入 `Email > Email Routing`。
4. 开启 Email Routing。
5. 按 Cloudflare 提示添加并验证 MX 记录。

### 2. 创建 Worker

1. 进入 `Workers & Pages`。
2. 创建一个 Worker。
3. 把仓库中的 `cloudflare-worker.js` 内容复制进去。
4. 如需自定义后端地址，给 Worker 配置环境变量 `WEBHOOK_URL`。
5. 保存并部署。

Worker 环境变量示例：

```text
WEBHOOK_URL=https://your-mail-service.example.com/api/webhook/receive
```

### 3. 绑定收信规则

1. 回到 `Email > Email Routing`。
2. 创建地址规则或者 `Catch-all`。
3. 动作选择 `Send to a Worker`。
4. 绑定刚创建的 Worker。

### 4. 当前 Worker 的解析能力

当前版本的 `cloudflare-worker.js` 已支持：

- `multipart/*` 递归解析
- `text/plain` 和 `text/html`
- `base64`
- `quoted-printable`
- 常见 MIME header 解码
- `utf-8`、`gbk`、`gb2312` 的正文解码

这解决了部分邮件服务商发来的 MIME 邮件正文无法显示的问题。

## Zeabur 部署

### 1. 导入项目

1. Fork 本仓库或上传到自己的 GitHub。
2. 在 Zeabur 创建项目并连接仓库。
3. Zeabur 会自动识别 `Dockerfile` 构建。

### 2. 配置环境变量

至少配置以下变量：

- `JWT_SECRET`
- `MAIL_DOMAIN`
- `DATA_DIR`

推荐：

```text
JWT_SECRET=replace-with-a-random-secret
MAIL_DOMAIN=mail.yourdomain.com
DATA_DIR=/app/data
```

### 3. 挂载持久化存储

为数据目录挂载存储卷：

```text
/app/data
```

### 4. 暴露端口

对外暴露端口：

```text
3000
```

## 前端行为说明

- 创建邮箱后会生成一个带 JWT 的访问地址
- 页面会自动轮询刷新邮件列表
- 当前自动刷新间隔为 2 秒
- 也可以手动点击“刷新邮件”

## Business Gemini 使用方式

1. 打开临时邮箱服务并创建邮箱。
2. 复制生成的带 JWT 的 URL。
3. 在 Business Gemini 后台填写临时邮箱地址或相关回调地址时使用该 URL。

## 已知限制

- 当前没有 SMTP 发信能力
- 邮件附件未保存
- HTML 邮件内容仅用于展示，不做附件或内联资源重建
- 默认鉴权方式依赖 URL 中的 JWT

## 开发说明

启动生产模式：

```bash
npm start
```

如果你修改了 `cloudflare-worker.js`，需要单独重新部署 Worker，Zeabur 服务不会自动同步这部分逻辑。
