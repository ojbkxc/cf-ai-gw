# WorkersAI2API

一个反向代理:把 Cloudflare Workers AI 转换成 OpenAI / Anthropic 兼容的接口格式,支持多账号负载均衡、故障自动切换重试,并自带一个可视化管理面板(数据看板)。

仓库仅包含一个 `_worker.js` 文件,可直接部署到 **Cloudflare Pages**(Pages 高级模式,根目录放置 `_worker.js`)。

## 功能特性

- OpenAI 兼容接口(`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`)
- Anthropic Messages API 兼容接口(`/v1/messages`),支持流式与非流式
- 多 Cloudflare 账号绑定,负载均衡 + 故障自动切换重试
- 内置可视化管理面板(`/admin`),查看今日/本月用量、历史趋势、模型分布
- 可配置每日/每月 Neurons 限额及拦截阈值
- 代理 API Key 管理(可随机生成或自定义)
- 跨域(CORS)支持
- 安全加固:异常日志不泄露 token、前端 XSS 防护、CSRF 防护

## 部署到 Cloudflare Pages

### 1. 创建 Pages 项目

1. 进入 Cloudflare 控制台 → **Workers & Pages** → **创建应用** → 选择 **Pages**。
2. 选择 **直接上传(Direct Upload)** 或连接 Git 仓库。
3. 构建产物目录保持为根目录(确保 `_worker.js` 位于输出根目录,即 Pages 高级模式生效)。
4. 部署完成后,会得到一个 `xxx.pages.dev` 域名。

> Pages 高级模式要求:输出目录根下存在 `_worker.js`,它会接管所有请求路由(相当于 Pages Functions 的整站入口)。

### 2. 创建一个 KV 命名空间

1. 进入 Cloudflare 控制台 → **Workers & Pages** → **KV** → **创建命名空间**。
2. 给命名空间取个名字(例如 `WORKERSAI2API_KV`),创建完成。
3. 记住这个名字,下一步绑定时要选它。

### 3. 配置环境变量与绑定

进入 Pages 项目 → **设置(Settings)** → **Functions** 区域,依次添加:

- **环境变量**
  - `ADMIN_PASSWORD`:后台管理面板与接口的访问密码(必填,未配置则拦截所有访问)。请使用强密码。
  - 可选:`DAILY_LIMIT`(默认 10000)、`MONTHLY_LIMIT`(默认 100000)、`USAGE_THRESHOLD`(默认 0,即关闭限额拦截,仅统计)。

- **KV 命名空间绑定(KV namespace bindings)**
  - **变量名称(Variable name)**:填大写 `KV`(必须为 `KV`,代码中通过 `env.KV` 读取)。
  - **KV 命名空间**:选择第 2 步创建的 KV 命名空间。

- **Workers AI 绑定(Workers AI bindings)**
  - **变量名称(Variable name)**:填 `AI`(即 Workers AI 绑定的标识)。
  - 选择对应账号即可。

> 绑定名称区分大小写,务必按上述大写填写 `KV` 与 `AI`。

### 4. 重新部署并验证

1. 配置完环境变量与绑定后,触发一次重新部署(新增/修改绑定通常需要重新部署生效)。
2. 打开 `https://<你的项目>.pages.dev/`,进入后台管理面板 `/admin`,使用 `ADMIN_PASSWORD` 登录。
3. 在"账号管理"中添加 Cloudflare 账号(填入 `Account ID` 与 `API Token`,Token 需具备 Workers AI 的读/写权限)。
4. 即可通过 `https://<你的项目>.pages.dev/v1/chat/completions` 调用 OpenAI 兼容接口,`Authorization` 头填代理 API Key(在面板中创建)。

## 接口调用示例

```bash
curl https://<你的项目>.pages.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你在面板中创建的代理APIKey>" \
  -d '{
    "model": "llama-3.1-8b",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Anthropic 格式调用示例

```bash
curl https://<你的项目>.pages.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <你在面板中创建的代理APIKey>" \
  -d '{
    "model": "llama-3.1-8b",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 流式调用(Stream)

### OpenAI 格式流式

在请求体中加入 `"stream": true` 即可开启 SSE 流式响应:

```bash
curl https://<你的项目>.pages.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <代理APIKey>" \
  -N \
  -d '{
    "model": "llama-3.1-8b",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

返回格式为标准 OpenAI SSE 流,每个 chunk 的 `data:` 行包含一段 JSON,末尾以 `data: [DONE]` 结束。`tool_calls`、`finish_reason`、`usage`、`reasoning_content` 等字段均原样透传。

### Anthropic 格式流式

```bash
curl https://<你的项目>.pages.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <代理APIKey>" \
  -N \
  -d '{
    "model": "llama-3.1-8b",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

返回格式为 Anthropic SSE 流,包含 `message_start`、`content_block_start`、`content_block_delta`(含 `text_delta` 和 `input_json_delta`)、`content_block_stop`、`message_delta`、`message_stop` 等事件。支持 `tool_use` 流式输出。

> **注意:** 流式响应由 Cloudflare Workers AI 上游直接透传(OpenAI 格式仅替换模型名)或实时转换(Anthropic 格式)。如果上游在流式传输中途断开,客户端会收到截断的流,不会触发账号切换重试——这是 SSE 流式的设计特性。

## 关于数据看板"今日总消耗量"百分比

看板百分比按真实用量计算,不再封顶到 100.00%,用量超过限额时会显示超过 100% 的真实值。为避免 UI 溢出,进度条宽度仍限制在最大 100%。
