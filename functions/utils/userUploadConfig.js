/**
 * 用户级上传渠道配置 + 按 identity 解析（按类型回落管理员）
 */

import { getDatabase } from './databaseAdapter.js';
import { fetchUploadConfig } from './sysConfig.js';
import { getUploadConfig } from '../api/manage/sysConfig/upload.js';

export const USER_CHANNEL_TYPES = ['telegram', 's3', 'discord', 'huggingface', 'webdav'];

const EMPTY_GROUP = () => ({
    channels: [],
    loadBalance: { enabled: false, channels: [] },
});

export function emptyUserUploadConfig() {
    return {
        telegram: EMPTY_GROUP(),
        s3: EMPTY_GROUP(),
        discord: EMPTY_GROUP(),
        huggingface: EMPTY_GROUP(),
        webdav: EMPTY_GROUP(),
    };
}

function configKey(userId) {
    return `manage@userConfig@upload@${userId}`;
}

/**
 * 读取用户上传配置（不含 cfr2）
 */
export async function getUserUploadConfig(env, userId) {
    if (!userId) return emptyUserUploadConfig();
    const db = getDatabase(env);
    const raw = await db.get(configKey(userId));
    if (!raw) return emptyUserUploadConfig();
    try {
        const parsed = JSON.parse(raw);
        const base = emptyUserUploadConfig();
        for (const type of USER_CHANNEL_TYPES) {
            if (parsed[type]) {
                base[type] = {
                    channels: Array.isArray(parsed[type].channels) ? parsed[type].channels : [],
                    loadBalance: parsed[type].loadBalance || { enabled: false, channels: [] },
                };
            }
        }
        return base;
    } catch {
        return emptyUserUploadConfig();
    }
}

/**
 * 保存用户上传配置；剥离 cfr2 与非法类型
 */
export async function saveUserUploadConfig(env, userId, body) {
    if (!userId) throw new Error('userId required');
    const cleaned = emptyUserUploadConfig();
    for (const type of USER_CHANNEL_TYPES) {
        if (body?.[type]) {
            cleaned[type] = {
                channels: Array.isArray(body[type].channels) ? body[type].channels : [],
                loadBalance: body[type].loadBalance || { enabled: false, channels: [] },
            };
        }
    }
    const db = getDatabase(env);
    await db.put(configKey(userId), JSON.stringify(cleaned));
    return cleaned;
}

function enabledChannels(group) {
    return (group?.channels || []).filter((ch) => ch && ch.enabled);
}

/**
 * 按身份解析上传配置
 * - admin / 无 userId：全局配置
 * - user：各类型若有 enabled 渠道则用用户的，否则回落管理员；cfr2 永远管理员
 */
export async function resolveUploadConfigForIdentity(env, identity, context = null) {
    const adminConfig = context
        ? await fetchUploadConfig(env, context)
        : await fetchUploadConfig(env);

    if (!identity || identity.scope === 'admin' || !identity.userId) {
        return adminConfig;
    }

    const userConfig = await getUserUploadConfig(env, identity.userId);
    const merged = {
        telegram: adminConfig.telegram,
        cfr2: adminConfig.cfr2,
        s3: adminConfig.s3,
        discord: adminConfig.discord,
        huggingface: adminConfig.huggingface,
        webdav: adminConfig.webdav,
    };

    for (const type of USER_CHANNEL_TYPES) {
        const userEnabled = enabledChannels(userConfig[type]);
        if (userEnabled.length > 0) {
            merged[type] = {
                channels: userEnabled,
                loadBalance: userConfig[type].loadBalance || { enabled: false, channels: [] },
            };
        }
    }

    return merged;
}

/**
 * 为删/移等操作解析渠道配置：优先文件 owner 的用户配置，再回落全局
 */
export async function resolveUploadConfigForFileOwner(env, ownerId) {
    const db = getDatabase(env);
    const adminConfig = await getUploadConfig(db, env);

    if (!ownerId) {
        return adminConfig;
    }

    const userConfig = await getUserUploadConfig(env, ownerId);
    const merged = { ...adminConfig };

    for (const type of USER_CHANNEL_TYPES) {
        const userEnabled = enabledChannels(userConfig[type]);
        // 删文件时：该类型若用户曾配置过（含 disabled 也尝试全量匹配），用用户全部渠道找 name
        const allUserChannels = userConfig[type]?.channels || [];
        if (allUserChannels.length > 0) {
            merged[type] = {
                channels: allUserChannels,
                loadBalance: userConfig[type].loadBalance || { enabled: false, channels: [] },
            };
        } else if (userEnabled.length > 0) {
            merged[type] = {
                channels: userEnabled,
                loadBalance: userConfig[type].loadBalance || { enabled: false, channels: [] },
            };
        }
        // else 保持 adminConfig[type]
    }

    // 若用户配置里找不到目标渠道，调用方会 findConfiguredChannel 失败；
    // 提供 hybrid：合并用户渠道 + 管理员渠道（用户优先）
    for (const type of USER_CHANNEL_TYPES) {
        const userCh = userConfig[type]?.channels || [];
        const adminCh = adminConfig[type]?.channels || [];
        if (userCh.length > 0) {
            const names = new Set(userCh.map((c) => c.name));
            const extra = adminCh.filter((c) => !names.has(c.name));
            merged[type] = {
                channels: [...userCh, ...extra],
                loadBalance: userConfig[type]?.loadBalance || adminConfig[type]?.loadBalance,
            };
        }
    }

    return merged;
}

/**
 * 强制用户路径前缀 users/{userId}/...
 */
export function applyUserUploadPrefix(userId, folder) {
    const prefix = `users/${userId}`;
    let rest = (folder || '').replace(/^\/+/, '').replace(/\/+$/, '');

    if (rest === prefix || rest.startsWith(prefix + '/')) {
        rest = rest.slice(prefix.length).replace(/^\/+/, '');
    }

    // 防止写到其他用户前缀
    if (rest.startsWith('users/')) {
        const parts = rest.split('/');
        // users / otherId / ...
        if (parts.length >= 2) {
            rest = parts.slice(2).join('/');
        }
    }

    return rest ? `${prefix}/${rest}` : prefix;
}
