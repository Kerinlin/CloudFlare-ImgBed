/**
 * 上传渠道列表 API
 * 负责在鉴权后返回当前可用或全部上传渠道的名称与类型
 */
import { getUploadConfig } from './manage/sysConfig/upload.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { dualAuthCheck } from '../utils/auth/dualAuth.js';
import { resolveUploadConfigForIdentity } from '../utils/userUploadConfig.js';

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // 双重鉴权检查
    const url = new URL(request.url);
    const identity = await dualAuthCheck(env, url, request);
    if (!identity.authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const includeDisabled = url.searchParams.get('includeDisabled') === 'true';

        let uploadConfig;
        if (includeDisabled && identity.scope === 'admin') {
            // 仅管理员可看含禁用的全局配置
            const db = getDatabase(env);
            uploadConfig = await getUploadConfig(db, env);
        } else {
            // 按身份解析（用户：自有渠道优先，按类型回落）
            uploadConfig = await resolveUploadConfigForIdentity(env, identity, context);
        }

        // 构建渠道列表，返回渠道名称和实际的 Channel 类型
        const channels = {
            telegram: uploadConfig.telegram.channels.map(ch => ({
                name: ch.name,
                type: 'TelegramNew'
            })),
            cfr2: uploadConfig.cfr2.channels.map(ch => ({
                name: ch.name,
                type: 'CloudflareR2'
            })),
            s3: uploadConfig.s3.channels.map(ch => ({
                name: ch.name,
                type: 'S3'
            })),
            discord: uploadConfig.discord.channels.map(ch => ({
                name: ch.name,
                type: 'Discord'
            })),
            huggingface: uploadConfig.huggingface.channels.map(ch => ({
                name: ch.name,
                type: 'HuggingFace'
            })),
            webdav: uploadConfig.webdav.channels.map(ch => ({
                name: ch.name,
                type: 'WebDAV'
            }))
        };

        return new Response(JSON.stringify(channels), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Failed to get channels:', error);
        return new Response(JSON.stringify({ error: 'Failed to get channels' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
