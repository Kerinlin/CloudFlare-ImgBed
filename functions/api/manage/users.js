/**
 * 管理员：用户账号 CRUD
 * GET    - 列表
 * POST   - 创建 { username, password, displayName? }
 * PUT    - 更新 { id, displayName?, disabled?, username? }
 * DELETE - 删除 ?id=
 * PATCH  - 重置密码 { id, password }
 */

import { getDatabase } from '../../utils/databaseAdapter.js';
import {
    createUser,
    listUsers,
    updateUser,
    setUserPassword,
    deleteUser,
    getUserById,
} from '../../utils/userStore.js';
import { destroySessionsByUserId } from '../../utils/auth/sessionManager.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'private, no-store',
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        switch (request.method) {
            case 'GET':
                return await handleList(env);
            case 'POST':
                return await handleCreate(env, request);
            case 'PUT':
                return await handleUpdate(env, request);
            case 'PATCH':
                return await handleResetPassword(env, request);
            case 'DELETE':
                return await handleDelete(env, request);
            default:
                return json({ error: 'Method not allowed' }, 405);
        }
    } catch (e) {
        console.error('users API error:', e);
        return json({ error: e.message || 'Internal error' }, 400);
    }
}

async function handleList(env) {
    const users = await listUsers(env);
    return json({ users });
}

async function handleCreate(env, request) {
    const body = await request.json();
    const { username, password, displayName = '' } = body || {};
    const { user } = await createUser(env, { username, password, displayName });
    return json({ user }, 201);
}

async function handleUpdate(env, request) {
    const body = await request.json();
    const { id, displayName, disabled, username } = body || {};
    if (!id) {
        return json({ error: '缺少 id' }, 400);
    }
    const patch = {};
    if (displayName !== undefined) patch.displayName = displayName;
    if (disabled !== undefined) patch.disabled = disabled;
    if (username !== undefined) patch.username = username;

    const user = await updateUser(env, id, patch);

    // 禁用时踢下线
    if (disabled === true) {
        await destroySessionsByUserId(env, id);
    }

    return json({ user });
}

async function handleResetPassword(env, request) {
    const body = await request.json();
    const { id, password } = body || {};
    if (!id || !password) {
        return json({ error: '缺少 id 或 password' }, 400);
    }
    const user = await setUserPassword(env, id, password);
    await destroySessionsByUserId(env, id);
    return json({ user, message: 'password reset' });
}

async function handleDelete(env, request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
        return json({ error: '缺少 id' }, 400);
    }

    // 硬删用户：踢 session；文件 owner_id 置 null（尽力）
    await destroySessionsByUserId(env, id);
    const result = await deleteUser(env, id);

    try {
        await clearOwnerOnFiles(env, id);
    } catch (e) {
        console.warn('clearOwnerOnFiles failed:', e.message);
    }

    // 清理用户上传配置
    try {
        const db = getDatabase(env);
        await db.delete(`manage@userConfig@upload@${id}`);
    } catch (e) {
        console.warn('delete user uploadConfig failed:', e.message);
    }

    return json(result);
}

/**
 * 将已删用户的文件 owner 置空（仅 D1 高效路径；索引 metadata 需重建或懒修复）
 */
async function clearOwnerOnFiles(env, userId) {
    const db = getDatabase(env);
    if (db && db.db && typeof db.db.prepare === 'function') {
        // 更新列
        await db.db.prepare(
            `UPDATE files SET owner_id = NULL WHERE owner_id = ?`
        ).bind(userId).run();

        // 同步 metadata JSON 中的 OwnerId（D1 无 JSON_SET 保证时逐条）
        const rows = await db.db.prepare(
            `SELECT id, metadata FROM files WHERE metadata LIKE ?`
        ).bind(`%"OwnerId":"${userId}"%`).all();

        for (const row of (rows.results || [])) {
            try {
                const meta = JSON.parse(row.metadata || '{}');
                if (meta.OwnerId === userId) {
                    delete meta.OwnerId;
                    await db.db.prepare(
                        'UPDATE files SET metadata = ? WHERE id = ?'
                    ).bind(JSON.stringify(meta), row.id).run();
                }
            } catch {
                // skip
            }
        }
        return;
    }

    // KV：无法高效扫全库，跳过（依赖索引中的 OwnerId；用户已删后无法登录访问）
    void getUserById;
}
