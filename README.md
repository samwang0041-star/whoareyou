# UNKNOWN

<p align="center">
  <img src="public/whoareyou-main-visual-abstract.png" alt="UNKNOWN main visual" width="100%" />
</p>

<p align="center">
  <a href="https://ai.wangyuzhao.cn/">随机匹配</a> ·
  <a href="https://chat.wangyuzhao.cn/">私密转发</a> ·
  <a href="mailto:samwang0041@gmail.com">Contact</a>
</p>

<p align="center">
  <a href="https://ai.wangyuzhao.cn/">
    <img src="public/unknown-experience-qr.png" alt="UNKNOWN experience QR code" width="180" />
  </a>
</p>

<p align="center">
  <sub>手机扫码体验随机匹配</sub>
</p>

## 这是什么

UNKNOWN 是一个通过微信 AI 入口（OpenClaw / iLink）连接两个人的产品。披着 AI 入口的外壳，做的是人和人之间的对话。

## 两个模式

### Random Matching — 随机匹配

体验：[ai.wangyuzhao.cn](https://ai.wangyuzhao.cn/)

扫码进入微信 AI 入口，发 `打开`，系统和另一个同时在线的人配对。

- 1v1 对话，限时 60 分钟，每 10 分钟一次时间提醒
- 到点自动断开
- 发 `暂停` 停止匹配，发 `打开` 重新开启
- 发 `离开` 提前结束，需二次确认（`确认离开`）
- 发 `举报` 举报对方，被举报 3 次自动封禁
- 离开或举报后双方永久互斥，不会再匹配到同一个人
- 入口有约 24 小时可达窗口，快到期时会询问是否续期

指令：`打开` · `继续` · `暂停` · `离开` · `确认离开` · `举报` · `帮助`

### Private Relay — 私密转发

体验：[chat.wangyuzhao.cn](https://chat.wangyuzhao.cn/)

把你的聊天对象包装成 AI。你们互相都通过 AI 入口聊天，对方的真实身份只有你知道。

- 网页生成两张入口二维码，A 扫第一张，B 扫第二张
- 连接建立后，双方各自看到的都是一个「AI 入口」，实际消息转发给对方
- 定向连接：你决定把入口给谁，不是随机匹配
- 发 `/断开` 断开连接，关系立即消失
- 二维码有有效期，过期需重新生成
- 网页实时显示连接状态

## 隐私

- 不注册、不留昵称、不存头像、不记手机号
- 用户身份只保留 HMAC-SHA-256 哈希
- 不明文存储聊天记录
- Provider 凭据用 AES-GCM 加密
- Admin 后台不暴露原始身份信息

## 技术

Next.js App Router · PostgreSQL · Prisma · WeChat OpenClaw (iLink) · Vitest · Playwright

## 部署

两个模式共享同一套代码，通过 `PRODUCT_MODE` 环境变量切换：

```text
PRODUCT_MODE=unknown         → 随机匹配（ai.wangyuzhao.cn）
PRODUCT_MODE=private_relay   → 私密转发（chat.wangyuzhao.cn）
```

进程模型：

```text
web                npm run start
openclaw-updates   npm run worker:openclaw-updates:loop
outbox-worker      npm run worker:outbox:loop
scheduled-worker   npm run worker:scheduled:loop
release/migration  npm run db:migrate
```

## 本地开发

```bash
npm install
cp .env.example .env
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma migrate deploy
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' npx prisma generate
DATABASE_URL='postgresql://yuriwong@localhost:5432/whoareyou' ADMIN_TOKEN='dev-admin-token' PROVIDER_USER_HASH_SECRET='dev-provider-user-hash-secret' PROVIDER_CREDENTIAL_ENCRYPTION_SECRET='whoareyou-dev-provider-credential-encryption-secret' npm run dev
```

- Web: http://localhost:3000
- Admin: http://localhost:3000/admin
- Fake QR: `PROVIDER_MODE=fake npm run dev`
- Real QR: `PROVIDER_MODE=openclaw npm run dev`

详见 [docs/deploy.md](docs/deploy.md)。

## Contact

`samwang0041@gmail.com`
