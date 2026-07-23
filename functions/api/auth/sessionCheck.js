import { validateAnySession } from "../../utils/auth/sessionManager.js";
import { fetchSecurityConfig } from "../../utils/sysConfig.js";
import { getUserById, isMultiUserEnabled } from "../../utils/userStore.js";

/**
 * 会话检查接口
 * 返回 valid / authType / userId / username / adminRequired / userRequired
 */
export async function onRequestGet(context) {
    const { request, env } = context;

    let securityConfig;
    try {
        securityConfig = await fetchSecurityConfig(env, { throwOnError: true });
    } catch (error) {
        console.error('Session check failed because security config could not be loaded:', error);
        return new Response(JSON.stringify({ error: 'Security config unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;

    const adminRequired = !!(adminUsername && adminUsername.trim()) || !!(adminPassword && adminPassword.trim());
    // 有任意用户即要求用户登录（废除 authCode 后）
    const userRequired = await isMultiUserEnabled(env);

    const sessionResult = await validateAnySession(env, request);
    if (sessionResult.valid) {
        const session = sessionResult.session;
        let userId = session.userId || null;
        let username = session.username || '';
        let authType = session.authType;

        // 用户 session：二次校验账号状态
        if (authType === 'user') {
            if (!userId) {
                return json({
                    valid: false,
                    adminRequired,
                    userRequired,
                });
            }
            const user = await getUserById(env, userId);
            if (!user || user.disabled) {
                return json({
                    valid: false,
                    adminRequired,
                    userRequired,
                });
            }
            username = user.username;
            userId = user.id;
        }

        return json({
            valid: true,
            authType,
            userId,
            username,
            adminRequired,
            userRequired,
        });
    }

    return json({
        valid: false,
        adminRequired,
        userRequired,
    });
}

function json(data) {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
