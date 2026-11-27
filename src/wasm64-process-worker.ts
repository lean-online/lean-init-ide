/**
 * 实验性 wasm64：一个 Worker 承载一个 Lean 进程（--server 或 --worker）。
 * 在 Chrome 里直接由该 Worker 运行 PROXY_TO_PTHREAD 版 glue，pthread 由 Emscripten 自行派生。
 * 与 scripts/wasm64-lsp-browser-worker.ts 对应（后者已在 Chrome LSP 链路验证）。
 *
 * 内存优化：
 * 1. `--server` 引导进程只做 LSP `initialize` 握手，跳过库挂载；
 * 2. 若宿主提供 OPFS 分片引用（`opfsPacks`），经 `FileSystemSyncAccessHandle` 挂 0 字节懒读
 *    MEMFS 节点，仅按需读取实际打开的 `.olean`；
 * 3. 无 OPFS 回退到 `library` SAB 时，单分片文件直接传递零拷贝 `subarray` 视图并流式写入
 *    `lean.FS.writeFile(..., { canOwn: true })`，消除 2.27 GB 全量深拷贝，并在启动后置空 `library`。
 */

// V8 默认只保留 10 帧；wasm 爆栈需要完整调用环才能定位。
(Error as ErrorConstructor & { stackTraceLimit?: number }).stackTraceLimit = 200;

import {
  mountLazyMemfsFile,
  openOpfsSyncReader,
  readSegments,
  type LazyFileSegment,
  type LazyFsApi,
  type LazyMemfsStreamOps,
  type SyncPackReader,
} from './lazy-memfs';
import type { OpfsPackRef } from './opfs-pack-store';
import { formatWorkerError } from './wasm64-error';

type FsApi = LazyFsApi & {
  chdir: (path: string) => void;
  getStream: (fd: number) => { stream_ops: Record<string, unknown> };
};

type LeanModule = {
  FS: FsApi;
  wasmMemory?: { readonly buffer: ArrayBufferLike };
  callMain: (args: string[]) => number;
};

type StartMessage = {
  readonly type: 'start';
  readonly glueUrl: string;
  readonly wasmModule: WebAssembly.Module;
  readonly library: Readonly<Record<string, Uint8Array>>;
  readonly opfsPacks?: Readonly<Record<string, OpfsPackRef>>;
  readonly stdin: { readonly buffer: SharedArrayBuffer; readonly capacity: number };
  readonly args: readonly string[];
};

type PollMessage = { readonly type: 'pollMemory'; readonly id?: number };

type PostScope = { postMessage: (message: unknown, transfer?: Transferable[]) => void };
const scope = self as unknown as PostScope;

// 最小的 UTC TZif 文件：Lean 的 IO 时间处理需要真实的 /etc/localtime。
const UTC_TZIF = Uint8Array.from([
  84, 90, 105, 102, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 85, 84, 67, 0, 84, 90, 105,
  102, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 85, 84, 67, 0, 10, 85, 84, 67, 48, 10,
]);

const LIBRARY_ROOT = '/lean/lib/lean';
/**
 * 允许挂载的库路径：首个目录是模块根（Init / Std / Lean / Lake / Batteries / Mathlib /
 * Aesop / Qq …），后续只允许普通标识符与点号。禁止 `..`、绝对路径与其它后缀。
 */
const LIBRARY_PATH =
  /^[A-Za-z0-9_]+(\/[A-Za-z0-9_.-]+)*\.(olean(\.server|\.private)?|ilean|ir|ir\.sig)$/;

type PackIndex = {
  chunks: Array<{ path: string; offset: number; uncompressedBytes: number }>;
  files: Array<{ path: string; offset: number; bytes: number }>;
};

type SabChunk = {
  readonly kind: 'sab';
  readonly offset: number;
  readonly uncompressedBytes: number;
  readonly bytes: Uint8Array;
};

type OpfsChunk = {
  readonly kind: 'opfs';
  readonly offset: number;
  readonly uncompressedBytes: number;
  readonly reader: SyncPackReader;
};

type ResolvedChunk = SabChunk | OpfsChunk;

const parseSortedIndexes = (
  library: Readonly<Record<string, Uint8Array>>,
): Array<{ key: string; index: PackIndex }> => {
  const indexKeys = Object.keys(library)
    .filter((key) => key.endsWith('.index.json'))
    .sort();
  if (indexKeys.length === 0) throw new Error('wasm64 库索引缺失');
  const decoder = new TextDecoder();
  return indexKeys.map((key) => {
    const indexBytes = library[key];
    if (!indexBytes) throw new Error(`wasm64 库索引 ${key} 缺失`);
    // TextDecoder.decode 在浏览器里拒绝 SharedArrayBuffer 视图（"must not be shared"），
    // 索引只有数百 KB，先复制成普通缓冲再解码。
    return {
      key,
      index: JSON.parse(decoder.decode(new Uint8Array(indexBytes))) as PackIndex,
    };
  });
};

const resolveSabChunks = (
  chunks: PackIndex['chunks'],
  library: Readonly<Record<string, Uint8Array>>,
): SabChunk[] =>
  chunks
    .map((chunk) => {
      const bytes = library[chunk.path.replace(/\.zst(\.bin)?$/, '')];
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== chunk.uncompressedBytes) {
        throw new Error(`wasm64 库分片 ${chunk.path} 缺失或长度不符`);
      }
      return {
        kind: 'sab' as const,
        offset: chunk.offset,
        uncompressedBytes: chunk.uncompressedBytes,
        bytes,
      };
    })
    .sort((left, right) => left.offset - right.offset);

const extractSabFile = (
  file: PackIndex['files'][number],
  chunks: readonly SabChunk[],
): Uint8Array => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of chunks) {
    const start = Math.max(file.offset, chunk.offset);
    const end = Math.min(file.offset + file.bytes, chunk.offset + chunk.uncompressedBytes);
    if (start >= end) continue;
    parts.push(chunk.bytes.subarray(start - chunk.offset, end - chunk.offset));
    total += end - start;
  }
  if (total !== file.bytes) throw new Error(`wasm64 库条目 ${file.path} 被截断`);
  // 单分片文件直接零拷贝传回 SharedArrayBuffer subarray（与 wasm32 对齐），只对跨分片文件拼接新缓冲。
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(file.bytes);
  let written = 0;
  for (const part of parts) {
    out.set(part, written);
    written += part.byteLength;
  }
  return out;
};

/**
 * 把每个 `<prefix>.index.json` 描述的分片还原成 `{ path, bytes }`（单分片文件零拷贝视图）。
 * 主要保留给单测直接校验索引校验与拼接逻辑。
 */
export const unpackLibraries = (
  library: Readonly<Record<string, Uint8Array>>,
): Array<{ path: string; bytes: Uint8Array }> => {
  const indexes = parseSortedIndexes(library);
  const mounted = new Map<string, Uint8Array>();
  for (const { index } of indexes) {
    const chunks = resolveSabChunks(index.chunks, library);
    for (const file of index.files) {
      if (!LIBRARY_PATH.test(file.path)) throw new Error(`wasm64 库条目非法: ${file.path}`);
      if (mounted.has(file.path)) throw new Error(`wasm64 库条目重复: ${file.path}`);
      mounted.set(file.path, extractSabFile(file, chunks));
    }
  }
  return [...mounted].map(([path, bytes]) => ({ path, bytes }));
};

/** 单库入口（兼容旧调用点与单测）：等价于展开 library 里所有索引。 */
export const unpackLibrary = unpackLibraries;

export type OpenOpfsReader = (dirName: string, fileName: string) => Promise<SyncPackReader>;

/**
 * 流式挂载全部分片到 MEMFS：
 * - OPFS 分片挂载为 0 字节懒读节点，关闭由返回的句柄列表统一管理；
 * - SAB 分片（零 OPFS 或单分片回退）直接流式传入 `writeFile(..., { canOwn: true })`，不再攒全量数组。
 */
export const mountLibraries = async (
  fs: LazyFsApi,
  library: Readonly<Record<string, Uint8Array>>,
  opfsPacks?: Readonly<Record<string, OpfsPackRef>>,
  openReader: OpenOpfsReader = (dir, file) => openOpfsSyncReader(dir, file),
): Promise<SyncPackReader[]> => {
  const indexes = parseSortedIndexes(library);
  const createdDirs = new Set<string>();
  const seenPaths = new Set<string>();
  const opsCache = new WeakMap<LazyMemfsStreamOps, LazyMemfsStreamOps>();
  const readerByName = new Map<string, SyncPackReader>();
  const openedReaders: SyncPackReader[] = [];
  const supportsLazy = typeof fs.lookupPath === 'function';

  const ensureParentDir = (target: string): void => {
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (dir && !createdDirs.has(dir)) {
      fs.mkdirTree(dir);
      createdDirs.add(dir);
    }
  };

  try {
    for (const { index } of indexes) {
      const chunks: ResolvedChunk[] = [];
      for (const chunk of index.chunks) {
        const logicalName = chunk.path.replace(/\.zst(\.bin)?$/, '');
        const opfsRef = opfsPacks?.[logicalName];
        if (opfsRef && supportsLazy) {
          if (opfsRef.bytes !== chunk.uncompressedBytes) {
            throw new Error(`wasm64 库分片 ${chunk.path} 缺失或长度不符`);
          }
          let reader = readerByName.get(logicalName);
          if (!reader) {
            reader = await openReader(opfsRef.dir, opfsRef.fileName);
            readerByName.set(logicalName, reader);
            openedReaders.push(reader);
          }
          chunks.push({
            kind: 'opfs',
            offset: chunk.offset,
            uncompressedBytes: chunk.uncompressedBytes,
            reader,
          });
        } else {
          const bytes = library[logicalName];
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== chunk.uncompressedBytes) {
            throw new Error(`wasm64 库分片 ${chunk.path} 缺失或长度不符`);
          }
          chunks.push({
            kind: 'sab',
            offset: chunk.offset,
            uncompressedBytes: chunk.uncompressedBytes,
            bytes,
          });
        }
      }
      chunks.sort((left, right) => left.offset - right.offset);

      for (const file of index.files) {
        if (!LIBRARY_PATH.test(file.path)) throw new Error(`wasm64 库条目非法: ${file.path}`);
        if (seenPaths.has(file.path)) throw new Error(`wasm64 库条目重复: ${file.path}`);
        seenPaths.add(file.path);

        const overlaps: Array<{
          chunk: ResolvedChunk;
          localStart: number;
          localEnd: number;
        }> = [];
        let covered = 0;
        for (const chunk of chunks) {
          const start = Math.max(file.offset, chunk.offset);
          const end = Math.min(file.offset + file.bytes, chunk.offset + chunk.uncompressedBytes);
          if (start >= end) continue;
          overlaps.push({
            chunk,
            localStart: start - chunk.offset,
            localEnd: end - chunk.offset,
          });
          covered += end - start;
        }
        if (covered !== file.bytes) throw new Error(`wasm64 库条目 ${file.path} 被截断`);

        const target = `${LIBRARY_ROOT}/${file.path}`;
        ensureParentDir(target);

        if (overlaps.length > 0 && overlaps.every((item) => item.chunk.kind === 'opfs')) {
          const segments: LazyFileSegment[] = overlaps.map((item) => ({
            reader: (item.chunk as OpfsChunk).reader,
            fileOffset: item.localStart,
            byteLength: item.localEnd - item.localStart,
          }));
          mountLazyMemfsFile(fs, target, file.bytes, segments, opsCache);
        } else if (overlaps.length === 1 && overlaps[0]!.chunk.kind === 'sab') {
          const only = overlaps[0]!;
          fs.writeFile(
            target,
            (only.chunk as SabChunk).bytes.subarray(only.localStart, only.localEnd),
            { canOwn: true },
          );
        } else {
          const out = new Uint8Array(file.bytes);
          let written = 0;
          for (const item of overlaps) {
            const len = item.localEnd - item.localStart;
            if (item.chunk.kind === 'sab') {
              out.set(item.chunk.bytes.subarray(item.localStart, item.localEnd), written);
            } else {
              readSegments(
                [{ reader: item.chunk.reader, fileOffset: item.localStart, byteLength: len }],
                0,
                out,
                written,
                len,
              );
            }
            written += len;
          }
          fs.writeFile(target, out, { canOwn: true });
        }
      }
    }
    return openedReaders;
  } catch (error) {
    for (const reader of openedReaders) {
      try {
        reader.close();
      } catch {
        // 清理失败不覆盖真实异常。
      }
    }
    throw error;
  }
};

const errorStack = (error: unknown, fallback?: string): string =>
  formatWorkerError(error, fallback);

let activeLean: LeanModule | null = null;

// pthread 的未捕获异常会冒泡到本 Worker；Chrome 会再包一层 ErrorEvent，必须解包后再回传。
self.addEventListener('error', (event: ErrorEvent) => {
  event.preventDefault();
  scope.postMessage({
    failure: errorStack(event.error ?? event, event.message || 'Lean wasm64 worker failed.'),
  });
});

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  event.preventDefault();
  scope.postMessage({
    failure: errorStack(event.reason, 'Lean wasm64 worker unhandled rejection.'),
  });
});

const start = async (data: StartMessage): Promise<void> => {
  let openedReaders: SyncPackReader[] = [];
  const closeReaders = (): void => {
    for (const reader of openedReaders) {
      try {
        reader.close();
      } catch {
        // 关闭阶段吞掉已释放句柄错误。
      }
    }
    openedReaders = [];
  };

  try {
    const { default: createLean } = (await import(/* @vite-ignore */ data.glueUrl)) as {
      default: (options: Record<string, unknown>) => Promise<LeanModule>;
    };
    const lean = await createLean({
      noInitialRun: true,
      mainScriptUrlOrBlob: data.glueUrl,
      lspStdin: data.stdin,
      lspProcessExit: (code: number) => {
        closeReaders();
        scope.postMessage({ exit: code });
      },
      onMemoryResize: (memoryBytes: number) => scope.postMessage({ memoryBytes }),
      instantiateWasm(
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) {
        void WebAssembly.instantiate(data.wasmModule, imports).then(
          (instance) => receive(instance, data.wasmModule),
          (error: unknown) => scope.postMessage({ failure: errorStack(error) }),
        );
        return {};
      },
      locateFile: (name: string) => {
        throw new Error(`Unexpected unverified Lean file: ${name}`);
      },
      print: (text: string) => scope.postMessage({ stderr: `${text}\n` }),
      printErr: (text: string) => scope.postMessage({ stderr: `${text}\n` }),
    });
    activeLean = lean;

    for (const dir of ['/lean/bin', LIBRARY_ROOT, '/workspace', '/etc']) lean.FS.mkdirTree(dir);
    lean.FS.writeFile('/etc/localtime', UTC_TZIF);

    // --server 引导进程只做 LSP initialize 握手，跳过数千个 .olean 的挂载。
    const isServerBootstrap = Array.isArray(data.args) && data.args.includes('--server');
    if (!isServerBootstrap) {
      openedReaders = await mountLibraries(lean.FS, data.library, data.opfsPacks);
    }
    // 挂载完成后立刻断开包映射引用，避免 callMain 同步阻塞期间闭锁 SAB/引用对象。
    (data as { library: unknown }).library = null;
    (data as { opfsPacks?: unknown }).opfsPacks = undefined;

    const stderrDecoder = new TextDecoder();
    let lastMemoryBytes = lean.wasmMemory?.buffer.byteLength ?? 0;
    for (const fd of [1, 2] as const) {
      const stream = lean.FS.getStream(fd);
      stream.stream_ops = {
        ...stream.stream_ops,
        write(_stream: unknown, buffer: Uint8Array, offset: number, length: number): number {
          const memoryBytes = lean.wasmMemory?.buffer.byteLength;
          if (typeof memoryBytes === 'number' && memoryBytes !== lastMemoryBytes) {
            lastMemoryBytes = memoryBytes;
            scope.postMessage({ memoryBytes });
          }
          const chunk = Uint8Array.from(buffer.subarray(offset, offset + length));
          if (fd === 1) scope.postMessage({ stdout: chunk }, [chunk.buffer]);
          else if (length > 0) scope.postMessage({ stderr: stderrDecoder.decode(chunk) });
          return length;
        },
      };
    }

    lean.FS.chdir('/workspace');
    const initialMemoryBytes = lean.wasmMemory?.buffer.byteLength;
    if (typeof initialMemoryBytes === 'number') lastMemoryBytes = initialMemoryBytes;
    scope.postMessage({
      ready: true,
      ...(typeof initialMemoryBytes === 'number' ? { memoryBytes: initialMemoryBytes } : {}),
    });

    // PROXY_TO_PTHREAD 下 callMain 只负责派发，返回不代表进程结束；真实退出码走 lspProcessExit。
    let code: number;
    try {
      code = lean.callMain([...data.args]);
    } catch (error: unknown) {
      const exit = error as { name?: string; status?: number };
      if (exit?.name === 'ExitStatus' && typeof exit.status === 'number') code = exit.status;
      else throw error;
    }
    if (code !== 0) {
      closeReaders();
      scope.postMessage({ failure: `callMain 返回 ${code}` });
    }
  } catch (error) {
    closeReaders();
    throw error;
  }
};

self.onmessage = (event: MessageEvent<StartMessage | PollMessage>) => {
  const data = event.data;
  if (data.type === 'pollMemory') {
    const memoryBytes = activeLean?.wasmMemory?.buffer.byteLength ?? null;
    if (typeof data.id === 'number') {
      scope.postMessage({ type: 'memorySample', id: data.id, memoryBytes });
    } else if (typeof memoryBytes === 'number') {
      scope.postMessage({ memoryBytes });
    }
    return;
  }
  start(data).catch((error: unknown) => scope.postMessage({ failure: errorStack(error) }));
};
