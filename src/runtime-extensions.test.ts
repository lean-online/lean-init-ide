// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpfsDirectoryHandle, OpfsStorageLike } from './opfs-pack-store';

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

// 真实场景回归夹具：
// 1. wasm32 包含 > 2 MiB 大分片，强制走同源 Range 分片下载并汇报连续进度；
// 2. wasm64 索引 chunk.path 不带 `.bin` 且缺少 uncompressedSha256，需自动匹配清单中的 `.zst.bin` 与回执哈希。
const { rawSmall, compSmall, rawLarge, compLarge, emptyIndexBytes } = vi.hoisted(() => ({
  rawSmall: new Uint8Array([10, 20, 30, 40]),
  compSmall: new Uint8Array([1, 2, 3]),
  rawLarge: new Uint8Array([55, 66, 77, 88]),
  compLarge: new Uint8Array(2 * 1024 * 1024 + 128).fill(7),
  emptyIndexBytes: new TextEncoder().encode(JSON.stringify({ chunks: [], files: [] })),
}));

vi.mock('../config/lean4-runtime.json', async () => {
  const indexBytes = new TextEncoder().encode(
    JSON.stringify({
      chunks: [
        {
          path: 'lean-batteries-00.pack.gz.bin',
          offset: 0,
          uncompressedBytes: rawLarge.byteLength,
          uncompressedSha256: await (async () => {
            const c = new Uint8Array(rawLarge);
            const d = await globalThis.crypto.subtle.digest('SHA-256', c.buffer);
            return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
          })(),
        },
      ],
      files: [],
    }),
  );
  const digestOf = async (b: Uint8Array) => {
    const c = new Uint8Array(b);
    const d = await globalThis.crypto.subtle.digest('SHA-256', c.buffer);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return {
    default: {
      schemaVersion: 1,
      cacheKey: 'z-test-32',
      runtime: 'test32',
      bucket: '',
      primary: { label: 'Pages', baseUrl: '/cdn/' },
      fallback: { label: 'GitHub', baseUrl: 'https://github.com/test/' },
      mirror: { label: 'Mirror', baseUrl: 'https://mirror.example.com/', prefix: 'wasm-lean4' },
      assets: [],
      extensions: [
        {
          id: 'std',
          label: 'Std',
          requires: [],
          assets: [
            {
              name: 'lean-std.index.json',
              key: 'wasm-lean4/ext/lean-std.index.json',
              bytes: emptyIndexBytes.byteLength,
              sha256: await digestOf(emptyIndexBytes),
              contentType: 'application/json',
            },
          ],
        },
        {
          id: 'batteries',
          label: 'Batteries',
          requires: ['std'],
          assets: [
            {
              name: 'lean-batteries.index.json',
              key: 'wasm-lean4/ext/lean-batteries.index.json',
              bytes: indexBytes.byteLength,
              sha256: await digestOf(indexBytes),
              contentType: 'application/json',
            },
            {
              name: 'lean-batteries-00.pack.gz.bin',
              key: 'wasm-lean4/ext/lean-batteries-00.pack.gz.bin',
              bytes: compLarge.byteLength,
              sha256: await digestOf(compLarge),
              contentType: 'application/octet-stream',
            },
          ],
        },
      ],
    },
  };
});

vi.mock('../config/lean4-wasm64-runtime.json', async () => {
  const digestOf = async (b: Uint8Array) => {
    const c = new Uint8Array(b);
    const d = await globalThis.crypto.subtle.digest('SHA-256', c.buffer);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const stdIdx = new TextEncoder().encode(
    JSON.stringify({
      // 还原真实线上 wasm64 索引：chunk.path 无 .bin，且条目没有 uncompressedSha256。
      chunks: [
        { path: 'lean-std-64-00.pack.zst', offset: 0, uncompressedBytes: rawSmall.byteLength },
      ],
      files: [],
    }),
  );
  const mathIdx = new TextEncoder().encode(
    JSON.stringify({
      chunks: [
        { path: 'lean-mathlib-64-00.pack.zst', offset: 0, uncompressedBytes: rawSmall.byteLength },
      ],
      files: [],
    }),
  );
  return {
    default: {
      schemaVersion: 1,
      experimental: true,
      arch: 'wasm64',
      cacheKey: 'w64-test',
      runtime: 'test64',
      bucket: '',
      primary: { label: 'Pages', baseUrl: '/cdn/' },
      fallback: { label: 'GitHub', baseUrl: 'https://github.com/test64/' },
      mirror: { label: 'Mirror', baseUrl: 'https://mirror.example.com/', prefix: 'wasm64' },
      assets: [],
      extensions: [
        {
          id: 'std',
          label: 'Std / Lean',
          requires: [],
          assets: [
            {
              name: 'lean-std-64.index.json',
              key: 'wasm64/ext/lean-std-64.index.json',
              bytes: stdIdx.byteLength,
              sha256: await digestOf(stdIdx),
              contentType: 'application/json',
            },
            {
              name: 'lean-std-64-00.pack.zst.bin',
              key: 'wasm64/ext/lean-std-64-00.pack.zst.bin',
              bytes: compSmall.byteLength,
              sha256: await digestOf(compSmall),
              contentType: 'application/octet-stream',
              encoding: 'zstd',
              uncompressedBytes: rawSmall.byteLength,
              uncompressedSha256: await digestOf(rawSmall),
            },
          ],
        },
        {
          id: 'mathlib',
          label: 'Mathlib',
          requires: ['std'],
          assets: [
            {
              name: 'lean-mathlib-64.index.json',
              key: 'wasm64/ext/lean-mathlib-64.index.json',
              bytes: mathIdx.byteLength,
              sha256: await digestOf(mathIdx),
              contentType: 'application/json',
            },
            {
              name: 'lean-mathlib-64-00.pack.zst.bin',
              key: 'wasm64/ext/lean-mathlib-64-00.pack.zst.bin',
              bytes: compSmall.byteLength,
              sha256: await digestOf(compSmall),
              contentType: 'application/octet-stream',
              encoding: 'zstd',
              uncompressedBytes: rawSmall.byteLength,
              uncompressedSha256: await digestOf(rawSmall),
            },
          ],
        },
      ],
    },
  };
});

const w32IndexBytes = enc({
  chunks: [
    {
      path: 'lean-batteries-00.pack.gz.bin',
      offset: 0,
      uncompressedBytes: rawLarge.byteLength,
      uncompressedSha256: await sha256(rawLarge),
    },
  ],
  files: [],
});
const w64StdIndexBytes = enc({
  chunks: [{ path: 'lean-std-64-00.pack.zst', offset: 0, uncompressedBytes: rawSmall.byteLength }],
  files: [],
});
const w64MathlibIndexBytes = enc({
  chunks: [
    { path: 'lean-mathlib-64-00.pack.zst', offset: 0, uncompressedBytes: rawSmall.byteLength },
  ],
  files: [],
});

const { loadExtensionPacks } = await import('./runtime-extensions');

const createMockOpfs = (): {
  storage: OpfsStorageLike;
  files: Map<string, Uint8Array>;
} => {
  const files = new Map<string, Uint8Array>();
  const ensureDir = (prefix: string): OpfsDirectoryHandle => ({
    getDirectoryHandle: async (name: string) => ensureDir(`${prefix}/${name}`),
    removeEntry: async () => {},
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      const key = `${prefix}/${name}`;
      if (!files.has(key) && !opts?.create) throw new Error('NotFoundError');
      return {
        getFile: async () => {
          const data = files.get(key) ?? new Uint8Array();
          return {
            size: data.byteLength,
            arrayBuffer: async () =>
              data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
          };
        },
        createWritable: async () => {
          const chunks: Uint8Array[] = [];
          return {
            write: async (chunk: BufferSource | Blob | string) => {
              if (chunk instanceof Uint8Array) chunks.push(new Uint8Array(chunk));
              else if (ArrayBuffer.isView(chunk)) {
                chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              }
            },
            close: async () => {
              const total = chunks.reduce((s, c) => s + c.byteLength, 0);
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
              }
              files.set(key, out);
            },
            abort: async () => {},
          };
        },
      };
    },
  });
  return {
    storage: { getDirectory: async () => ensureDir('root') },
    files,
  };
};

describe('loadExtensionPacks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('wasm64 Std / Mathlib 兼容 .pack.zst 与清单 .pack.zst.bin，并使用清单 uncompressedSha256 读写 OPFS', async () => {
    const opfs = createMockOpfs();
    const seenUrls: string[] = [];
    const table: Record<string, Uint8Array> = {
      'lean-std-64.index.json': w64StdIndexBytes,
      'lean-std-64-00.pack.zst.bin': compSmall,
      'lean-mathlib-64.index.json': w64MathlibIndexBytes,
      'lean-mathlib-64-00.pack.zst.bin': compSmall,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      seenUrls.push(url);
      const name = Object.keys(table).find((k) => url.includes(k));
      if (!name) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(table[name]!), { status: 200 });
    }) as unknown as typeof fetch;

    const decoder = { init: async () => {}, decode: () => rawSmall };
    const packs = await loadExtensionPacks(['std', 'mathlib'], undefined, 'wasm64', {
      opfsStorage: opfs.storage,
      fetchImpl,
      createDecoder: async () => decoder,
    });

    const smallPrefix = (await sha256(rawSmall)).slice(0, 16);
    expect(seenUrls.some((u) => u.includes('&h='))).toBe(true);
    expect(packs['lean-std-64-00.pack']).toEqual({
      __opfsPack: true,
      dir: 'wasm64-w64-test',
      fileName: `lean-std-64-00.pack.${smallPrefix}.bin`,
      bytes: rawSmall.byteLength,
    });
    expect(packs['lean-mathlib-64-00.pack']).toEqual({
      __opfsPack: true,
      dir: 'wasm64-w64-test',
      fileName: `lean-mathlib-64-00.pack.${smallPrefix}.bin`,
      bytes: rawSmall.byteLength,
    });

    // 二次加载应直接命中 OPFS，跳过下载 .pack.zst.bin。
    seenUrls.length = 0;
    await loadExtensionPacks(['std'], undefined, 'wasm64', {
      opfsStorage: opfs.storage,
      fetchImpl,
      createDecoder: async () => decoder,
    });
    expect(seenUrls.some((u) => u.includes('lean-std-64-00.pack.zst.bin'))).toBe(false);
  });

  it('wasm32 大分片走同源 Range 分片下载并推进实时进度；同源失败时不让镜像 CORS 掩盖真实错误', async () => {
    const opfs = createMockOpfs();
    const rangeHeaders: string[] = [];
    const ratios: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('lean-batteries.index.json')) {
        return new Response(new Uint8Array(w32IndexBytes), { status: 200 });
      }
      if (url.includes('lean-batteries-00.pack.gz.bin')) {
        const range = new Headers(init?.headers).get('Range') ?? '';
        rangeHeaders.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) return new Response('range required', { status: 400 });
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(compLarge.subarray(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${compLarge.byteLength}` },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const packs = await loadExtensionPacks(['batteries'], (ratio) => ratios.push(ratio), 'wasm32', {
      opfsStorage: opfs.storage,
      fetchImpl,
      createDecoder: async () => ({ init: async () => {}, decode: () => rawLarge }),
    });

    const largePrefix = (await sha256(rawLarge)).slice(0, 16);
    expect(rangeHeaders).toEqual(['bytes=0-2097151', 'bytes=2097152-2097279']);
    expect(ratios.some((r) => r > 0 && r < 1)).toBe(true);
    expect(ratios.at(-1)).toBe(1);
    expect(packs['lean-batteries-00.pack']).toEqual({
      __opfsPack: true,
      dir: 'ext-wasm32',
      fileName: `lean-batteries-00.pack.${largePrefix}.bin`,
      bytes: rawLarge.byteLength,
    });

    // 当同源 /cdn 返回 500 且镜像发生浏览器 CORS 错误时，应保留并抛出同源 HTTP 500 错误，而非镜像的 Failed to fetch。
    const failingFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/cdn/')) return new Response('origin error', { status: 500 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(
      loadExtensionPacks(['std'], undefined, 'wasm32', {
        opfsStorage: opfs.storage,
        fetchImpl: failingFetch,
        createDecoder: async () => ({ init: async () => {}, decode: () => rawSmall }),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
