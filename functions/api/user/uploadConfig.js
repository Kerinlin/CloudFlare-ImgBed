/**
 * 用户自己的上传渠道配置
 * GET / PUT
 */

import { authenticate, AUTH_SCOPE, isUserIdentity, isAdminIdentity } from '../../utils/auth/authCore.js';
import { getUserUploadConfig, saveUserUploadConfig } from '../../utils/userUploadConfig.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

    const identity = await authenticate({
        env,
        request,
        url: new URL(request.url),
        authScope: AUTH_SCOPE.USER,
    });

    if (!identity.authorized) {
        return json({ error: 'Unauthorized' }, 401);
    }

    // 仅绑定 userId 的用户可管自己的配置；admin 请走 manage 代管接口
    if (!isUserIdentity(identity)) {
        if (isAdminIdentity(identity)) {
            return json({ error: 'Admin should use /api/manage/users uploadConfig' }, 400);
        }
        return json({ error: 'Login as a user account required' }, 403);
    }

    const userId = identity.userId;

    if (request.method === 'GET') {
        const config = await getUserUploadConfig(env, userId);
        return json(config);
    }

    if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.json();
        const config = await saveUserUploadConfig(env, userId, body);
        return json(config);
    }

    return json({ error: 'Method not allowed' }, 405);
}
