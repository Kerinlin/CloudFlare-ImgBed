/**
 * 用户端认证工具
 * 基于统一认证核心，保持布尔检查 + 完整 identity 两种导出
 */

import { authenticate, AUTH_SCOPE } from './authCore.js';

/**
 * 客户端用户认证（布尔）
 * @param {Object} env
 * @param {URL} url
 * @param {Request} request
 * @param {string|null} requiredPermission
 * @return {Promise<boolean>}
 */
export async function userAuthCheck(env, url, request, requiredPermission = null) {
    const result = await authenticate({
        env,
        request,
        url,
        requiredPermission,
        authScope: AUTH_SCOPE.USER,
    });
    return result.authorized;
}

/**
 * 客户端用户认证（完整 identity）
 */
export async function userAuthIdentity(env, url, request, requiredPermission = null) {
    return authenticate({
        env,
        request,
        url,
        requiredPermission,
        authScope: AUTH_SCOPE.USER,
    });
}

export function UnauthorizedResponse(reason) {
    return new Response(reason, {
        status: 401,
        statusText: "Unauthorized",
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, authCode',
            "Content-Type": "text/plain;charset=UTF-8",
            "Cache-Control": "no-store",
            "Content-Length": reason.length,
        },
    });
}
