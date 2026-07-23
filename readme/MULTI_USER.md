# 多用户账号隔离 — 部署与迁移

## 变更摘要

- 普通用户：管理员创建，用户名+密码登录
- 文件 `OwnerId` / `owner_id` 隔离列表与删改
- 上传路径强制 `users/{userId}/...`
- 用户可配渠道（HF/TG/S3/Discord/WebDAV），按类型回落管理员；**不可配 R2**
- 全局 `authCode` 登录废除
- API Token 必须带 `scope`（`admin`|`user`）；旧 Token **全部失效**，需重发
- 直链 `/file/...` 仍公开；公开图库列表强制空

## D1 迁移

在 Cloudflare Dashboard 或 wrangler 执行：

```bash
npx wrangler d1 execute <DB_NAME> --file=database/migrations/v2.3.0_multi_user.sql
```

（本地加 `--local`）

## 割接步骤

1. 部署后端 + 跑 D1 migration  
2. 管理员登录 → 系统配置 → **用户管理** → 创建用户  
3. 旧共享 authCode 失效；通知用户改用用户名密码  
4. 在安全设置中 **重新创建 API Token**（选 scope=admin 或 scope=user+userId）  
5. 用户登录上传；列表仅见自己的文件  

## API 速查

| 接口 | 说明 |
|---|---|
| `POST /api/auth/login` | `{ username, password }` |
| `GET/POST /api/manage/users` | 管理员用户 CRUD |
| `PATCH /api/manage/users` | `{ id, password }` 重置密码 |
| `GET/PUT /api/user/uploadConfig` | 用户渠道配置 |
| `GET/PUT /api/manage/userUploadConfig?userId=` | 管理员代管渠道 |
| `POST /api/user/password` | 用户改密 |

## 说明

- 历史无 `OwnerId` 文件仅管理员可见  
- 删用户：session 踢下线，文件 owner 置空  
- 用户渠道配置 key：`manage@userConfig@upload@{userId}`  
