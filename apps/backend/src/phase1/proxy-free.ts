const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

export interface ProxyStripReport {
  removedKeys: string[];
  previousNoProxy: string | undefined;
}

/**
 * Remove local proxy variables inside the current capture/probe process only so
 * direct connections to CEX/DEX endpoints bypass local HTTP/SOCKS proxies without
 * altering host configuration outside this process.
 */
export function stripProcessProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyStripReport {
  const removedKeys: string[] = [];
  for (const key of PROXY_ENV_KEYS) {
    if (env[key] !== undefined) {
      removedKeys.push(key);
      delete env[key];
    }
  }
  const previousNoProxy = env.NO_PROXY ?? env.no_proxy;
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return { removedKeys, previousNoProxy };
}
