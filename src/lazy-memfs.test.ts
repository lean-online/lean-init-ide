import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLazyStreamOps,
  mountLazyMemfsFile,
  openOpfsSyncReader,
  readSegments,
  type LazyFsApi,
  type LazyMemfsNode,
  type LazyMemfsStreamOps,
  type SyncPackReader,
} from './lazy-memfs';
import { OPFS_PACK_ROOT, type OpfsStorageLike } from './opfs-pack-store';

const makeMemoryReader = (
  data: Uint8Array,
  maxPerRead = data.byteLength,
): SyncPackReader & {
  seenBuffers: ArrayBufferLike[];
  closed: boolean;
} => {
  const seenBuffers: ArrayBufferLike[] = [];
  const state = { closed: false };
  return {
    seenBuffers,
    get closed() {
      return state.closed;
    },
    read(buffer: Uint8Array, options?: { at?: number }) {
      seenBuffers.push(buffer.buffer);
      const at = options?.at ?? 0;
      const available = Math.max(0, data.byteLength - at);
      const count = Math.min(available, buffer.byteLength, maxPerRead);
      if (count > 0) buffer.set(data.subarray(at, at + count), 0);
      return count;
    },
    close() {
      state.closed = true;
    },
  };
};

describe('lazy-memfs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('readSegments 支持跨分片拼接、短读重试与 SharedArrayBuffer 隔离写入', () => {
    const r1 = makeMemoryReader(new Uint8Array([0, 10, 11, 12, 99]), 2);
    const r2 = makeMemoryReader(new Uint8Array([20, 21, 22]), 2);
    const segments = [
      { reader: r1, fileOffset: 1, byteLength: 3 },
      { reader: r2, fileOffset: 0, byteLength: 3 },
    ];

    // 普通 ArrayBuffer 读取跨分片区间 [1..5)。
    const out = new Uint8Array(8);
    expect(readSegments(segments, 1, out, 2, 4)).toBe(4);
    expect([...out.subarray(2, 6)]).toEqual([11, 12, 20, 21]);
    expect(readSegments(segments, 0, out, 0, 0)).toBe(0);

    // 写入 SharedArrayBuffer 目标时，绝不将 SAB 传给 SyncAccessHandle.read。
    const sabOut = new Uint8Array(new SharedArrayBuffer(6));
    expect(readSegments(segments, 0, sabOut, 0, 6)).toBe(6);
    expect([...sabOut]).toEqual([10, 11, 12, 20, 21, 22]);
    expect(r1.seenBuffers.every((buf) => !(buf instanceof SharedArrayBuffer))).toBe(true);
    expect(r2.seenBuffers.every((buf) => !(buf instanceof SharedArrayBuffer))).toBe(true);

    // 底层句柄提前 EOF 时停止读取并返回真实已读字节数。
    const truncated = makeMemoryReader(new Uint8Array([1]));
    expect(
      readSegments(
        [{ reader: truncated, fileOffset: 0, byteLength: 4 }],
        0,
        new Uint8Array(4),
        0,
        4,
      ),
    ).toBe(1);
  });

  it('createLazyStreamOps 对齐 MEMFS read 与 mmap（含异常清理 contents）并透传普通节点', () => {
    const baseRead = vi.fn(() => 99);
    let capturedMmapContents: Uint8Array | null = null;
    let shouldThrowInMmap = false;
    const baseMmap = vi.fn((stream: { node: LazyMemfsNode }, length: number, position: number) => {
      capturedMmapContents = stream.node.contents ? new Uint8Array(stream.node.contents) : null;
      if (shouldThrowInMmap) throw new Error('mmap alloc failed');
      return { ptr: 1024, allocated: true, length, position };
    });
    const baseOps: LazyMemfsStreamOps = { read: baseRead, mmap: baseMmap };
    const lazyOps = createLazyStreamOps(baseOps);

    // 无 __lazySegments 时直接透传给原生 MEMFS ops。
    const normalNode: LazyMemfsNode = {
      usedBytes: 3,
      contents: new Uint8Array([1, 2, 3]),
      stream_ops: baseOps,
    };
    expect(lazyOps.read({ node: normalNode }, new Uint8Array(3), 0, 3, 0)).toBe(99);
    expect(baseRead).toHaveBeenCalledTimes(1);
    lazyOps.mmap?.({ node: normalNode }, 3, 1, 1, 0);
    expect(baseMmap).toHaveBeenCalledWith({ node: normalNode }, 3, 1, 1, 0);

    // 挂载懒读节点：按需 read、越界归零、mmap 页对齐长度 > 文件剩余字节、且用后清零 contents。
    const reader = makeMemoryReader(new Uint8Array([10, 11, 12, 13, 14]));
    const lazyNode: LazyMemfsNode = {
      usedBytes: 5,
      contents: null,
      stream_ops: lazyOps,
      __lazySegments: [{ reader, fileOffset: 0, byteLength: 5 }],
    };
    const readBuf = new Uint8Array(4);
    expect(lazyOps.read({ node: lazyNode }, readBuf, 0, 4, 2)).toBe(3);
    expect([...readBuf]).toEqual([12, 13, 14, 0]);
    expect(lazyOps.read({ node: lazyNode }, readBuf, 0, 4, 10)).toBe(0);

    const mapped = lazyOps.mmap?.({ node: lazyNode }, 4096, 2, 1, 1) as {
      ptr: number;
      position: number;
    };
    expect(mapped).toEqual({ ptr: 1024, allocated: true, length: 4096, position: 0 });
    expect([...(capturedMmapContents ?? [])]).toEqual([12, 13, 14]);
    expect(lazyNode.contents).toBeNull();

    // position 超出文件尾或 mmap 内部抛错时，依然保证 finally 清空 contents。
    lazyOps.mmap?.({ node: lazyNode }, 4096, 10, 1, 1);
    expect([...(capturedMmapContents ?? [])]).toEqual([]);
    expect(lazyNode.contents).toBeNull();

    shouldThrowInMmap = true;
    expect(() => lazyOps.mmap?.({ node: lazyNode }, 16, 0, 1, 1)).toThrow('mmap alloc failed');
    expect(lazyNode.contents).toBeNull();
  });

  it('mountLazyMemfsFile 共享包装后的 stream_ops 并将节点 size 设为真实字节数', () => {
    const baseOps: LazyMemfsStreamOps = {
      read: () => 0,
      mmap: () => ({ ptr: 0, allocated: true }),
    };
    const nodes = new Map<string, LazyMemfsNode>();
    const fs: LazyFsApi = {
      mkdirTree: () => {},
      writeFile: (p, data) => {
        nodes.set(p, { usedBytes: data.byteLength, contents: data, stream_ops: baseOps });
      },
      lookupPath: (p) => ({ node: nodes.get(p)! }),
    };
    const opsCache = new WeakMap<LazyMemfsStreamOps, LazyMemfsStreamOps>();
    const reader = makeMemoryReader(new Uint8Array([1, 2, 3, 4]));
    mountLazyMemfsFile(
      fs,
      '/lean/lib/lean/A.olean',
      2,
      [{ reader, fileOffset: 0, byteLength: 2 }],
      opsCache,
    );
    mountLazyMemfsFile(
      fs,
      '/lean/lib/lean/B.olean',
      2,
      [{ reader, fileOffset: 2, byteLength: 2 }],
      opsCache,
    );

    const nodeA = nodes.get('/lean/lib/lean/A.olean')!;
    const nodeB = nodes.get('/lean/lib/lean/B.olean')!;
    expect(nodeA.usedBytes).toBe(2);
    expect(nodeA.contents).toBeNull();
    expect(nodeA.stream_ops).toBe(nodeB.stream_ops);
    expect(nodeA.stream_ops).not.toBe(baseOps);
  });

  it('openOpfsSyncReader 支持 read-only 降级、锁冲突重试与不可用抛错', async () => {
    const reader = makeMemoryReader(new Uint8Array([1, 2]));
    const calls: Array<unknown> = [];
    let attempt = 0;
    const sleep = vi.fn(async () => undefined);

    const makeStorage = (
      impl: (opts?: { mode?: 'read-only' | 'readwrite' }) => Promise<SyncPackReader>,
    ): OpfsStorageLike => ({
      getDirectory: async () => ({
        getDirectoryHandle: async (name) => {
          expect([OPFS_PACK_ROOT, 'wasm64']).toContain(name);
          return {
            getDirectoryHandle: async () => ({
              getDirectoryHandle: async () => {
                throw new Error('unused');
              },
              getFileHandle: async () => ({
                getFile: async () => ({ size: 2 }),
                createSyncAccessHandle: impl,
              }),
              removeEntry: async () => {},
            }),
            getFileHandle: async () => ({
              getFile: async () => ({ size: 2 }),
              createSyncAccessHandle: impl,
            }),
            removeEntry: async () => {},
          };
        },
        getFileHandle: async () => {
          throw new Error('unused');
        },
        removeEntry: async () => {},
      }),
    });

    // TypeError fallback（老浏览器不支持 { mode: 'read-only' }）+ 2 次锁冲突后成功。
    const handle = await openOpfsSyncReader(
      'wasm64',
      'a.bin',
      makeStorage(async (opts) => {
        calls.push(opts);
        if (opts?.mode === 'read-only') throw new TypeError('unsupported options');
        attempt += 1;
        if (attempt < 3) throw new DOMException('locked', 'NoModificationAllowedError');
        return reader;
      }),
      sleep,
    );
    expect(handle).toBe(reader);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({ mode: 'read-only' });

    // 重试耗尽后透传 NoModificationAllowedError。
    await expect(
      openOpfsSyncReader(
        'wasm64',
        'a.bin',
        makeStorage(async () => {
          throw new DOMException('still locked', 'NoModificationAllowedError');
        }),
        sleep,
      ),
    ).rejects.toThrow('still locked');

    // 无 OPFS 时明确抛错以便上层捕获。
    vi.stubGlobal('navigator', {});
    await expect(openOpfsSyncReader('wasm64', 'a.bin')).rejects.toThrow(/OPFS getDirectory/);
  });
});
