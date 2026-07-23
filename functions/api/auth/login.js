import { createSession } from "../../utils/auth/sessionManager.js";
import { verifyUserLogin } from "../../utils/userStore.js";

/**
 * 用户登录：用户名 + 密码（多用户）
 * 废弃全局 authCode
 */
export async function onRequestPost(context) {
    const { request, env } = context;

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 拒绝旧 authCode 登录
    if (body.authCode !== undefined && body.username === undefined) {
        return new Response(JSON.stringify({
            error: 'authCode login removed; use username/password',
            code: 'AUTHCODE_REMOVED',
        }), {
            status: 410,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const username = body.username;
    const password = body.password;

    if (!username || !password) {
        return new Response(JSON.stringify({ error: 'username and password required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const result = await verifyUserLogin(env, username, password);
    if (!result.ok) {
        const status = result.error === 'Account disabled' ? 403 : 401;
        return new Response(JSON.stringify({ error: result.error || 'Unauthorized' }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const user = result.user;
    const { cookie } = await createSession(env, 'user', {
        username: user.username,
        userId: user.id,
    });

    return new Response(JSON.stringify({
        success: true,
        userId: user.id,
        username: user.username,
        displayName: user.displayName || '',
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookie,
        },
    });
}
