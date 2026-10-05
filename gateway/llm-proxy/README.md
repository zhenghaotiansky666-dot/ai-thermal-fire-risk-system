# AI 指挥 · 大模型免 Key 代理（Cloudflare Worker）

线上站点是纯静态的，把大模型 API Key 写进前端等于公开泄露。
把 Key 放在这个 Worker 的环境变量里，两端只填代理地址，**用户全程看不到 Key**。

## 部署（一次性）

```bash
cd gateway/llm-proxy
npx wrangler login
npx wrangler deploy
```

部署后得到形如 `https://thermal-guard-llm-proxy.<你的账号>.workers.dev` 的地址。

## 配置服务端密钥

```bash
npx wrangler secret put LLM_API_KEY      # 必填：大模型 API Key
npx wrangler secret put LLM_BASE_URL     # 可选，默认豆包 https://ark.cn-beijing.volces.com/api/v3
npx wrangler secret put LLM_MODEL        # 可选，默认 doubao-1-5-pro-32k-250115
npx wrangler secret put PROXY_TOKEN      # 可选：共享令牌，防止别人拿你的 Key 刷量
```

## 前端怎么接（不用改代码）

系统端「看板 → 关于项目」或用户端「更多 → AI 指挥」里填：

| 字段 | 填什么 |
| --- | --- |
| 服务 | 自定义（OpenAI 兼容） |
| 端点地址 | `https://thermal-guard-llm-proxy.<你的账号>.workers.dev` |
| 模型名 | 留空用服务端默认；也可填 `deepseek-chat` 等 |
| 访问密钥 | 设了 `PROXY_TOKEN` 就填它，没设就留空 |

本仓库的 AI 指挥走标准 OpenAI `/chat/completions`，Worker 对这个路径是**原样透传**，
所以端点一填就能用；不需要 Key 也不会把 Key 下发到浏览器。

## 两个接口

```bash
# 1) 标准 OpenAI 同构（前端用这个）
curl -X POST https://<worker>/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -d '{"messages":[{"role":"user","content":"三楼配电箱发热怎么处置"}],"model":"deepseek-chat"}'

# 2) 简化版（脚本/调试用）
curl -X POST https://<worker>/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"灭火器怎么用"}'
# → {"reply":"…"}

curl https://<worker>/health
# → {"ok":true,"configured":true,"model":"…"}
```

## 支持的服务商（任何 OpenAI 兼容接口）

豆包（火山方舟）、DeepSeek、Kimi（Moonshot）、OpenAI，以及自建 OpenAI 兼容网关。
只改 `LLM_BASE_URL` / `LLM_MODEL` 两个变量即可切换。

> 不想上云也完全可以：把端点填成 `node tools/local-ai-server.mjs` 起的 `/ai/v1`
> 或现场机器的 Ollama（`http://127.0.0.1:11434/v1`），走局域网，不出场。
