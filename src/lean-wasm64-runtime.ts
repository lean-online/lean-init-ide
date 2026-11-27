/**
 * 实验性 wasm64 运行时的资产加载：经同源网关取清单里登记的资产，逐个校验字节数与
 * SHA-256，解 zstd，再编译 wasm。清单为空（尚未发布）时调用方应保持 wasm32。
 *
 * 内存与磁盘优化：
 * - OPFS 优先路径：`.pack` 分片解压校验后逐块落盘 `lean-packs-v1/wasm64-<cacheKey>`，
 *   立刻释放 JS 堆；二次启动跳过下载与解压，Worker 侧通过 `SyncAccessHandle` 懒读；
 * - 流式立即处理：不再先攒满 `payload` Map 再整份深拷贝成 SharedArrayBuffer（消除 2× 峰值）；
 * - 生命周期清理：无论成功或失败都在 `finally` 中释放 Zstd Wasm 解码器，并在 `dispose()` 时
 *   清空 `library` 与 `opfsPacks` 引用。
 */
import manifestJson from '../config/lean4-wasm64-runtime.json';
import {
  assetSources,
  pickClientLanguages,
  prefersDomesticMirror,
  type RuntimeAsset,
  type RuntimeManifest,
} from './asset-sources.mjs';
import { openOpfsPackStore, type OpfsPackRef, type OpfsStorageLike } from './opfs-pack-store';

export type Wasm64Asset = {
  readonly name: string;
  readonly key: string;
  readonly source?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType?: string;
  readonly ranged?: boolean;
  readonly encoding?: 'zstd';
  readonly uncompressedBytes?: number;
  readonly uncompressedSha256?: string;
};

/**
 * 可选库（Std/Lean 核心、Mathlib 教学子集）。assets 与基础资产同格式：
 * `<prefix>.index.json` + 若干 `<prefix>-XX.pack.zst.bin`，挂载逻辑由 worker 统一处理。
 */
export type Wasm64Extension = {
  readonly id: string;
  readonly label: string;
  readonly requires?: readonly string[];
  readonly assets: readonly Wasm64Asset[];
};

export type Wasm64Manifest = {
  readonly cacheKey: string;
  readonly leanVersion: string;
  readonly runtime: string;
  readonly primary?: { readonly label: string; readonly baseUrl: string };
  readonly fallback?: { readonly label: string; readonly baseUrl: string };
  readonly mirror?: { readonly label: string; readonly baseUrl: string; readonly prefix?: string };
  readonly assets: readonly Wasm64Asset[];
  readonly extensions?: readonly Wasm64Extension[];
};

export const wasm64Manifest = manifestJson as unknown as Wasm64Manifest;

/** 清单里没有资产 = 还没发布；此时切到 wasm64 只会回退 wasm32，绝不伪造数据。 */
export const isWasm64Published = (manifest: Wasm64Manifest = wasm64Manifest): boolean =>
  manifest.assets.length > 0;

export const wasm64ExtensionList = (
  manifest: Wasm64Manifest = wasm64Manifest,
): readonly Wasm64Extension[] => manifest.extensions ?? [];

export const wasm64ExtensionById = (
  id: string,
  manifest: Wasm64Manifest = wasm64Manifest,
): Wasm64Extension | undefined => wasm64ExtensionList(manifest).find((item) => item.id === id);

/** 展开依赖闭包，例如 Mathlib 需要先挂 Std/Lean 核心；未知 id 直接忽略。 */
export const resolveWasm64ExtensionIds = (
  ids: Iterable<string>,
  manifest: Wasm64Manifest = wasm64Manifest,
): string[] => {
  const resolved = new Set<string>();
  const visit = (id: string): void => {
    if (resolved.has(id)) return;
    const extension = wasm64ExtensionById(id, manifest);
    if (!extension) return;
    resolved.add(id);
    for (const dependency of extension.requires ?? []) visit(dependency);
  };
  for (const id of ids) visit(id);
  return [...resolved];
};

export const WASM64_GLUE = 'lean-lsp-adapted.mjs';
export const WASM64_WASM = 'lean-lsp.wasm.zst';
export const WASM64_INDEX = 'lean-init-64.index.json';

export type ZstdDecoder = { decode(bytes: Uint8Array, uncompressedSize: number): Uint8Array };

export type LoadedWasm64Runtime = {
  /** 适配后的 glue（Blob URL），process worker 与 pthread 都从它加载。 */
  readonly glueUrl: string;
  readonly wasmModule: WebAssembly.Module;
  /** index.json 与回退到 SharedArrayBuffer 承载的分片（多个进程共享不复制）。 */
  readonly library: Record<string, Uint8Array>;
  /** 落盘在 OPFS 的解压后分片引用，供 Worker 挂载 0 字节懒读 MEMFS。 */
  readonly opfsPacks?: Record<string, OpfsPackRef>;
  dispose(): void;
};

export type LoadWasm64Options = {
  readonly manifest?: Wasm64Manifest;
  /** 需要额外挂载的库 id（依赖会自动展开）；空数组 = 只带 Init。 */
  readonly extensions?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly createZstd?: () => Promise<ZstdDecoder>;
  readonly opfsStorage?: OpfsStorageLike;
  readonly onStage?: (stage: string) => void;
  readonly concurrency?: number;
  /** 单个资产单个源的下载预算；超时后中止并尝试下一个源。 */
  readonly assetTimeoutMs?: number;
};

const DEFAULT_ASSET_TIMEOUT_MS = 60 * 60_000;

const toHex = (digest: ArrayBuffer): string =>
  [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');

const sha256Of = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

const defaultZstd = async (): Promise<ZstdDecoder> => {
  const url = new URL('/vendor/zstddec.mjs', globalThis.location.origin).href;
  const { ZSTDDecoder } = (await import(/* @vite-ignore */ url)) as {
    ZSTDDecoder: new () => ZstdDecoder & { init(): Promise<void> };
  };
  const decoder = new ZSTDDecoder();
  await decoder.init();
  return decoder;
};

export const wasm64AssetUrl = (manifest: Wasm64Manifest, asset: Wasm64Asset): string =>
  asset.ranged ? `/wasm-lean4-64/${asset.name}?v=${asset.sha256}` : wasm64CdnUrl(manifest, asset);

/**
 * 同源网关 URL。`h` 用资产自身哈希做版本键：扩展包的 key 是按名字固定的，
 * 只带 runtime 的 cacheKey 会在扩展包更新后继续命中旧缓存。
 */
export const wasm64CdnUrl = (manifest: Wasm64Manifest, asset: Wasm64Asset): string =>
  `/cdn/${asset.key}?r=${manifest.cacheKey}&h=${asset.sha256.slice(0, 12)}`;

const isDomesticClient = (): boolean => {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
    .navigator;
  const languages = pickClientLanguages(undefined, nav?.languages, nav?.language);
  let timeZone: string | null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timeZone = null;
  }
  return prefersDomesticMirror(languages, timeZone);
};

export const wasm64CandidateUrls = (
  manifest: Wasm64Manifest,
  asset: Wasm64Asset,
  domestic: boolean = isDomesticClient(),
): string[] => {
  const urls: string[] = [];
  if (asset.ranged) urls.push(wasm64AssetUrl(manifest, asset));

  const fallbackBase = manifest.fallback?.baseUrl;
  const normalized: RuntimeManifest = {
    revision: manifest.cacheKey,
    cacheKey: manifest.cacheKey,
    runtime: manifest.runtime,
    bucket: '',
    primary: manifest.primary ?? { label: 'Pages Functions (R2)', baseUrl: '/cdn/' },
    fallback: manifest.fallback ?? { label: 'GitHub release', baseUrl: '' },
    ...(manifest.mirror ? { mirror: manifest.mirror } : {}),
    assets: [],
  };
  const resolved = assetSources(
    normalized,
    asset as unknown as RuntimeAsset,
    undefined,
    domestic ? { mirrorFirst: true } : { includeMirror: true },
  );
  for (const source of resolved) {
    // GitHub Release 没有 CORS 响应头，浏览器侧绝不请求。
    if (fallbackBase && source.url.startsWith(fallbackBase)) continue;
    if (!urls.includes(source.url)) urls.push(source.url);
  }
  const cdn = wasm64CdnUrl(manifest, asset);
  // assetSources 给的 /cdn/ 不带 h 参数；按 key 替换成带哈希的版本，既去重又能让扩展包更新后失效。
  const cdnIndex = urls.findIndex((url) => url.startsWith(`/cdn/${asset.key}`));
  if (cdnIndex >= 0) urls[cdnIndex] = cdn;
  else urls.push(cdn);
  return urls;
};

const openRuntimeCache = async (cacheKey: string): Promise<Cache | null> => {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(`wasm-idle-assets-v1:wasm64:${cacheKey}`);
  } catch {
    return null;
  }
};

const requireAsset = (manifest: Wasm64Manifest, name: string): Wasm64Asset => {
  const asset = manifest.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`wasm64 清单缺少资产 ${name}`);
  return asset;
};

const share = (bytes: Uint8Array): Uint8Array => {
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  shared.set(bytes);
  return shared;
};

export const loadWasm64Runtime = async (
  options: LoadWasm64Options = {},
): Promise<LoadedWasm64Runtime> => {
  const manifest = options.manifest ?? wasm64Manifest;
  if (!isWasm64Published(manifest)) {
    throw new Error('wasm64 运行时尚未发布（清单为空）');
  }

  const selectedExtensions = resolveWasm64ExtensionIds(options.extensions ?? [], manifest).map(
    (id) => {
      const extension = wasm64ExtensionById(id, manifest);
      if (!extension) throw new Error(`wasm64 清单缺少扩展 ${id}`);
      const indexAsset = extension.assets.find((item) => item.name.endsWith('.index.json'));
      if (!indexAsset) throw new Error(`wasm64 扩展 ${extension.id} 缺少索引资产`);
      return extension;
    },
  );
  const extensionAssets = selectedExtensions.flatMap((extension) => extension.assets);
  // 扩展资产名必须与基础资产不重名，否则逻辑映射会互相覆盖。
  const assetNames = new Set(manifest.assets.map((asset) => asset.name));
  for (const asset of extensionAssets) {
    if (assetNames.has(asset.name)) throw new Error(`wasm64 扩展资产重名: ${asset.name}`);
    assetNames.add(asset.name);
  }
  const allAssets = [...manifest.assets, ...extensionAssets];

  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = await openRuntimeCache(manifest.cacheKey);
  const opfsStore = await openOpfsPackStore(`wasm64-${manifest.cacheKey}`, options.opfsStorage);
  let zstdPromise: Promise<ZstdDecoder> | undefined;
  const zstd = (): Promise<ZstdDecoder> => (zstdPromise ??= (options.createZstd ?? defaultZstd)());

  const verifyDelivered = async (asset: Wasm64Asset, bytes: Uint8Array): Promise<boolean> =>
    bytes.byteLength === asset.bytes && (await sha256Of(bytes)) === asset.sha256;

  const fetchVerifiedAsset = async (
    asset: Wasm64Asset,
    skipCachePut: boolean,
  ): Promise<Uint8Array> => {
    const cdnUrl = wasm64CdnUrl(manifest, asset);
    if (cache) {
      try {
        const hit = await cache.match(cdnUrl);
        if (hit) {
          const cached = new Uint8Array(await hit.arrayBuffer());
          if (await verifyDelivered(asset, cached)) return cached;
          await cache.delete(cdnUrl);
        }
      } catch {
        // CacheStorage 异常不阻断网络下载。
      }
    }

    const errors: string[] = [];
    const assetTimeoutMs = options.assetTimeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS;
    for (const url of wasm64CandidateUrls(manifest, asset)) {
      const sameOrigin = url.startsWith('/');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), assetTimeoutMs);
      try {
        // 魔搭镜像会 302 到 cdn-lfs 域；同源路径仍禁止重定向。
        const response = await fetchImpl(url, {
          redirect: sameOrigin ? 'error' : 'follow',
          signal: controller.signal,
        });
        if (!response.ok) {
          errors.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        if (sameOrigin && (response.headers.get('content-type') ?? '').includes('text/html')) {
          errors.push(`${url}: SPA HTML fallback`);
          continue;
        }
        const delivered = new Uint8Array(await response.arrayBuffer());
        if (delivered.byteLength !== asset.bytes) {
          errors.push(`${url}: length ${delivered.byteLength} != ${asset.bytes}`);
          continue;
        }
        if ((await sha256Of(delivered)) !== asset.sha256) {
          errors.push(`${url}: SHA-256 mismatch`);
          continue;
        }
        // 已确定会解压写入 OPFS 的 pack 不再重复写入 CacheStorage，避免双倍磁盘配额消耗。
        if (cache && !skipCachePut) {
          try {
            await cache.put(
              cdnUrl,
              new Response(delivered as unknown as BodyInit, {
                headers: { 'Content-Type': 'application/octet-stream' },
              }),
            );
          } catch {
            // 配额满或隐私模式写缓存失败时仍正常启动。
          }
        }
        return delivered;
      } catch (error) {
        errors.push(
          controller.signal.aborted
            ? `${url}: timeout after ${assetTimeoutMs}ms`
            : `${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`wasm64 资产 ${asset.name} 所有源均失败: ${errors.join(' | ')}`);
  };

  const decodeZstd = async (asset: Wasm64Asset, skipCachePut: boolean): Promise<Uint8Array> => {
    const expected = asset.uncompressedBytes;
    const expectedHash = asset.uncompressedSha256;
    if (expected === undefined || expectedHash === undefined) {
      throw new Error(`wasm64 资产 ${asset.name} 缺少解压回执`);
    }
    const decoder = await zstd();
    // 独立作用域：decode 返回后 compressed 立刻离开词法作用域，计算 SHA-256 时不再同时常驻。
    const decoded = await (async () => {
      const delivered = await fetchVerifiedAsset(asset, skipCachePut);
      return decoder.decode(delivered, expected);
    })();
    if (decoded.byteLength !== expected || (await sha256Of(decoded)) !== expectedHash) {
      throw new Error(`wasm64 资产 ${asset.name} 解压后校验失败`);
    }
    return decoded;
  };

  const download = async (asset: Wasm64Asset, skipCachePut: boolean): Promise<Uint8Array> => {
    options.onStage?.(asset.name);
    if (asset.encoding !== 'zstd') return fetchVerifiedAsset(asset, skipCachePut);
    return decodeZstd(asset, skipCachePut);
  };

  let wasmModule: WebAssembly.Module | undefined;
  let glueUrl: string | undefined;
  const library: Record<string, Uint8Array> = {};
  const opfsPacks: Record<string, OpfsPackRef> = {};

  const processAsset = async (asset: Wasm64Asset): Promise<void> => {
    if (asset.name === WASM64_WASM) {
      const bytes = await download(asset, false);
      options.onStage?.('compile');
      wasmModule = await WebAssembly.compile(bytes as BufferSource);
      return;
    }
    if (asset.name === WASM64_GLUE) {
      const glueText = new TextDecoder().decode(await download(asset, false));
      glueUrl = URL.createObjectURL(new Blob([glueText], { type: 'text/javascript' }));
      return;
    }
    if (asset.name.endsWith('.index.json')) {
      library[asset.name] = share(await download(asset, false));
      return;
    }
    if (asset.name.endsWith('.pack.zst.bin')) {
      const logicalName = asset.name.replace(/\.zst\.bin$/, '');
      const hasReceipt =
        asset.uncompressedBytes !== undefined && asset.uncompressedSha256 !== undefined;
      if (opfsStore && hasReceipt) {
        const hit = await opfsStore.has(
          logicalName,
          asset.uncompressedSha256!,
          asset.uncompressedBytes!,
        );
        if (hit) {
          options.onStage?.(asset.name);
          opfsPacks[logicalName] = hit;
          return;
        }
      }
      const bytes = await download(asset, Boolean(opfsStore && hasReceipt));
      if (opfsStore && asset.uncompressedSha256 !== undefined) {
        try {
          opfsPacks[logicalName] = await opfsStore.write(
            logicalName,
            asset.uncompressedSha256,
            bytes,
          );
          return;
        } catch {
          // OPFS 写入失败（如磁盘配额满）自动降级回 SharedArrayBuffer。
        }
      }
      library[logicalName] = share(bytes);
      return;
    }
    await download(asset, false);
  };

  try {
    // 受限并发下载并流式落地；任何一个失败立即整体失败，并在 finally 释放 zstd Wasm 堆。
    const queue = [...allAssets];
    const workerCount = Math.max(1, Math.min(options.concurrency ?? 4, queue.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (let asset = queue.shift(); asset; asset = queue.shift()) {
          await processAsset(asset);
        }
      }),
    );

    if (!wasmModule) throw new Error(`wasm64 资产 ${WASM64_WASM} 缺失`);
    if (!glueUrl) throw new Error(`wasm64 资产 ${WASM64_GLUE} 缺失`);
    const indexAsset = requireAsset(manifest, WASM64_INDEX);
    if (!library[indexAsset.name]) throw new Error(`wasm64 资产 ${indexAsset.name} 缺失`);
  } catch (error) {
    if (glueUrl) URL.revokeObjectURL(glueUrl);
    for (const key of Object.keys(library)) delete library[key];
    throw error;
  } finally {
    zstdPromise = undefined;
  }

  const finalGlueUrl = glueUrl;
  return {
    glueUrl: finalGlueUrl,
    wasmModule,
    library,
    ...(Object.keys(opfsPacks).length > 0 ? { opfsPacks } : {}),
    dispose: () => {
      URL.revokeObjectURL(finalGlueUrl);
      for (const key of Object.keys(library)) delete library[key];
      for (const key of Object.keys(opfsPacks)) delete opfsPacks[key];
    },
  };
};
