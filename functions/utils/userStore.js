/**
 * 多用户账号仓储
 * D1：优先 users 表；失败或非 D1 时回落到 settings 键 manage@users@*
 */

import { hashPassword, verifyPassword } from './auth/passwordHash.js';
import { getDatabase } from './databaseAdapter.js';

const USER_KEY_PREFIX = 'manage@users@id@';
const USER_NAME_PREFIX = 'manage@users@name@';

function generateUserId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.display_name || '',
        disabled: !!(user.disabled),
        createdAt: user.createdAt || user.created_at || null,
        updatedAt: user.updatedAt || user.updated_at || null,
    };
}

function rowToUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        displayName: row.display_name || '',
        disabled: !!row.disabled,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function getRawD1(db) {
    // D1Database 实例挂载原生 binding
    if (db && db.db && typeof db.db.prepare === 'function') {
        return db.db;
    }
    return null;
}

async function settingsGetUser(db, userId) {
    const raw = await db.get(`${USER_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function settingsGetUserByUsername(db, username) {
    const nameKey = `${USER_NAME_PREFIX}${normalizeUsername(username)}`;
    const userId = await db.get(nameKey);
    if (!userId) return null;
    return settingsGetUser(db, userId);
}

async function settingsListUsers(db) {
    const listed = await db.list({ prefix: USER_KEY_PREFIX });
    const keys = listed?.keys || [];
    const users = [];
    for (const key of keys) {
        const raw = await db.get(key.name);
        if (!raw) continue;
        try {
            users.push(JSON.parse(raw));
        } catch {
            // skip corrupt
        }
    }
    users.sort((a, b) => String(a.username).localeCompare(String(b.username)));
    return users;
}

async function settingsSaveUser(db, user, previousUsername = null) {
    await db.put(`${USER_KEY_PREFIX}${user.id}`, JSON.stringify(user));
    const nameKey = `${USER_NAME_PREFIX}${normalizeUsername(user.username)}`;
    await db.put(nameKey, user.id);
    if (previousUsername && normalizeUsername(previousUsername) !== normalizeUsername(user.username)) {
        await db.delete(`${USER_NAME_PREFIX}${normalizeUsername(previousUsername)}`);
    }
}

async function settingsDeleteUser(db, user) {
    await db.delete(`${USER_KEY_PREFIX}${user.id}`);
    await db.delete(`${USER_NAME_PREFIX}${normalizeUsername(user.username)}`);
}

async function d1GetUser(raw, userId) {
    const row = await raw.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    return rowToUser(row);
}

async function d1GetUserByUsername(raw, username) {
    const row = await raw.prepare('SELECT * FROM users WHERE username = ?')
        .bind(normalizeUsername(username))
        .first();
    return rowToUser(row);
}

async function d1ListUsers(raw) {
    const result = await raw.prepare('SELECT * FROM users ORDER BY username ASC').all();
    return (result.results || []).map(rowToUser);
}

async function d1InsertUser(raw, user) {
    await raw.prepare(
        'INSERT INTO users (id, username, password_hash, display_name, disabled) VALUES (?, ?, ?, ?, ?)'
    ).bind(
        user.id,
        normalizeUsername(user.username),
        user.passwordHash,
        user.displayName || '',
        user.disabled ? 1 : 0
    ).run();
}

async function d1UpdateUser(raw, user) {
    await raw.prepare(
        'UPDATE users SET username = ?, password_hash = ?, display_name = ?, disabled = ? WHERE id = ?'
    ).bind(
        normalizeUsername(user.username),
        user.passwordHash,
        user.displayName || '',
        user.disabled ? 1 : 0,
        user.id
    ).run();
}

async function d1DeleteUser(raw, userId) {
    await raw.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

async function d1CountUsers(raw) {
    const row = await raw.prepare('SELECT COUNT(*) AS c FROM users').first();
    return Number(row?.c || 0);
}

/**
 * @param {Object} env
 * @returns {Promise<number>}
 */
export async function countUsers(env) {
    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            return await d1CountUsers(raw);
        } catch (e) {
            console.warn('users table unavailable, fallback settings count:', e.message);
        }
    }
    const users = await settingsListUsers(db);
    return users.length;
}

/**
 * 是否启用多用户登录门槛（有任意用户即要求用户登录）
 */
export async function isMultiUserEnabled(env) {
    return (await countUsers(env)) > 0;
}

export async function getUserById(env, userId) {
    if (!userId) return null;
    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            const user = await d1GetUser(raw, userId);
            if (user) return user;
        } catch (e) {
            console.warn('d1GetUser failed:', e.message);
        }
    }
    return settingsGetUser(db, userId);
}

export async function getUserByUsername(env, username) {
    if (!username) return null;
    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            const user = await d1GetUserByUsername(raw, username);
            if (user) return user;
        } catch (e) {
            console.warn('d1GetUserByUsername failed:', e.message);
        }
    }
    return settingsGetUserByUsername(db, username);
}

export async function listUsers(env) {
    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            return (await d1ListUsers(raw)).map(publicUser);
        } catch (e) {
            console.warn('d1ListUsers failed:', e.message);
        }
    }
    return (await settingsListUsers(db)).map(publicUser);
}

/**
 * 创建用户
 * @returns {Promise<{user: object}>}
 */
export async function createUser(env, { username, password, displayName = '' }) {
    const normalized = normalizeUsername(username);
    if (!normalized || normalized.length < 2) {
        throw new Error('用户名至少 2 个字符');
    }
    if (!password || String(password).length < 6) {
        throw new Error('密码至少 6 个字符');
    }

    const existing = await getUserByUsername(env, normalized);
    if (existing) {
        throw new Error('用户名已存在');
    }

    const now = new Date().toISOString();
    const user = {
        id: generateUserId(),
        username: normalized,
        passwordHash: await hashPassword(password),
        displayName: displayName || '',
        disabled: false,
        createdAt: now,
        updatedAt: now,
    };

    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            await d1InsertUser(raw, user);
            // 同步一份 settings 便于 list prefix 调试可选，跳过
            return { user: publicUser(user) };
        } catch (e) {
            // unique 冲突或表不存在
            if (String(e.message || '').includes('UNIQUE')) {
                throw new Error('用户名已存在');
            }
            console.warn('d1InsertUser failed, fallback settings:', e.message);
        }
    }

    await settingsSaveUser(db, user);
    return { user: publicUser(user) };
}

export async function updateUser(env, userId, patch = {}) {
    const existing = await getUserById(env, userId);
    if (!existing) {
        throw new Error('用户不存在');
    }

    const previousUsername = existing.username;
    if (patch.username !== undefined) {
        const normalized = normalizeUsername(patch.username);
        if (!normalized || normalized.length < 2) {
            throw new Error('用户名至少 2 个字符');
        }
        const conflict = await getUserByUsername(env, normalized);
        if (conflict && conflict.id !== userId) {
            throw new Error('用户名已存在');
        }
        existing.username = normalized;
    }
    if (patch.displayName !== undefined) {
        existing.displayName = patch.displayName || '';
    }
    if (patch.disabled !== undefined) {
        existing.disabled = !!patch.disabled;
    }
    existing.updatedAt = new Date().toISOString();

    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            await d1UpdateUser(raw, existing);
            return publicUser(existing);
        } catch (e) {
            if (String(e.message || '').includes('UNIQUE')) {
                throw new Error('用户名已存在');
            }
            console.warn('d1UpdateUser failed, fallback settings:', e.message);
        }
    }

    await settingsSaveUser(db, existing, previousUsername);
    return publicUser(existing);
}

export async function setUserPassword(env, userId, newPassword) {
    if (!newPassword || String(newPassword).length < 6) {
        throw new Error('密码至少 6 个字符');
    }
    const existing = await getUserById(env, userId);
    if (!existing) {
        throw new Error('用户不存在');
    }
    existing.passwordHash = await hashPassword(newPassword);
    existing.updatedAt = new Date().toISOString();

    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            await d1UpdateUser(raw, existing);
            return publicUser(existing);
        } catch (e) {
            console.warn('d1 set password failed, fallback settings:', e.message);
        }
    }
    await settingsSaveUser(db, existing);
    return publicUser(existing);
}

export async function deleteUser(env, userId) {
    const existing = await getUserById(env, userId);
    if (!existing) {
        throw new Error('用户不存在');
    }

    const db = getDatabase(env);
    const raw = getRawD1(db);
    if (raw) {
        try {
            await d1DeleteUser(raw, userId);
            // 清理 settings 镜像（若有）
            try { await settingsDeleteUser(db, existing); } catch { /* ignore */ }
            return { success: true, user: publicUser(existing) };
        } catch (e) {
            console.warn('d1DeleteUser failed, fallback settings:', e.message);
        }
    }

    await settingsDeleteUser(db, existing);
    return { success: true, user: publicUser(existing) };
}

/**
 * 校验登录
 * @returns {Promise<{ok:boolean, user?:object, error?:string}>}
 */
export async function verifyUserLogin(env, username, password) {
    const user = await getUserByUsername(env, username);
    if (!user) {
        return { ok: false, error: 'Unauthorized' };
    }
    if (user.disabled) {
        return { ok: false, error: 'Account disabled' };
    }
    const match = await verifyPassword(password, user.passwordHash);
    if (!match) {
        return { ok: false, error: 'Unauthorized' };
    }
    return { ok: true, user };
}

export { publicUser, normalizeUsername };
