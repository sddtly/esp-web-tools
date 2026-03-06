const CORS_PROXY = "https://cors-proxy.espressif.tools";

/**
 * 根据 URL 的来源检查是否需要 CORS 代理
 */
const needsCorsProxy = (url: string): boolean => {
  try {
    const urlObj = new URL(url);
    const currentOrigin = window.location.origin;

    // 同源不需要代理
    if (urlObj.origin === currentOrigin) {
      return false;
    }

    // 本地文件不需要代理
    if (urlObj.protocol === "file:") {
      return false;
    }

    // 不同源需要代理
    return true;
  } catch {
    // 如果 URL 解析失败，假定它是相对路径且不需要代理
    return false;
  }
};

/**
 * 包装 fetch，为跨域请求提供 CORS 代理支持
 */
export const corsProxyFetch = async (
  url: string,
  options?: RequestInit,
): Promise<Response> => {
  // 清理 URL - 去除空白字符和换行符
  url = url.trim();

  if (needsCorsProxy(url)) {
    // GitHub 发布文件不支持 CORS，直接使用代理
    if (url.includes("github.com") && url.includes("/releases/download/")) {
      const proxiedUrl = `${CORS_PROXY}/?url=${encodeURIComponent(url)}`;
      const { headers, credentials, ...safeOptions } = options ?? {};
      return fetch(proxiedUrl, safeOptions);
    }

    // 对于其他跨域请求，先尝试直接 fetch
    try {
      const response = await fetch(url, options);
      return response;
    } catch (directError) {
      // 直接 fetch 失败，尝试使用代理
      try {
        const proxiedUrl = `${CORS_PROXY}/?url=${encodeURIComponent(url)}`;
        const { headers, credentials, ...safeOptions } = options ?? {};
        return await fetch(proxiedUrl, safeOptions);
      } catch (proxyError) {
        // 两者均失败，抛出原始错误
        throw directError;
      }
    }
  }

  return fetch(url, options);
};
