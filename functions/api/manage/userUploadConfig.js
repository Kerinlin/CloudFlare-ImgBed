/**
 * 管理员代管用户上传渠道配置
 * GET  ?userId=
 * PUT  { userId, ...config }
 */

import { getUserById } from '../../utils/userStore.js';
import { getUserUploadConfig, saveUserUploadConfig } from '../../utils/userUploadConfig.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

    try {
        if (request.method === 'GET') {
            const url = new URL(request.url);
            const userId = url.searchParams.get('userId');
            if (!userId) return json({ error: 'userId required' }, 400);
            const user = await getUserById(env, userId);
            if (!user) return json({ error: 'User not found' }, 404);
            const config = await getUserUploadConfig(env, userId);
            return json({ userId, config });
        }

        if (request.method === 'PUT' || request.method === 'POST') {
            const body = await request.json();
            const userId = body.userId;
            if (!userId) return json({ error: 'userId required' }, 400);
            const user = await getUserById(env, userId);
            if (!user) return json({ error: 'User not found' }, 404);
            const config = await saveUserUploadConfig(env, userId, body.config || body);
            return json({ userId, config });
        }

        return json({ error: 'Method not allowed' }, 405);
    } catch (e) {
        return json({ error: e.message || 'error' }, 400);
    }
}
