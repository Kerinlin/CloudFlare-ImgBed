/**
 * 用户修改自己的密码
 * POST { oldPassword, newPassword }
 */

import { authenticate, AUTH_SCOPE, isUserIdentity } from '../../utils/auth/authCore.js';
import { getUserById, setUserPassword, verifyUserLogin } from '../../utils/userStore.js';
import { destroySessionsByUserId, createSession } from '../../utils/auth/sessionManager.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'private, no-store',
};

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders, ...extraHeaders },
    });
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    const identity = await authenticate({
        env,
        request,
        authScope: AUTH_SCOPE.USER,
    });

    if (!identity.authorized || !isUserIdentity(identity)) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const body = await request.json();
    const { oldPassword, newPassword } = body || {};
    if (!oldPassword || !newPassword) {
        return json({ error: 'oldPassword and newPassword required' }, 400);
    }

    const user = await getUserById(env, identity.userId);
    if (!user) {
        return json({ error: 'User not found' }, 404);
    }

    const check = await verifyUserLogin(env, user.username, oldPassword);
    if (!check.ok) {
        return json({ error: 'Old password incorrect' }, 403);
    }

    await setUserPassword(env, user.id, newPassword);
    await destroySessionsByUserId(env, user.id);

    // 重新签发当前会话
    const { cookie } = await createSession(env, 'user', {
        username: user.username,
        userId: user.id,
    });

    return json({ success: true }, 200, { 'Set-Cookie': cookie });
}
