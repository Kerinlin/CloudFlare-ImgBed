import { authenticate, AUTH_SCOPE } from "../../utils/auth/authCore.js";

const DEFAULT_MANAGE_CACHE_CONTROL = 'private, no-store, max-age=0';

/** 普通用户可访问的 manage 路径片段（仍需 owner 过滤） */
const USER_ALLOWED_SEGMENTS = [
  'list',
  'delete',
  'move',
  'rename',
  'metadata',
  'tags',
  'block',
  'white',
];

function withDefaultCacheControl(response) {
  if (response.headers.has('Cache-Control')) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', DEFAULT_MANAGE_CACHE_CONTROL);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function errorHandling(context) {
  try {
    return withDefaultCacheControl(await context.next());
  } catch (err) {
    return new Response(`${err.message}\n${err.stack}`, {
      status: 500,
      headers: {
        'Cache-Control': DEFAULT_MANAGE_CACHE_CONTROL,
      },
    });
  }
}

function UnauthorizedException(reason) {
  return new Response(reason, {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
      'Content-Length': reason.length,
    },
  });
}

function ForbiddenException(reason) {
  return new Response(reason, {
    status: 403,
    statusText: 'Forbidden',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 根据请求路径提取所需权限
 */
function extractRequiredPermission(pathname) {
  const pathParts = pathname.toLowerCase().split('/');

  if (pathParts.includes('delete')) {
    return 'delete';
  }

  if (pathParts.includes('list')) {
    return 'list';
  }

  return 'manage';
}

/**
 * 路径是否允许普通用户（带 owner 过滤）访问
 */
function isUserAllowedPath(pathname) {
  const lower = pathname.toLowerCase();
  // 明确禁止
  if (
    lower.includes('/sysconfig') ||
    lower.includes('/users') ||
    lower.includes('/apitokens') ||
    lower.includes('/useruploadconfig') ||
    lower.includes('/cusconfig') ||
    lower.includes('/batch') ||
    lower.includes('/quota')
  ) {
    return false;
  }
  return USER_ALLOWED_SEGMENTS.some((seg) => lower.includes(`/${seg}`));
}

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

async function authentication(context) {
  // OPTIONS 预检请求不需要鉴权
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  const pathname = new URL(context.request.url).pathname;
  const requiredPermission = extractRequiredPermission(pathname);
  const userAllowed = isUserAllowedPath(pathname);

  // 用户可访问路径：either；其余：admin only
  const authScope = userAllowed ? AUTH_SCOPE.EITHER : AUTH_SCOPE.ADMIN;

  const result = await authenticate({
    env: context.env,
    request: context.request,
    requiredPermission: userAllowed && requiredPermission !== 'manage' ? requiredPermission : (userAllowed ? null : requiredPermission),
    authScope,
  });

  if (!result.authorized) {
    return UnauthorizedException('You need to login');
  }

  // 普通用户禁止 admin-only 路径（double check）
  if (result.scope === 'user' && !userAllowed) {
    return ForbiddenException('Forbidden');
  }

  // 用户 token 的 manage 权限不能越过 admin 路径
  if (result.scope === 'user' && requiredPermission === 'manage' && !userAllowed) {
    return ForbiddenException('Forbidden');
  }

  // 特殊 list actions 仅 admin（rebuild 等）
  if (result.scope === 'user' && pathname.toLowerCase().includes('/list')) {
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || '';
    if (action && action !== '') {
      return ForbiddenException('Forbidden');
    }
  }

  if (!context.data) context.data = {};
  context.data.identity = result;

  return context.next();
}

export const onRequest = [errorHandling, authentication];
