/**
 * 统一认证核心
 * 所有认证逻辑的单一来源，按优先级依次尝试各种认证方式
 * 返回完整身份上下文：scope / userId / username 等
 */

import { fetchSecurityConfig } from '../sysConfig.js';
import { validateApiToken } from './tokenValidator.js';
import { getDatabase } from '../databaseAdapter.js';
import { validateSession } from './sessionManager.js';
import { getUserById, isMultiUserEnabled } from '../userStore.js';

/**
 * 认证范围常量
 * - 'admin'  : 仅管理员（admin session / admin API Token）
 * - 'user'   : 用户侧（user session / admin session / user|admin API Token）
 * - 'either' : 管理员或用户任一通过即可
 */
export const AUTH_SCOPE = {
    ADMIN: 'admin',
    USER: 'user',
    EITHER: 'either',
};

const UNAUTHORIZED = {
    authorized: false,
    authType: null,
    scope: null,
    userId: null,
    username: null,
    tokenId: null,
    permissions: null,
};

function identity({
    authorized = true,
    authType,
    scope,
    userId = null,
    username = null,
    tokenId = null,
    permissions = null,
}) {
    return {
        authorized,
        authType,
        scope: scope || authType,
        userId,
        username,
        tokenId,
        permissions,
    };
}

/**
 * 管理员会话认证
 * @returns {Promise<object|null>}
 */
async function checkAdmin({ env, request, adminConfigured }) {
    if (!adminConfigured) {
        return identity({ authType: 'admin', scope: 'admin' });
    }

    const session = await validateSession(env, request, 'admin');
    if (session.valid) {
        return identity({
            authType: 'admin',
            scope: 'admin',
            username: session.session.username || '',
        });
    }

    return null;
}

/**
 * 用户会话认证（多用户账号；不再接受全局 authCode）
 * 优先级：admin session → user session（校验 users 表且未禁用）
 * 无多用户且未强制时：放行为匿名 user（兼容未建用户前的开放上传）
 *
 * @returns {Promise<object|null>}
 */
async function checkUser({ env, request, multiUserEnabled }) {
    // admin session（管理员身份也可访问用户资源）
    const adminSession = await validateSession(env, request, 'admin');
    if (adminSession.valid) {
        return identity({
            authType: 'admin',
            scope: 'admin',
            username: adminSession.session.username || '',
        });
    }

    // user session
    const userSession = await validateSession(env, request, 'user');
    if (userSession.valid) {
        const userId = userSession.session.userId || null;
        // 无 userId 的旧 session（authCode 时代）一律失效
        if (!userId) {
            return multiUserEnabled ? UNAUTHORIZED : null;
        }
        const user = await getUserById(env, userId);
        if (!user || user.disabled) {
            return UNAUTHORIZED;
        }
        return identity({
            authType: 'user',
            scope: 'user',
            userId: user.id,
            username: user.username,
        });
    }

    // 未启用多用户时保持开放（与历史「未配置 authCode 放行」一致）
    if (!multiUserEnabled) {
        return identity({ authType: 'user', scope: 'user' });
    }

    return UNAUTHORIZED;
}

/**
 * 统一认证函数
 *
 * @param {Object} options
 * @param {Object} options.env
 * @param {Request} options.request
 * @param {URL} [options.url]
 * @param {string|null} [options.requiredPermission]
 * @param {'admin'|'user'|'either'} [options.authScope='either']
 * @returns {Promise<object>} identity
 */
export async function authenticate({
    env,
    request,
    url = null,
    requiredPermission = null,
    authScope = AUTH_SCOPE.EITHER,
}) {
    // 读取安全配置
    const securityConfig = await fetchSecurityConfig(env);
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;

    const adminConfigured = !!(adminUsername && adminUsername.trim()) || !!(adminPassword && adminPassword.trim());
    const multiUserEnabled = await isMultiUserEnabled(env);

    // --- API Token 验证（公共层） ---
    const db = getDatabase(env);
    const tokenResult = await validateApiToken(request, db, requiredPermission);
    if (tokenResult.valid && tokenResult.tokenData) {
        const t = tokenResult.tokenData;
        // 新模型：必须有 scope；旧 token 无 scope → 拒绝（决策 13）
        const scope = t.scope || null;
        if (!scope) {
            // 兼容：仅当显式 type==='admin' 且无 userId 时不在此放行——一律要求 scope
            return UNAUTHORIZED;
        }
        if (scope === 'admin') {
            if (authScope === AUTH_SCOPE.USER || authScope === AUTH_SCOPE.EITHER || authScope === AUTH_SCOPE.ADMIN) {
                // admin token 在 USER/EITHER/ADMIN 均可用（USER 场景下管理员可上传）
                if (authScope === AUTH_SCOPE.ADMIN || authScope === AUTH_SCOPE.EITHER || authScope === AUTH_SCOPE.USER) {
                    return identity({
                        authType: 'admin',
                        scope: 'admin',
                        tokenId: t.id,
                        permissions: t.permissions || [],
                        username: t.owner || '',
                    });
                }
            }
        }
        if (scope === 'user') {
            if (!t.userId) {
                return UNAUTHORIZED;
            }
            if (authScope === AUTH_SCOPE.ADMIN) {
                return UNAUTHORIZED;
            }
            const user = await getUserById(env, t.userId);
            if (!user || user.disabled) {
                return UNAUTHORIZED;
            }
            return identity({
                authType: 'user',
                scope: 'user',
                userId: user.id,
                username: user.username,
                tokenId: t.id,
                permissions: t.permissions || [],
            });
        }
        return UNAUTHORIZED;
    }

    // --- 会话验证 ---
    const adminCtx = { env, request, adminConfigured };
    const userCtx = { env, request, multiUserEnabled };

    if (authScope === AUTH_SCOPE.ADMIN) {
        return (await checkAdmin(adminCtx)) || UNAUTHORIZED;
    }

    if (authScope === AUTH_SCOPE.USER) {
        const result = await checkUser(userCtx);
        return result || UNAUTHORIZED;
    }

    // EITHER
    const adminResult = await checkAdmin(adminCtx);
    if (adminResult?.authorized) return adminResult;

    const userResult = await checkUser(userCtx);
    return userResult || UNAUTHORIZED;
}

/**
 * 是否管理员身份
 */
export function isAdminIdentity(identityResult) {
    return !!(identityResult?.authorized && identityResult.scope === 'admin');
}

/**
 * 是否带 userId 的普通用户
 */
export function isUserIdentity(identityResult) {
    return !!(identityResult?.authorized && identityResult.scope === 'user' && identityResult.userId);
}

/**
 * 文件访问：admin 全放行；user 仅 OwnerId 匹配
 */
export function assertCanAccessFile(identityResult, metadata = {}) {
    if (!identityResult?.authorized) {
        return { ok: false, status: 401, reason: 'Unauthorized' };
    }
    if (identityResult.scope === 'admin') {
        return { ok: true };
    }
    const ownerId = metadata.OwnerId || metadata.ownerId || null;
    if (identityResult.userId && ownerId && ownerId === identityResult.userId) {
        return { ok: true };
    }
    return { ok: false, status: 403, reason: 'Forbidden' };
}
