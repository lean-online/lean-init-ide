/**
 * 基于 OPFS（Origin Private File System）的分片包落盘存储：
 * 将解压并校验通过的 `.pack` 大文件（Init 260–387 MiB、Std/Mathlib 240 MiB–1.72 GiB）
 * 存入独立目录 `lean-packs-v1/<namespace>/`，避免在主线程与 Worker 间常驻 GB 级
 * SharedArrayBuffer / MEMFS 拷贝，并在二次启动时跳过重下载与 Zstd 解压。
 */

export const OPFS_PACK_ROOT = 'lean-packs-v1';

export type SyncPackReader = {
  read: (buffer: Uint8Array, options?: { at?: number }) => number;
  close: () => void;
};

export type OpfsPackRef = {
  readonly __opfsPack: true;
  readonly dir: string;
  readonly fileName: string;
  readonly bytes: number;
};

export type OpfsWritable = {
  write: (data: BufferSource) => Promise<void>;
  close: () => Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
};

export type OpfsFileHandle = {
  getFile: () => Promise<{ readonly size: number }>;
  createWritable?: () => Promise<OpfsWritable>;
  createSyncAccessHandle?: (options?: {
    mode?: 'read-only' | 'readwrite';
  }) => Promise<SyncPackReader>;
};

export type OpfsDirectoryHandle = {
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<OpfsDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFileHandle>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  keys?: () => AsyncIterable<string>;
};

export type OpfsStorageLike = {
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
};

export type OpfsPackStore = {
  readonly dir: string;
  has: (logicalName: string, sha256: string, expectedBytes: number) => Promise<OpfsPackRef | null>;
  write: (logicalName: string, sha256: string, bytes: Uint8Array) => Promise<OpfsPackRef>;
  prune: (keepFileNames: ReadonlySet<string>) => Promise<void>;
};

export const isOpfsPackRef = (value: unknown): value is OpfsPackRef => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OpfsPackRef>;
  return (
    candidate.__opfsPack === true &&
    typeof candidate.dir === 'string' &&
    candidate.dir.length > 0 &&
    typeof candidate.fileName === 'string' &&
    candidate.fileName.length > 0 &&
    typeof candidate.bytes === 'number' &&
    Number.isInteger(candidate.bytes) &&
    candidate.bytes >= 0
  );
};

export const opfsPackFileName = (logicalName: string, sha256: string): string =>
  `${logicalName.replace(/[^A-Za-z0-9._-]/g, '_')}.${sha256.slice(0, 16)}.bin`;

const resolveStorage = (storage?: OpfsStorageLike): OpfsStorageLike | undefined =>
  storage ??
  (typeof navigator === 'undefined'
    ? undefined
    : (navigator.storage as OpfsStorageLike | undefined));

/**
 * 打开指定命名空间下的 OPFS 分片目录；若宿主不支持 OPFS 主线程写入（如隐私模式、
 * Safari 主线程无 `createWritable`）或权限受限，安全返回 `null` 以便回退到 SAB 内存路径。
 */
export const openOpfsPackStore = async (
  namespace: string,
  storage?: OpfsStorageLike,
): Promise<OpfsPackStore | null> => {
  const resolved = resolveStorage(storage);
  if (typeof resolved?.getDirectory !== 'function') return null;
  if (
    storage === undefined &&
    (typeof FileSystemFileHandle === 'undefined' ||
      typeof FileSystemFileHandle.prototype?.createWritable !== 'function')
  ) {
    return null;
  }

  let dirHandle: OpfsDirectoryHandle;
  try {
    const root = await resolved.getDirectory();
    const packRoot = await root.getDirectoryHandle(OPFS_PACK_ROOT, { create: true });
    dirHandle = await packRoot.getDirectoryHandle(namespace, { create: true });
  } catch {
    return null;
  }

  return {
    dir: namespace,
    async has(logicalName, sha256, expectedBytes) {
      const fileName = opfsPackFileName(logicalName, sha256);
      try {
        const handle = await dirHandle.getFileHandle(fileName);
        const file = await handle.getFile();
        if (file.size === expectedBytes) {
          return { __opfsPack: true, dir: namespace, fileName, bytes: expectedBytes };
        }
        await dirHandle.removeEntry(fileName).catch(() => undefined);
        return null;
      } catch {
        return null;
      }
    },
    async write(logicalName, sha256, bytes) {
      const fileName = opfsPackFileName(logicalName, sha256);
      const handle = await dirHandle.getFileHandle(fileName, { create: true });
      if (typeof handle.createWritable !== 'function') {
        throw new Error('OPFS createWritable is unavailable.');
      }
      const writable = await handle.createWritable();
      // WritableStream.write 拒绝 SharedArrayBuffer 视图；若是共享视图先做一次隔离拷贝。
      const payload =
        typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer
          ? new Uint8Array(bytes)
          : bytes;
      try {
        await writable.write(payload as unknown as BufferSource);
        await writable.close();
      } catch (error) {
        await writable.abort?.(error).catch(() => undefined);
        throw error;
      }
      return { __opfsPack: true, dir: namespace, fileName, bytes: bytes.byteLength };
    },
    async prune(keepFileNames) {
      if (typeof dirHandle.keys !== 'function') return;
      const stale: string[] = [];
      try {
        for await (const name of dirHandle.keys()) {
          if (!keepFileNames.has(name)) stale.push(name);
        }
      } catch {
        return;
      }
      for (const name of stale) {
        await dirHandle.removeEntry(name).catch(() => undefined);
      }
    },
  };
};

/** 清理全部 OPFS 缓存的 Lean 分片目录（供 `?fresh` 等重置场景调用）。 */
export const clearOpfsPackRoot = async (storage?: OpfsStorageLike): Promise<void> => {
  const resolved = resolveStorage(storage);
  if (typeof resolved?.getDirectory !== 'function') return;
  try {
    const root = await resolved.getDirectory();
    await root.removeEntry(OPFS_PACK_ROOT, { recursive: true });
  } catch {
    // OPFS 不可用或目录尚未创建时静默忽略。
  }
};
