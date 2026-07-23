// API Token权限验证工具函数
import { getTokenData } from '../../api/manage/apiTokens.js';
import { isExpired } from './tokenExpiration.js';

/**
 * 验证API Token权限
 * @param {Request} request
 * @param {Object} db
 * @param {string|null} requiredPermission
 * @returns {Promise<{valid: boolean, error?: string, tokenData?: object}>}
 */
export async function validateApiToken(request, db, requiredPermission) {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader) {
        return { valid: false, error: '缺少Authorization头' };
    }

    let token;
    
    // 支持两种格式: "Bearer token" 或 "token"
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else {
        token = authHeader;
    }

    if (!token) {
        return { valid: false, error: '无效的Token格式' };
    }

    // 获取完整Token数据
    const tokenData = await getTokenData(db, token);
    
    if (!tokenData) {
        return { valid: false, error: '无效的Token' };
    }

    // 检查Token是否已过期
    if (isExpired(tokenData.expiresAt)) {
        return { valid: false, error: 'Token 已过期' };
    }

    // 决策 13：旧 Token 无 scope 一律无效
    if (!tokenData.scope) {
        return { valid: false, error: 'Token 已失效，请重新创建并指定 scope' };
    }

    if (tokenData.scope === 'user' && !tokenData.userId) {
        return { valid: false, error: '用户 Token 缺少 userId' };
    }

    // 检查权限
    if (requiredPermission !== null && !(tokenData.permissions || []).includes(requiredPermission)) {
        return { valid: false, error: `缺少${requiredPermission}权限` };
    }

    return { valid: true, tokenData };
}

/**
 * 从请求中提取Token信息
 */
export async function getTokenInfo(request, kv) {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader) {
        return null;
    }

    let token;
    
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else {
        token = authHeader;
    }

    if (!token) {
        return null;
    }

    const settingsStr = await kv.get('manage@sysConfig@security');
    const settings = settingsStr ? JSON.parse(settingsStr) : {};
    const tokens = settings.apiTokens?.tokens || {};
    
    for (const tokenId in tokens) {
        if (tokens[tokenId].token === token) {
            const t = tokens[tokenId];
            return {
                ...t,
                expiresAt: t.expiresAt ?? null,
                autoDelete: t.autoDelete ?? false
            };
        }
    }
    
    return null;
}
