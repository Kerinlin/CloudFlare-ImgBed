import {
    readIndex, mergeOperationsToIndex, deleteAllOperations, rebuildIndex,
    getIndexInfo, getIndexStorageStats
} from '../../utils/indexManager.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { createMetadataViewContext, serializeFileRecordForManagement } from '../../utils/metadata/metadataView.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, waitUntil } = context;
    const url = new URL(request.url);
    const identity = context.data?.identity || { scope: 'admin' };

    // 解析查询参数
    let start = parseInt(url.searchParams.get('start'), 10) || 0;
    let count = parseInt(url.searchParams.get('count'), 10) || 50;
    let sum = url.searchParams.get('sum') === 'true';
    let recursive = url.searchParams.get('recursive') === 'true';
    let dir = url.searchParams.get('dir') || '';
    let search = url.searchParams.get('search') || '';
    let channel = url.searchParams.get('channel') || '';
    let listType = url.searchParams.get('listType') || '';
    let accessStatus = url.searchParams.get('accessStatus') || '';
    let action = url.searchParams.get('action') || '';
    let includeTags = url.searchParams.get('includeTags') || '';
    let excludeTags = url.searchParams.get('excludeTags') || '';
    let label = url.searchParams.get('label') || '';
    let fileType = url.searchParams.get('fileType') || '';
    let channelName = url.searchParams.get('channelName') || '';

    // 处理搜索关键字
    if (search) {
        search = decodeURIComponent(search).trim();
    }

    // 处理标签参数
    const includeTagsArray = includeTags ? includeTags.split(',').map(t => t.trim()).filter(t => t) : [];
    const excludeTagsArray = excludeTags ? excludeTags.split(',').map(t => t.trim()).filter(t => t) : [];

    // 处理筛选参数（支持逗号分隔的多选）
    const listTypeArray = listType ? listType.split(',').map(t => t.trim()).filter(t => t) : [];
    const accessStatusArray = accessStatus ? accessStatus.split(',').map(t => t.trim()).filter(t => t) : [];
    const labelArray = label ? label.split(',').map(t => t.trim()).filter(t => t) : [];
    const fileTypeArray = fileType ? fileType.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelArray = channel ? channel.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelNameArray = channelName ? channelName.split(',').map(t => t.trim()).filter(t => t) : [];

    // 处理目录参数
    if (dir) {
        // 路径安全处理：防止路径穿越
        dir = dir.replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    }
    if (dir.startsWith('/')) {
        dir = dir.substring(1);
    }
    if (dir && !dir.endsWith('/')) {
        dir += '/';
    }

    try {
        // 特殊操作：重建索引（仅管理员，middleware 已拦；双保险）
        if (action === 'rebuild') {
            if (identity.scope === 'user') {
                return new Response('Forbidden', { status: 403, headers: corsHeaders });
            }
            waitUntil(rebuildIndex(context, (processed) => {
                console.log(`Rebuilt ${processed} files...`);
            }));

            return new Response('Index rebuilt asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：合并挂起的原子操作到索引
        if (action === 'merge-operations') {
            waitUntil(mergeOperationsToIndex(context));

            return new Response('Operations merged into index asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：清除所有原子操作
        if (action === 'delete-operations') {
            waitUntil(deleteAllOperations(context));

            return new Response('All operations deleted asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引存储信息
        if (action === 'index-storage-stats') {
            const stats = await getIndexStorageStats(context);
            return new Response(JSON.stringify(stats), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引信息
        if (action === 'info') {
            const info = await getIndexInfo(context, {
                timezoneOffset: url.searchParams.get('timezoneOffset'),
                maxPoints: url.searchParams.get('trendMaxPoints'),
                seriesLimit: url.searchParams.get('trendSeriesLimit'),
                startDate: url.searchParams.get('trendStartDate'),
                endDate: url.searchParams.get('trendEndDate')
            });
            return new Response(JSON.stringify(info), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        const ownerFilter = (identity.scope === 'user' && identity.userId)
            ? identity.userId
            : null;

        // 普通查询：只返回总数
        if (count === -1 && sum) {
            const result = await readIndex(context, {
                search,
                directory: dir,
                channel: channelArray,
                listType: listTypeArray,
                accessStatus: accessStatusArray,
                label: labelArray,
                fileType: fileTypeArray,
                channelName: channelNameArray,
                includeTags: includeTagsArray,
                excludeTags: excludeTagsArray,
                countOnly: true
            });

            let totalCount = result.totalCount;
            // 用户：countOnly 无法按 owner 精确计数时改为拉全量过滤（首期）
            if (ownerFilter) {
                const full = await readIndex(context, {
                    search,
                    directory: dir,
                    channel: channelArray,
                    listType: listTypeArray,
                    accessStatus: accessStatusArray,
                    label: labelArray,
                    fileType: fileTypeArray,
                    channelName: channelNameArray,
                    includeTags: includeTagsArray,
                    excludeTags: excludeTagsArray,
                    start: 0,
                    count: -1,
                    includeSubdirFiles: recursive,
                });
                totalCount = filterFilesByOwner(full.files || [], ownerFilter).length;
            }

            return new Response(JSON.stringify({
                sum: totalCount,
                indexLastUpdated: result.indexLastUpdated
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 普通查询：返回数据
        // 用户隔离时先取较大窗口再过滤分页（首期策略）
        const fetchCount = ownerFilter ? -1 : count;
        const fetchStart = ownerFilter ? 0 : start;

        const result = await readIndex(context, {
            search,
            directory: dir,
            start: fetchStart,
            count: fetchCount,
            channel: channelArray,
            listType: listTypeArray,
            accessStatus: accessStatusArray,
            label: labelArray,
            fileType: fileTypeArray,
            channelName: channelNameArray,
            includeTags: includeTagsArray,
            excludeTags: excludeTagsArray,
            includeSubdirFiles: recursive,
        });

        // 索引读取失败，直接从 KV 中获取所有文件记录
        if (!result.success) {
            const dbRecords = await getAllFileRecords(context.env, dir);
            let files = dbRecords.files;
            if (ownerFilter) {
                files = filterFilesByOwner(files, ownerFilter);
                const total = files.length;
                files = files.slice(start, count > 0 ? start + count : undefined);
                return new Response(JSON.stringify({
                    files,
                    directories: ownerFilter ? deriveDirsFromFiles(files, dir) : dbRecords.directories,
                    totalCount: total,
                    directFileCount: files.length,
                    directFolderCount: 0,
                    returnedCount: files.length,
                    indexLastUpdated: Date.now(),
                    isIndexedResponse: false
                }), {
                    headers: { "Content-Type": "application/json", ...corsHeaders }
                });
            }

            return new Response(JSON.stringify({
                files: dbRecords.files,
                directories: dbRecords.directories,
                totalCount: dbRecords.totalCount,
                directFileCount: dbRecords.directFileCount,
                directFolderCount: dbRecords.directFolderCount,
                returnedCount: dbRecords.returnedCount,
                indexLastUpdated: Date.now(),
                isIndexedResponse: false // 标记这是来自 KV 的响应
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        let files = result.files || [];
        let directories = result.directories || [];
        let totalCount = result.totalCount;

        if (ownerFilter) {
            files = filterFilesByOwner(files, ownerFilter);
            totalCount = files.length;
            directories = deriveDirsFromFiles(files, dir);
            if (count > 0) {
                files = files.slice(start, start + count);
            } else if (start > 0) {
                files = files.slice(start);
            }
        }

        const db = getDatabase(context.env);
        const metadataViewContext = await createMetadataViewContext(db, context.env);

        // 转换文件格式
        const compatibleFiles = await Promise.all(
            files.map(file => serializeFileRecordForManagement(db, context.env, file, metadataViewContext))
        );

        return new Response(JSON.stringify({
            files: compatibleFiles,
            directories,
            totalCount,
            directFileCount: ownerFilter ? compatibleFiles.length : result.directFileCount,
            directFolderCount: ownerFilter ? directories.length : result.directFolderCount,
            returnedCount: compatibleFiles.length,
            indexLastUpdated: result.indexLastUpdated,
            isIndexedResponse: true // 标记这是来自索引的响应
        }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });

    } catch (error) {
        console.error('Error in list-indexed API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }
}

/**
 * 按 OwnerId 过滤文件（用户隔离；null 仅管理员可见）
 */
function filterFilesByOwner(files, ownerId) {
    if (!ownerId || !Array.isArray(files)) return files || [];
    return files.filter((file) => {
        const meta = file.metadata || file;
        const oid = meta.OwnerId || meta.ownerId || null;
        return oid === ownerId;
    });
}

/**
 * 从用户可见文件推导目录列表
 */
function deriveDirsFromFiles(files, baseDir = '') {
    const dirs = new Set();
    const prefix = baseDir || '';
    for (const file of files || []) {
        const name = file.name || file.id || '';
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash !== -1) {
            dirs.add(prefix + rest.slice(0, slash));
        }
    }
    return Array.from(dirs);
}

async function getAllFileRecords(env, dir) {
    const allRecords = [];
    let cursor = null;

    try {
        const db = getDatabase(env);
        const metadataViewContext = await createMetadataViewContext(db, env);

        while (true) {
            const response = await db.list({
                prefix: dir,
                limit: 1000,
                cursor: cursor
            });

            // 检查响应格式
            if (!response || !response.keys || !Array.isArray(response.keys)) {
                console.error('Invalid response from database list:', response);
                break;
            }

            cursor = response.cursor;

            for (const item of response.keys) {
                // 跳过管理相关的键
                if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
                    continue;
                }

                // 跳过没有元数据的文件
                if (!item.metadata || !item.metadata.TimeStamp) {
                    continue;
                }

                allRecords.push(await serializeFileRecordForManagement(db, env, item, metadataViewContext));
            }

            if (!cursor) break;

            // 添加协作点
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 提取目录信息
        const directories = new Set();
        const filteredRecords = [];
        allRecords.forEach(item => {
            const subDir = item.name.substring(dir.length);
            const firstSlashIndex = subDir.indexOf('/');
            if (firstSlashIndex !== -1) {
                directories.add(dir + subDir.substring(0, firstSlashIndex));
            } else {
                filteredRecords.push(item);
            }
        });

        return {
            files: filteredRecords,
            directories: Array.from(directories),
            totalCount: allRecords.length,
            directFileCount: filteredRecords.length,
            directFolderCount: directories.size,
            returnedCount: filteredRecords.length
        };

    } catch (error) {
        console.error('Error in getAllFileRecords:', error);
        return {
            files: [],
            directories: [],
            totalCount: 0,
            directFileCount: 0,
            directFolderCount: 0,
            returnedCount: 0,
            error: error.message
        };
    }
}
