/**
 * 清理 Lean 运行时资产缓存。
 *
 * 运行时字节由 @wasm-idle/core 的持久缓存放在 CacheStorage 的
 * `wasm-idle-assets-v1:<namespace>` 里，解压后的分片也保存在 OPFS 的
 * `lean-packs-v1` 目录；这里一并删掉，避免把站点自己的 `lean-source`
 * 等偏好设置一起清掉。IndexedDB 里只是元数据，下次读取发现 body 缺失
 * 会自动移除并重新下载，不需要在这里阻塞等待删库。
 */
import { clearOpfsPackRoot } from './opfs-pack-store';

const RUNTIME_CACHE_PREFIX = 'wasm-idle-assets-v1:';

export const clearRuntimeCache = async (): Promise<void> => {
  await clearOpfsPackRoot();
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(RUNTIME_CACHE_PREFIX))
      .map((name) => caches.delete(name)),
  );
};
