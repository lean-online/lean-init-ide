import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPFS_PACK_ROOT,
  clearOpfsPackRoot,
  isOpfsPackRef,
  openOpfsPackStore,
  opfsPackFileName,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type OpfsStorageLike,
  type OpfsWritable,
} from './opfs-pack-store';

type MemFile = { bytes: Uint8Array };

const createFakeOpfs = (options: { throwOnWrite?: Error; noWritable?: boolean } = {}) => {
  const dirs = new Map<string, Map<string, MemFile>>();
  const removedRoots: string[] = [];

  const getOrCreateNamespace = (name: string): Map<string, MemFile> => {
    let map = dirs.get(name);
    if (!map) {
      map = new Map();
      dirs.set(name, map);
    }
    return map;
  };

  const makeDirHandle = (files: Map<string, MemFile>): OpfsDirectoryHandle => ({
    async getDirectoryHandle() {
      return makeDirHandle(files);
    },
    async getFileHandle(fileName, opts) {
      if (!opts?.create && !files.has(fileName)) {
        throw new DOMException('Not found', 'NotFoundError');
      }
      if (opts?.create && !files.has(fileName)) {
        files.set(fileName, { bytes: new Uint8Array(0) });
      }
      const handle: OpfsFileHandle = {
        getFile: async () => ({ size: files.get(fileName)?.bytes.byteLength ?? 0 }),
        ...(options.noWritable
          ? {}
          : {
              createWritable: async (): Promise<OpfsWritable> => {
                let pending = new Uint8Array(0);
                return {
                  write: async (data: BufferSource) => {
                    if (options.throwOnWrite) throw options.throwOnWrite;
                    const view =
                      data instanceof ArrayBuffer
                        ? new Uint8Array(data)
                        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    pending = new Uint8Array(view);
                  },
                  close: async () => {
                    files.set(fileName, { bytes: pending });
                  },
                  abort: vi.fn(async () => undefined),
                };
              },
            }),
      };
      return handle;
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async *keys() {
      for (const key of files.keys()) yield key;
    },
  });

  const rootDir: OpfsDirectoryHandle = {
    async getDirectoryHandle(name) {
      if (name !== OPFS_PACK_ROOT) throw new Error(`Unexpected root child: ${name}`);
      return {
        async getDirectoryHandle(ns) {
          return makeDirHandle(getOrCreateNamespace(ns));
        },
        async getFileHandle() {
          throw new Error('not expected');
        },
        async removeEntry() {},
      };
    },
    async getFileHandle() {
      throw new Error('not expected');
    },
    async removeEntry(name) {
      removedRoots.push(name);
      if (name === OPFS_PACK_ROOT) dirs.clear();
    },
  };

  const storage: OpfsStorageLike = {
    getDirectory: async () => rootDir,
  };
  return { storage, dirs, removedRoots };
};

describe('opfs-pack-store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('isOpfsPackRef 严格校验结构与字节数字段', () => {
    expect(isOpfsPackRef({ __opfsPack: true, dir: 'wasm64', fileName: 'a.bin', bytes: 0 })).toBe(
      true,
    );
    expect(isOpfsPackRef({ __opfsPack: true, dir: 'wasm64', fileName: 'a.bin', bytes: 128 })).toBe(
      true,
    );
    expect(isOpfsPackRef(null)).toBe(false);
    expect(isOpfsPackRef(new ArrayBuffer(8))).toBe(false);
    expect(isOpfsPackRef({ __opfsPack: true, dir: '', fileName: 'a.bin', bytes: 1 })).toBe(false);
    expect(isOpfsPackRef({ __opfsPack: true, dir: 'wasm64', fileName: 'a.bin', bytes: -1 })).toBe(
      false,
    );
    expect(isOpfsPackRef({ __opfsPack: true, dir: 'wasm64', fileName: 'a.bin', bytes: 1.5 })).toBe(
      false,
    );
  });

  it('opfsPackFileName 对逻辑名做安全转义并附带哈希前缀', () => {
    expect(opfsPackFileName('lean-init/00.pack', 'abcdef0123456789ffff')).toBe(
      'lean-init_00.pack.abcdef0123456789.bin',
    );
  });

  it('读写命中、长度不符驱逐、SAB 安全复制、过期清理与根目录清除', async () => {
    const { storage, dirs, removedRoots } = createFakeOpfs();
    const store = await openOpfsPackStore('wasm64-test', storage);
    expect(store).not.toBeNull();

    const sha = '0123456789abcdef'.repeat(4);
    expect(await store!.has('lean-init-64-00.pack', sha, 4)).toBeNull();

    const ref = await store!.write('lean-init-64-00.pack', sha, new Uint8Array([1, 2, 3, 4]));
    expect(ref).toEqual({
      __opfsPack: true,
      dir: 'wasm64-test',
      fileName: opfsPackFileName('lean-init-64-00.pack', sha),
      bytes: 4,
    });
    expect(await store!.has('lean-init-64-00.pack', sha, 4)).toEqual(ref);

    // 尺寸不符的损坏条目会自动驱逐并返回 null。
    expect(await store!.has('lean-init-64-00.pack', sha, 99)).toBeNull();
    expect(dirs.get('wasm64-test')?.has(ref.fileName)).toBe(false);

    // 支持写入 SharedArrayBuffer 视图，不因共享内存报错。
    const sabView = new Uint8Array(new SharedArrayBuffer(3));
    sabView.set([7, 8, 9]);
    const ref2 = await store!.write('lean-std-64-00.pack', sha, sabView);
    expect([...(dirs.get('wasm64-test')?.get(ref2.fileName)?.bytes ?? [])]).toEqual([7, 8, 9]);

    // prune 保留指定集合，清理多余条目。
    const ref3 = await store!.write('stale.pack', sha, new Uint8Array([5]));
    expect(dirs.get('wasm64-test')?.has(ref3.fileName)).toBe(true);
    await store!.prune(new Set([ref2.fileName]));
    expect(dirs.get('wasm64-test')?.has(ref2.fileName)).toBe(true);
    expect(dirs.get('wasm64-test')?.has(ref3.fileName)).toBe(false);

    await clearOpfsPackRoot(storage);
    expect(removedRoots).toEqual([OPFS_PACK_ROOT]);
    expect(dirs.size).toBe(0);
  });

  it('write 失败会中止流并向上抛错，缺少 createWritable 时拒绝写入', async () => {
    const failing = createFakeOpfs({ throwOnWrite: new Error('disk full') });
    const storeFail = await openOpfsPackStore('ns', failing.storage);
    await expect(storeFail!.write('a.pack', 'a'.repeat(64), new Uint8Array([1]))).rejects.toThrow(
      'disk full',
    );

    const noWritable = createFakeOpfs({ noWritable: true });
    const storeReadOnly = await openOpfsPackStore('ns', noWritable.storage);
    await expect(
      storeReadOnly!.write('a.pack', 'a'.repeat(64), new Uint8Array([1])),
    ).rejects.toThrow(/createWritable/);
  });

  it('OPFS 不可用或抛错时安全降级返回 null，clearOpfsPackRoot 静默返回', async () => {
    vi.stubGlobal('navigator', {});
    expect(await openOpfsPackStore('ns')).toBeNull();
    await expect(clearOpfsPackRoot()).resolves.toBeUndefined();

    const throwingStorage: OpfsStorageLike = {
      getDirectory: async () => {
        throw new Error('SecurityError');
      },
    };
    expect(await openOpfsPackStore('ns', throwingStorage)).toBeNull();
    await expect(clearOpfsPackRoot(throwingStorage)).resolves.toBeUndefined();
  });
});
