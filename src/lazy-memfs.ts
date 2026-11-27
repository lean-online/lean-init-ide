/**
 * Emscripten MEMFS 懒读与懒 mmap 适配器（Worker 专用）：
 *
 * 将 `.pack` 分片保留在 OPFS 磁盘上，启动时只在 MEMFS 注册 0 字节节点与分段描述符；
 * 只有当 Lean 真正 `read()` 或 `mmap()` 打开某个 `.olean`/`.ir` 文件时，才通过
 * `FileSystemSyncAccessHandle.read()` 同步按段读取，并在 `mmap` 拷入 Wasm 线性内存后
 * 立刻释放 JS 临时缓冲，避免未用到的 2 GB 库文件占满浏览器内存。
 */
import { OPFS_PACK_ROOT, type OpfsStorageLike, type SyncPackReader } from './opfs-pack-store';

export type { SyncPackReader };

export type LazyFileSegment = {
  readonly reader: SyncPackReader;
  readonly fileOffset: number;
  readonly byteLength: number;
};

export type LazyMemfsNode = {
  usedBytes: number;
  contents: Uint8Array | null;
  stream_ops: LazyMemfsStreamOps;
  __lazySegments?: readonly LazyFileSegment[];
};

export type LazyMemfsStreamOps = {
  read: (
    stream: { node: LazyMemfsNode },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  mmap?: (
    stream: { node: LazyMemfsNode },
    length: number,
    position: number,
    prot: number,
    flags: number,
  ) => unknown;
  [key: string]: unknown;
};

export type LazyFsApi = {
  mkdirTree: (path: string) => void;
  writeFile: (path: string, data: Uint8Array, options?: { canOwn?: boolean }) => void;
  lookupPath?: (path: string) => { node: LazyMemfsNode };
};

const EMPTY_BYTES = new Uint8Array(0);
const SCRATCH_CHUNK_BYTES = 256 * 1024;
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320] as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readExactFromSegment = (
  reader: SyncPackReader,
  fileAt: number,
  dest: Uint8Array,
  destOffset: number,
  byteLength: number,
  scratch?: Uint8Array,
): number => {
  const isShared =
    typeof SharedArrayBuffer === 'function' && dest.buffer instanceof SharedArrayBuffer;
  if (isShared) {
    // FileSystemSyncAccessHandle.read 拒绝 SharedArrayBuffer 视图（如 Emscripten HEAPU8）；
    // 使用模块级可复用非共享 scratch 分块中转，避免为每次小读新建分配。
    const buf = scratch ?? new Uint8Array(SCRATCH_CHUNK_BYTES);
    let done = 0;
    while (done < byteLength) {
      const chunkLen = Math.min(byteLength - done, buf.byteLength);
      const read = reader.read(buf.subarray(0, chunkLen), { at: fileAt + done });
      if (read <= 0) break;
      dest.set(buf.subarray(0, read), destOffset + done);
      done += read;
    }
    return done;
  }

  let done = 0;
  while (done < byteLength) {
    const read = reader.read(dest.subarray(destOffset + done, destOffset + byteLength), {
      at: fileAt + done,
    });
    if (read <= 0) break;
    done += read;
  }
  return done;
};

/** 从逻辑文件偏移 `position` 起，按段连续读取最多 `length` 字节写入 `dest[destOffset..]`。 */
export const readSegments = (
  segments: readonly LazyFileSegment[],
  position: number,
  dest: Uint8Array,
  destOffset: number,
  length: number,
  scratch?: Uint8Array,
): number => {
  if (length <= 0) return 0;
  let segStart = 0;
  let totalRead = 0;

  for (const segment of segments) {
    const segEnd = segStart + segment.byteLength;
    const readStart = Math.max(position, segStart);
    const readEnd = Math.min(position + length, segEnd);
    if (readStart < readEnd) {
      const overlapLen = readEnd - readStart;
      const done = readExactFromSegment(
        segment.reader,
        segment.fileOffset + (readStart - segStart),
        dest,
        destOffset + (readStart - position),
        overlapLen,
        scratch,
      );
      totalRead += done;
      if (done < overlapLen) break;
    }
    segStart = segEnd;
  }

  return totalRead;
};

/** 包装 MEMFS 原生 `stream_ops`：`read` / `mmap` 仅对带 `__lazySegments` 的节点按需走 OPFS。 */
export const createLazyStreamOps = (baseOps: LazyMemfsStreamOps): LazyMemfsStreamOps => {
  const scratch = new Uint8Array(SCRATCH_CHUNK_BYTES);
  const baseMmap = baseOps.mmap;

  return {
    ...baseOps,
    read(stream, buffer, offset, length, position) {
      const segments = stream.node.__lazySegments;
      if (!segments) {
        return baseOps.read(stream, buffer, offset, length, position);
      }
      const available = Math.max(0, stream.node.usedBytes - position);
      const toRead = Math.min(available, length);
      if (toRead <= 0) return 0;
      return readSegments(segments, position, buffer, offset, toRead, scratch);
    },
    ...(baseMmap
      ? {
          mmap(stream, length, position, prot, flags) {
            const segments = stream.node.__lazySegments;
            if (!segments) {
              return baseMmap(stream, length, position, prot, flags);
            }
            const available = Math.max(0, stream.node.usedBytes - position);
            const actual = Math.min(available, length);
            const temp = new Uint8Array(actual);
            if (actual > 0) {
              readSegments(segments, position, temp, 0, actual);
            }
            stream.node.contents = temp;
            try {
              // temp 已从 position 起始精确切片：传入 position=0 给 Emscripten 原生 mmap，
              // 它会在 Wasm 线性内存中 mmapAlloc(length) 并拷入 temp，随后立刻归还 temp。
              return baseMmap(stream, length, 0, prot, flags);
            } finally {
              stream.node.contents = null;
            }
          },
        }
      : {}),
  };
};

/** 在 Worker 内打开 OPFS 分片的同步读句柄；优先 `read-only`，遇到重启锁冲突时指数退避重试。 */
export const openOpfsSyncReader = async (
  dirName: string,
  fileName: string,
  storage?: OpfsStorageLike,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<SyncPackReader> => {
  const resolved =
    storage ??
    (typeof navigator === 'undefined'
      ? undefined
      : (navigator.storage as OpfsStorageLike | undefined));
  if (typeof resolved?.getDirectory !== 'function') {
    throw new Error('OPFS getDirectory is unavailable in this worker.');
  }

  const root = await resolved.getDirectory();
  const packRoot = await root.getDirectoryHandle(OPFS_PACK_ROOT);
  const dir = await packRoot.getDirectoryHandle(dirName);
  const file = await dir.getFileHandle(fileName);
  if (typeof file.createSyncAccessHandle !== 'function') {
    throw new Error('OPFS createSyncAccessHandle is unavailable.');
  }

  const openOnce = async (): Promise<SyncPackReader> => {
    try {
      return await file.createSyncAccessHandle!({ mode: 'read-only' });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (error instanceof TypeError || name === 'NotSupportedError') {
        return await file.createSyncAccessHandle!();
      }
      throw error;
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openOnce();
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'NoModificationAllowedError' && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw error;
    }
  }
};

/** 在 MEMFS 中创建 0 字节懒读文件节点，供成千上万个 `.olean` 共享同一份包装后的 `stream_ops`。 */
export const mountLazyMemfsFile = (
  fs: LazyFsApi,
  target: string,
  byteLength: number,
  segments: readonly LazyFileSegment[],
  opsCache: WeakMap<LazyMemfsStreamOps, LazyMemfsStreamOps>,
): void => {
  fs.writeFile(target, EMPTY_BYTES);
  const node = fs.lookupPath!(target).node;
  let lazyOps = opsCache.get(node.stream_ops);
  if (!lazyOps) {
    lazyOps = createLazyStreamOps(node.stream_ops);
    opsCache.set(node.stream_ops, lazyOps);
  }
  node.usedBytes = byteLength;
  node.contents = null;
  node.__lazySegments = segments;
  node.stream_ops = lazyOps;
};
