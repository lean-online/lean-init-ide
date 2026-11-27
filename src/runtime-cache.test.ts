import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPFS_PACK_ROOT } from './opfs-pack-store';
import { clearRuntimeCache } from './runtime-cache';

describe('clearRuntimeCache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('只删除 wasm-idle 运行时命名空间与 OPFS 分片根目录，保留站点偏好缓存', async () => {
    const deleted: string[] = [];
    const opfsRemoved: Array<{ name: string; opts?: unknown }> = [];
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          removeEntry: async (name: string, opts?: unknown) => {
            opfsRemoved.push({ name, opts });
          },
        }),
      },
    });
    vi.stubGlobal('caches', {
      keys: async () => ['wasm-idle-assets-v1:wasm-idle', 'lean-source', 'other'],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    });

    await clearRuntimeCache();

    expect(deleted).toEqual(['wasm-idle-assets-v1:wasm-idle']);
    expect(opfsRemoved).toEqual([{ name: OPFS_PACK_ROOT, opts: { recursive: true } }]);
  });

  it('没有 CacheStorage 时静默返回', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(clearRuntimeCache()).resolves.toBeUndefined();
  });
});
