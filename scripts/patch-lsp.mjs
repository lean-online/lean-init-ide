import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 把运行时补丁应用到 @wasm-idle/lsp 包目录，用于生成 pnpm patch。
 *
 * 安装时补丁由 pnpm-workspace.yaml 的 patchedDependencies 自动应用，不再改写
 * node_modules；升级 @wasm-idle/lsp 后运行 `pnpm run patch:lsp` 重新生成。
 * 模式不匹配会直接抛错，避免依赖升级后补丁静默失效。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = process.argv[2];
if (!packageRoot) {
  throw new Error('usage: node scripts/patch-lsp.mjs <package-root>');
}
const lspDist = path.join(path.resolve(packageRoot), 'dist');

const applyPatch = (relativePath, from, to, label) => {
  const target = path.join(lspDist, relativePath);
  const source = readFileSync(target, 'utf8');
  if (source.includes(to)) {
    console.log(`lsp patch: ${label} already applied`);
    return;
  }
  if (!source.includes(from)) {
    throw new Error(
      `lsp patch: expected ${JSON.stringify(from)} in ${target}. The package version changed; update the patch.`,
    );
  }
  writeFileSync(target, source.replace(from, to));
  console.log(`lsp patch: ${label}`);
};

/**
 * 1. 资产并发从 3 提到 6：102MB Init 由 6 个 ~22MB pack 主导，6 路正好吃满长肥管道。
 */
applyPatch(
  path.join('lean4', 'assets.js'),
  'maxConcurrentDownloads: 3',
  'maxConcurrentDownloads: 6',
  'maxConcurrentDownloads 3 -> 6',
);

const leanWorker = path.join('lean4', 'worker.js');

/**
 * 2. 文件进程 pthread 池 64 -> 16。Emscripten 启动时会预创建整个池，每个 Worker
 *    都是独立 JS 上下文。实测 8 会让文件检查静默不产生诊断（界面仍 ready），
 *    16 是能稳定出诊断的下限；bootstrap 的 8 不要动，降到 4 同样会丢诊断。
 */
applyPatch(
  leanWorker,
  "startProcess(['-j4', '--worker', document.uri], 64,",
  "startProcess(['-j4', '--worker', document.uri], 16,",
  'lean file pthread pool 64 -> 16',
);

/**
 * 3. 解压完一个资产就释放压缩态引用，启动峰值不再同时持有 102MB 压缩态 + 415MB 解压态。
 *    preflight 结果是冻结对象，先浅拷贝成可变对象再 delete。
 */
applyPatch(
  leanWorker,
  `    const payload = await preflightLean4RuntimeAssets(data.options.baseUrl, {
        limits,
        persistentCache: data.persistentAssets?.persistentCache,
        reportProgress: (loaded, stage) => scope.postMessage({ type: 'progress', stage, loaded, total: 1 })
    });`,
  `    const payload = { ...(await preflightLean4RuntimeAssets(data.options.baseUrl, {
        limits,
        persistentCache: data.persistentAssets?.persistentCache,
        reportProgress: (loaded, stage) => scope.postMessage({ type: 'progress', stage, loaded, total: 1 })
    })) };`,
  'mutable preflight payload',
);
applyPatch(
  leanWorker,
  `            library[logicalName] = shared;
        }
    }`,
  `            library[logicalName] = shared;
        }
        delete payload[name];
    }`,
  'release compressed asset after inflate',
);

/**
 * 4. 用浏览器端 wasm zstd 解码器替换 gzip 流：资产从 136 MiB 降到约 102 MiB。
 *    解码器放在 public/vendor/zstddec.mjs，由 worker 以同源绝对路径动态加载，
 *    不进入包依赖图，避免 pnpm 的隔离 node_modules 解析问题。
 */
applyPatch(leanWorker, 'let library;', 'let zstdDecoder;\nlet library;', 'zstd decoder slot');
applyPatch(
  leanWorker,
  "        if ('encoding' in receipt && receipt.encoding === 'gzip') {",
  `        if ('encoding' in receipt && receipt.encoding === 'zstd') {
            if (!zstdDecoder) {
                const zstdDecoderUrl = new URL('/vendor/zstddec.mjs', self.location.origin).href;
                const { ZSTDDecoder } = await import(/* @vite-ignore */ zstdDecoderUrl);
                zstdDecoder = new ZSTDDecoder();
                await zstdDecoder.init();
            }
            bytes = zstdDecoder.decode(new Uint8Array(delivered), receipt.uncompressed.bytes);
            if (bytes.length !== receipt.uncompressed.bytes ||
                hex(await crypto.subtle.digest('SHA-256', bytes)) !==
                    receipt.uncompressed.sha256)
                throw new Error(\`Lean \${name} decoded receipt mismatch.\`);
        }
        else if ('encoding' in receipt && receipt.encoding === 'gzip') {`,
  'zstd asset decoding',
);

/**
 * 5. MEMFS 直接接管解压后的视图，省掉每个进程一份 415MB 拷贝（canOwn）。
 *    库目录只读；文档 #eval 写入的是 /workspace，不会改共享 pack。
 */
applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  'lean.FS.writeFile(path, file.bytes);',
  'lean.FS.writeFile(path, file.bytes, { canOwn: true });',
  'MEMFS canOwn (skip 415MB copy)',
);

/**
 * 5a. --server 引导进程只用于完成 LSP initialize 握手，不执行文档精化。
 *     跳过 unpackLibrary 可省去 bootstrap 对数千个 .olean 的 MEMFS 节点构建；
 *     文档工作进程（--worker）仍完整挂载库。
 */
applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t\tfor (const file of unpackLibrary(data.library)) {`,
  `\t\tconst isServerBootstrap = Array.isArray(data.args) && data.args.includes('--server');
\t\tfor (const file of (isServerBootstrap ? [] : unpackLibrary(data.library))) {`,
  'server bootstrap skips library mount',
);

/**
 * 5b. 扩展包（Std / Batteries）：一个进程里同时挂载多个库索引。
 *     - 索引按 *.index.json 收集，Init 必需；
 *     - chunk 既支持 Init 的 .pack.gz，也支持扩展包的 .pack.gz.bin；
 *     - 文件路径允许 Init / Std / Batteries 三个前缀。
 */
applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `function unpackLibrary(payload) {
	const index = JSON.parse(
		new TextDecoder().decode(new Uint8Array(payload['lean-init.index.json']))
	);
	const chunks = index.chunks.map((chunk) => {
		const bytes = payload[chunk.path.replace(/\\.gz$/, '')];
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== chunk.uncompressedBytes)
			throw new Error(\`Lean library chunk \${chunk.path} is missing.\`);
		return { ...chunk, bytes };
	});
	const files = [];
	for (const file of index.files) {
		if (!/^Init(\\/[A-Za-z0-9_]+)*\\.(olean(\\.server|\\.private)?|ir(\\.sig)?)$/.test(file.path))
			throw new Error(\`Lean library entry \${file.path} is invalid.\`);
		const parts = [];
		for (const chunk of chunks) {
			const start = Math.max(file.offset, chunk.offset);
			const end = Math.min(file.offset + file.bytes, chunk.offset + chunk.uncompressedBytes);
			if (start < end)
				parts.push(chunk.bytes.subarray(start - chunk.offset, end - chunk.offset));
		}
		let bytes = parts[0] || new Uint8Array();
		if (parts.length > 1) {
			bytes = new Uint8Array(file.bytes);
			let offset = 0;
			for (const part of parts) {
				bytes.set(part, offset);
				offset += part.byteLength;
			}
		}
		if (bytes.byteLength !== file.bytes)
			throw new Error(\`Lean library entry \${file.path} is truncated.\`);
		files.push({ path: file.path, bytes });
	}
	return files;
}`,
  `function unpackLibrary(payload) {
	const indexPaths = Object.keys(payload)
		.filter((name) => name.endsWith('.index.json'))
		.sort();
	if (!indexPaths.includes('lean-init.index.json'))
		throw new Error('Lean library index is missing.');
	const files = [];
	for (const indexPath of indexPaths) {
		const index = JSON.parse(
			new TextDecoder().decode(new Uint8Array(payload[indexPath]))
		);
		const chunks = index.chunks.map((chunk) => {
			const bytes = payload[chunk.path.replace(/\\.gz(\\.bin)?$/, '')];
			if (!(bytes instanceof Uint8Array) || bytes.byteLength !== chunk.uncompressedBytes)
				throw new Error(\`Lean library chunk \${chunk.path} is missing.\`);
			return { ...chunk, bytes };
		});
		for (const file of index.files) {
			if (!/^(Init|Std|Batteries)(\\/[A-Za-z0-9_]+)*\\.(olean(\\.server|\\.private)?|ir(\\.sig)?)$/.test(file.path))
				throw new Error(\`Lean library entry \${file.path} is invalid.\`);
			const parts = [];
			for (const chunk of chunks) {
				const start = Math.max(file.offset, chunk.offset);
				const end = Math.min(file.offset + file.bytes, chunk.offset + chunk.uncompressedBytes);
				if (start < end)
					parts.push(chunk.bytes.subarray(start - chunk.offset, end - chunk.offset));
			}
			let bytes = parts[0] || new Uint8Array();
			if (parts.length > 1) {
				bytes = new Uint8Array(file.bytes);
				let offset = 0;
				for (const part of parts) {
					bytes.set(part, offset);
					offset += part.byteLength;
				}
			}
			if (bytes.byteLength !== file.bytes)
				throw new Error(\`Lean library entry \${file.path} is truncated.\`);
			files.push({ path: file.path, bytes });
		}
	}
	return files;
}`,
  'multi-library unpacking (Init/Std/Batteries)',
);

/**
 * 5c. 扩展包从页面侧下载完成后随 initOptions 传进 worker（SharedArrayBuffer），
 *     挂到 library；已是 SharedArrayBuffer 时零拷贝复用，不再二次分配拷贝；
 *     页面重开会话时即可生效。
 *     解压全部资产后立刻置空 zstdDecoder：zstddec 解码 110MB lean.wasm 时内部
 *     Wasm 线性内存会撑到 ~170MB，作为模块全局变量会永久驻留。
 */
applyPatch(
  leanWorker,
  `        delete payload[name];
    }
    bootstrap = startProcess(['-j2', '--server'], 8, (message) => {`,
  `        delete payload[name];
    }
    zstdDecoder = undefined;
    for (const [name, buffer] of Object.entries(data.options.extensionPacks ?? {})) {
        if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) {
            library[name] = new Uint8Array(buffer);
        } else {
            const bytes = new Uint8Array(buffer);
            const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
            shared.set(bytes);
            library[name] = shared;
        }
    }
    bootstrap = startProcess(['-j2', '--server'], 8, (message) => {`,
  'mount extension packs from init options (zero-copy SAB)',
);

applyPatch(
  path.join('lean4', 'language-server.js'),
  `            initOptions: {
                baseUrl: config.baseUrl,
                maxMemoryBytes,`,
  `            initOptions: {
                baseUrl: config.baseUrl,
                maxMemoryBytes,
                extensionPacks: host?.lean4?.extensionPacks,
                extensionOpfsPacks: host?.lean4?.extensionOpfsPacks,`,
  'forward extensionPacks and extensionOpfsPacks to worker',
);

applyPatch(
  path.join('types.d.ts'),
  `    lean4?: {
        baseUrl?: string;
        /** Per-document shared Wasm memory ceiling; defaults to 1 GiB. */
        maxMemoryBytes?: number;
    };`,
  `    lean4?: {
        baseUrl?: string;
        /** Per-document shared Wasm memory ceiling; defaults to 1 GiB. */
        maxMemoryBytes?: number;
        /** Extra verified library packs (logicalName -> compressed bytes) mounted with Init. */
        extensionPacks?: Record<string, ArrayBufferLike>;
        /** OPFS pack references mounted lazily without SharedArrayBuffer copies. */
        extensionOpfsPacks?: Record<string, { __opfsPack: true; dir: string; fileName: string; bytes: number }>;
    };`,
  'extensionPacks and extensionOpfsPacks option types',
);

/**
 * 6. 双端内存优化（wasm32 Worker + RuntimeWorker OPFS 懒挂载 & 释放生命周期）：
 *    - worker.js:
 *      1) --server 引导进程不接收 library（节省对象传递与持有）；
 *      2) shutdown / fail 时立刻置空 library / wasmModule / glueText 释放几百 MB 引用；
 *      3) Init 的 .pack 分片优先经 SyncAccessHandle 写入 OPFS `lean-packs-v1/wasm32`
 *         并仅在 library 中登记轻量 OpfsPackRef（不可用时自动退回 SharedArrayBuffer）；
 *      4) 合并透传 data.options.extensionOpfsPacks。
 *    - runtime-worker.js:
 *      1) 检测到 __opfsPack 条目时，使用 FileSystemSyncAccessHandle 挂载 0 字节懒读 MEMFS 节点，
 *         仅在 Lean read()/mmap() 时按段同步读取，并在 exit/error 时关闭全部句柄；
 *      2) 挂载完成立刻置空 data.library，避免 callMain 闭包长期 pinned。
 */
applyPatch(
  leanWorker,
  `    worker.postMessage({
        args,
        stdin: stdin.descriptor,
        library,
        wasmModule,
        glueUrl,
        maxMemoryBytes
    });`,
  `    const isBootstrap = Array.isArray(args) && args.includes('--server');
    worker.postMessage({
        args,
        stdin: stdin.descriptor,
        library: isBootstrap ? null : library,
        wasmModule,
        glueUrl,
        maxMemoryBytes
    });`,
  'worker skip library payload for bootstrap',
);

applyPatch(
  leanWorker,
  `        case 'shutdown':
            generation++;
            fileProcess?.dispose();
            bootstrap?.dispose();
            fileProcess = bootstrap = undefined;`,
  `        case 'shutdown':
            generation++;
            fileProcess?.dispose();
            bootstrap?.dispose();
            fileProcess = bootstrap = undefined;
            library = wasmModule = undefined;
            glueText = '';`,
  'worker release library and wasm on shutdown',
);

applyPatch(
  leanWorker,
  `    bootstrap?.dispose();
    fileProcess?.dispose();
    bootstrap = fileProcess = undefined;`,
  `    bootstrap?.dispose();
    fileProcess?.dispose();
    bootstrap = fileProcess = undefined;
    library = wasmModule = undefined;
    glueText = '';`,
  'worker release library and wasm on fail',
);

applyPatch(
  leanWorker,
  `    library = {};
    for (const [name, receipt] of Object.entries(profile.assets)) {`,
  `    library = {};
    let opfsInitDir;
    try {
        if (navigator?.storage?.getDirectory) {
            const root = await navigator.storage.getDirectory();
            const packRoot = await root.getDirectoryHandle('lean-packs-v1', { create: true });
            opfsInitDir = await packRoot.getDirectoryHandle('wasm32', { create: true });
        }
    } catch {
        opfsInitDir = undefined;
    }
    for (const [name, receipt] of Object.entries(profile.assets)) {`,
  'worker open OPFS wasm32 pack dir',
);

applyPatch(
  leanWorker,
  `        else if (name === 'lean-init.index.json' || logicalName.endsWith('.pack')) {
            const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
            shared.set(bytes);
            library[logicalName] = shared;
        }`,
  `        else if (name === 'lean-init.index.json' || logicalName.endsWith('.pack')) {
            let storedInOpfs = false;
            if (opfsInitDir && logicalName.endsWith('.pack')) {
                try {
                    const hashTag = (receipt.uncompressed?.sha256 ?? receipt.sha256).slice(0, 16);
                    const fileName = \`\${logicalName.replace(/[^A-Za-z0-9._-]/g, '_')}.\${hashTag}.bin\`;
                    const fh = await opfsInitDir.getFileHandle(fileName, { create: true });
                    if (typeof fh.createSyncAccessHandle === 'function') {
                        const sh = await fh.createSyncAccessHandle();
                        try {
                            if (sh.getSize() !== bytes.length) {
                                sh.truncate(0);
                                const view = new Uint8Array(bytes);
                                let off = 0;
                                while (off < view.length) off += sh.write(view.subarray(off), { at: off });
                                sh.flush();
                            }
                        } finally {
                            sh.close();
                        }
                        library[logicalName] = { __opfsPack: true, dir: 'wasm32', fileName, bytes: bytes.length };
                        storedInOpfs = true;
                    }
                } catch {
                    storedInOpfs = false;
                }
            }
            if (!storedInOpfs) {
                const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
                shared.set(bytes);
                library[logicalName] = shared;
            }
        }`,
  'worker persist wasm32 packs to OPFS when supported',
);

applyPatch(
  leanWorker,
  `    for (const [name, buffer] of Object.entries(data.options.extensionPacks ?? {})) {
        if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) {
            library[name] = new Uint8Array(buffer);
        } else {
            const bytes = new Uint8Array(buffer);
            const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
            shared.set(bytes);
            library[name] = shared;
        }
    }`,
  `    for (const [name, buffer] of Object.entries(data.options.extensionPacks ?? {})) {
        if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) {
            library[name] = new Uint8Array(buffer);
        } else {
            const bytes = new Uint8Array(buffer);
            const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
            shared.set(bytes);
            library[name] = shared;
        }
    }
    for (const [name, ref] of Object.entries(data.options.extensionOpfsPacks ?? {})) {
        if (ref && ref.__opfsPack === true)
            library[name] = ref;
    }`,
  'worker accept extensionOpfsPacks references',
);

applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\ttry {
\t\tlet exited = false;
\t\tconst onExit = (code) => {
\t\t\tif (!exited) {
\t\t\t\texited = true;
\t\t\t\tself.postMessage({ exit: code });
\t\t\t}
\t\t};`,
  `\tconst openedReaders = [];
\tconst closeReaders = () => {
\t\tfor (const reader of openedReaders) {
\t\t\ttry { reader.close(); } catch {}
\t\t}
\t\topenedReaders.length = 0;
\t};
\ttry {
\t\tlet exited = false;
\t\tconst onExit = (code) => {
\t\t\tcloseReaders();
\t\t\tif (!exited) {
\t\t\t\texited = true;
\t\t\t\tself.postMessage({ exit: code });
\t\t\t}
\t\t};`,
  'runtime-worker track and close OPFS handles on exit',
);

applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t\tconst isServerBootstrap = Array.isArray(data.args) && data.args.includes('--server');
\t\tfor (const file of (isServerBootstrap ? [] : unpackLibrary(data.library))) {
\t\t\tconst path = LIBRARY_ROOT + '/' + file.path;
\t\t\tlean.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
\t\t\t// Copy into this process: a document's #eval must never modify the shared source pack.
\t\t\tlean.FS.writeFile(path, file.bytes, { canOwn: true });
\t\t}`,
  `\t\tconst isServerBootstrap = Array.isArray(data.args) && data.args.includes('--server');
\t\tconst hasOpfsPacks = !isServerBootstrap && data.library && Object.values(data.library).some((v) => v && v.__opfsPack === true);
\t\tif (hasOpfsPacks) {
\t\t\tconst root = await navigator.storage.getDirectory();
\t\t\tconst packRoot = await root.getDirectoryHandle('lean-packs-v1');
\t\t\tconst readerCache = new Map();
\t\t\tconst openSync = async (ref) => {
\t\t\t\tconst cacheKey = ref.dir + '/' + ref.fileName;
\t\t\t\tif (readerCache.has(cacheKey)) return readerCache.get(cacheKey);
\t\t\t\tconst dirH = await packRoot.getDirectoryHandle(ref.dir);
\t\t\t\tconst fileH = await dirH.getFileHandle(ref.fileName);
\t\t\t\tconst openOnce = async () => {
\t\t\t\t\ttry { return await fileH.createSyncAccessHandle({ mode: 'read-only' }); }
\t\t\t\t\tcatch (e) { if (e instanceof TypeError || e?.name === 'NotSupportedError') return await fileH.createSyncAccessHandle(); throw e; }
\t\t\t\t};
\t\t\t\tconst delays = [20, 40, 80, 160, 320];
\t\t\t\tlet reader;
\t\t\t\tfor (let attempt = 0; ; attempt++) {
\t\t\t\t\ttry { reader = await openOnce(); break; }
\t\t\t\t\tcatch (e) {
\t\t\t\t\t\tif (e?.name === 'NoModificationAllowedError' && attempt < delays.length) {
\t\t\t\t\t\t\tawait new Promise((r) => setTimeout(r, delays[attempt]));
\t\t\t\t\t\t\tcontinue;
\t\t\t\t\t\t}
\t\t\t\t\t\tthrow e;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treaderCache.set(cacheKey, reader);
\t\t\t\topenedReaders.push(reader);
\t\t\t\treturn reader;
\t\t\t};
\t\t\tconst readSegs = (segs, pos, dst, dstOff, len, scratch) => {
\t\t\t\tlet segStart = 0, totalRead = 0;
\t\t\t\tconst isShared = typeof SharedArrayBuffer === 'function' && dst.buffer instanceof SharedArrayBuffer;
\t\t\t\tfor (const seg of segs) {
\t\t\t\t\tconst segEnd = segStart + seg.byteLength;
\t\t\t\t\tconst rs = Math.max(pos, segStart), re = Math.min(pos + len, segEnd);
\t\t\t\t\tif (rs < re) {
\t\t\t\t\t\tconst need = re - rs, atBase = seg.fileOffset + (rs - segStart), outBase = dstOff + (rs - pos);
\t\t\t\t\t\tlet done = 0;
\t\t\t\t\t\twhile (done < need) {
\t\t\t\t\t\t\tif (isShared) {
\t\t\t\t\t\t\t\tconst step = Math.min(need - done, scratch.byteLength);
\t\t\t\t\t\t\t\tconst n = seg.reader.read(scratch.subarray(0, step), { at: atBase + done });
\t\t\t\t\t\t\t\tif (n <= 0) break;
\t\t\t\t\t\t\t\tdst.set(scratch.subarray(0, n), outBase + done);
\t\t\t\t\t\t\t\tdone += n;
\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\tconst n = seg.reader.read(dst.subarray(outBase + done, outBase + need), { at: atBase + done });
\t\t\t\t\t\t\t\tif (n <= 0) break;
\t\t\t\t\t\t\t\tdone += n;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\ttotalRead += done;
\t\t\t\t\t\tif (done < need) break;
\t\t\t\t\t}
\t\t\t\t\tsegStart = segEnd;
\t\t\t\t}
\t\t\t\treturn totalRead;
\t\t\t};
\t\t\tconst opsCache = new WeakMap();
\t\t\tconst empty = new Uint8Array(0);
\t\t\tconst createdDirs = new Set();
\t\t\tconst indexPaths = Object.keys(data.library).filter((n) => n.endsWith('.index.json')).sort();
\t\t\tif (!indexPaths.includes('lean-init.index.json')) throw new Error('Lean library index is missing.');
\t\t\tfor (const indexPath of indexPaths) {
\t\t\t\tconst index = JSON.parse(new TextDecoder().decode(new Uint8Array(data.library[indexPath])));
\t\t\t\tconst chunks = [];
\t\t\t\tfor (const chunk of index.chunks) {
\t\t\t\t\tconst entry = data.library[chunk.path.replace(/\\.(gz|zst)(\\.bin)?$/, '')];
\t\t\t\t\tif (entry && entry.__opfsPack === true && entry.bytes === chunk.uncompressedBytes) {
\t\t\t\t\t\tchunks.push({ ...chunk, kind: 'opfs', reader: await openSync(entry) });
\t\t\t\t\t} else if (entry instanceof Uint8Array && entry.byteLength === chunk.uncompressedBytes) {
\t\t\t\t\t\tchunks.push({ ...chunk, kind: 'sab', bytes: entry });
\t\t\t\t\t} else {
\t\t\t\t\t\tthrow new Error(\`Lean library chunk \${chunk.path} is missing.\`);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tfor (const file of index.files) {
\t\t\t\t\tif (!/^(Init|Std|Batteries)(\\/[A-Za-z0-9_.-]+)*\\.(olean(\\.server|\\.private)?|ilean|ir(\\.sig)?)$/.test(file.path))
\t\t\t\t\t\tthrow new Error(\`Lean library entry \${file.path} is invalid.\`);
\t\t\t\t\tconst overlaps = [];
\t\t\t\t\tlet covered = 0;
\t\t\t\t\tfor (const chunk of chunks) {
\t\t\t\t\t\tconst start = Math.max(file.offset, chunk.offset);
\t\t\t\t\t\tconst end = Math.min(file.offset + file.bytes, chunk.offset + chunk.uncompressedBytes);
\t\t\t\t\t\tif (start < end) { overlaps.push({ chunk, ls: start - chunk.offset, le: end - chunk.offset }); covered += end - start; }
\t\t\t\t\t}
\t\t\t\t\tif (covered !== file.bytes) throw new Error(\`Lean library entry \${file.path} is truncated.\`);
\t\t\t\t\tconst target = LIBRARY_ROOT + '/' + file.path;
\t\t\t\t\tconst dir = target.slice(0, target.lastIndexOf('/'));
\t\t\t\t\tif (!createdDirs.has(dir)) { lean.FS.mkdirTree(dir); createdDirs.add(dir); }
\t\t\t\t\tif (overlaps.length > 0 && overlaps.every((o) => o.chunk.kind === 'opfs')) {
\t\t\t\t\t\tconst segs = overlaps.map((o) => ({ reader: o.chunk.reader, fileOffset: o.ls, byteLength: o.le - o.ls }));
\t\t\t\t\t\tlean.FS.writeFile(target, empty);
\t\t\t\t\t\tconst node = lean.FS.lookupPath(target).node;
\t\t\t\t\t\tlet lazyOps = opsCache.get(node.stream_ops);
\t\t\t\t\t\tif (!lazyOps) {
\t\t\t\t\t\t\tconst baseOps = node.stream_ops;
\t\t\t\t\t\t\tconst scratch = new Uint8Array(256 * 1024);
\t\t\t\t\t\t\tlazyOps = {
\t\t\t\t\t\t\t\t...baseOps,
\t\t\t\t\t\t\t\tread(stream, buf, off, len, pos) {
\t\t\t\t\t\t\t\t\tconst s = stream.node.__lazySegments;
\t\t\t\t\t\t\t\t\tif (!s) return baseOps.read(stream, buf, off, len, pos);
\t\t\t\t\t\t\t\t\tconst toRead = Math.min(Math.max(0, stream.node.usedBytes - pos), len);
\t\t\t\t\t\t\t\t\treturn toRead <= 0 ? 0 : readSegs(s, pos, buf, off, toRead, scratch);
\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\tmmap(stream, len, pos, prot, flags) {
\t\t\t\t\t\t\t\t\tconst s = stream.node.__lazySegments;
\t\t\t\t\t\t\t\t\tif (!s || !baseOps.mmap) return baseOps.mmap?.(stream, len, pos, prot, flags);
\t\t\t\t\t\t\t\t\tconst actual = Math.min(Math.max(0, stream.node.usedBytes - pos), len);
\t\t\t\t\t\t\t\t\tconst temp = new Uint8Array(actual);
\t\t\t\t\t\t\t\t\tif (actual > 0) readSegs(s, pos, temp, 0, actual, scratch);
\t\t\t\t\t\t\t\t\tstream.node.contents = temp;
\t\t\t\t\t\t\t\t\ttry { return baseOps.mmap(stream, len, 0, prot, flags); } finally { stream.node.contents = null; }
\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t};
\t\t\t\t\t\t\topsCache.set(baseOps, lazyOps);
\t\t\t\t\t\t}
\t\t\t\t\t\tnode.usedBytes = file.bytes;
\t\t\t\t\t\tnode.contents = null;
\t\t\t\t\t\tnode.__lazySegments = segs;
\t\t\t\t\t\tnode.stream_ops = lazyOps;
\t\t\t\t\t} else if (overlaps.length === 1 && overlaps[0].chunk.kind === 'sab') {
\t\t\t\t\t\tlean.FS.writeFile(target, overlaps[0].chunk.bytes.subarray(overlaps[0].ls, overlaps[0].le), { canOwn: true });
\t\t\t\t\t} else {
\t\t\t\t\t\tconst out = new Uint8Array(file.bytes);
\t\t\t\t\t\tlet w = 0;
\t\t\t\t\t\tfor (const o of overlaps) {
\t\t\t\t\t\t\tconst n = o.le - o.ls;
\t\t\t\t\t\t\tif (o.chunk.kind === 'sab') out.set(o.chunk.bytes.subarray(o.ls, o.le), w);
\t\t\t\t\t\t\telse readSegs([{ reader: o.chunk.reader, fileOffset: o.ls, byteLength: n }], 0, out, w, n, new Uint8Array(0));
\t\t\t\t\t\t\tw += n;
\t\t\t\t\t\t}
\t\t\t\t\t\tlean.FS.writeFile(target, out, { canOwn: true });
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t} else {
\t\t\tfor (const file of (isServerBootstrap ? [] : unpackLibrary(data.library))) {
\t\t\t\tconst path = LIBRARY_ROOT + '/' + file.path;
\t\t\t\tlean.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
\t\t\t\t// Copy into this process: a document's #eval must never modify the shared source pack.
\t\t\t\tlean.FS.writeFile(path, file.bytes, { canOwn: true });
\t\t\t}
\t\t}
\t\tdata.library = null;`,
  'runtime-worker OPFS lazy mount and data.library release',
);

applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t} catch (error) {
\t\tself.postMessage({ error: String(error), stack: error?.stack });
\t}`,
  `\t} catch (error) {
\t\tcloseReaders();
\t\tself.postMessage({ error: String(error), stack: error?.stack });
\t}`,
  'runtime-worker close OPFS handles on error',
);

/**
 * 5d. 打通 wasm32 真实线性内存遥测：
 *     - runtime-worker 在创建 Wasm 内存后回传 wasmMemory 引用与初始字节数，并在 stdio write 时增量推送；
 *     - worker 在 dispose() 时立即置空 processWasmMemory 避免持有 1 GiB SAB 泄漏；
 *     - worker 在进入 queued 串口链之前直接响应 pollMemory，保证主动采样不被长阻塞队列卡住。
 */
applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t\tconst { default: createLean } = await import(/* @vite-ignore */ data.glueUrl);
\t\tconst lean = await createLean({
\t\t\tnoInitialRun: true,
\t\t\tonExit,
\t\t\tlspProcessExit: onExit,
\t\t\tlspStdin: data.stdin,
\t\t\twasmMemory: new WebAssembly.Memory({
\t\t\t\tinitial: 4096,
\t\t\t\tmaximum: data.maxMemoryBytes / 65536,
\t\t\t\tshared: true
\t\t\t}),`,
  `\t\tconst wasmMemory = new WebAssembly.Memory({
\t\t\tinitial: 4096,
\t\t\tmaximum: data.maxMemoryBytes / 65536,
\t\t\tshared: true
\t\t});
\t\tlet lastMemoryBytes = wasmMemory.buffer.byteLength;
\t\tconst reportMemory = () => {
\t\t\tconst bytes = wasmMemory.buffer.byteLength;
\t\t\tif (bytes !== lastMemoryBytes) {
\t\t\t\tlastMemoryBytes = bytes;
\t\t\t\tself.postMessage({ memoryBytes: bytes });
\t\t\t}
\t\t};
\t\tconst { default: createLean } = await import(/* @vite-ignore */ data.glueUrl);
\t\tconst lean = await createLean({
\t\t\tnoInitialRun: true,
\t\t\tonExit,
\t\t\tlspProcessExit: onExit,
\t\t\tlspStdin: data.stdin,
\t\t\twasmMemory,`,
  'runtime-worker wasmMemory tracker',
);

applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t\t\t\twrite(_stream, buffer, offset, length) {
\t\t\t\t\tif (length)`,
  `\t\t\t\twrite(_stream, buffer, offset, length) {
\t\t\t\t\treportMemory();
\t\t\t\t\tif (length)`,
  'runtime-worker reportMemory on stdio write',
);

applyPatch(
  path.join('lean4', 'runtime-worker.js'),
  `\t\tlean.FS.chdir('/workspace');
\t\tself.postMessage({ ready: true });`,
  `\t\tlean.FS.chdir('/workspace');
\t\tlastMemoryBytes = wasmMemory.buffer.byteLength;
\t\tself.postMessage({ ready: true, memoryBytes: lastMemoryBytes, wasmMemory });`,
  'runtime-worker expose wasmMemory on ready',
);

applyPatch(
  leanWorker,
  `    let disposed = false;
    const pthreads = new Map();
    let startupTimer;`,
  `    let disposed = false;
    const pthreads = new Map();
    let startupTimer;
    let processWasmMemory;`,
  'worker processWasmMemory slot',
);

applyPatch(
  leanWorker,
  `            else if (data.ready) {
                clearTimeout(startupTimer);
                resolve();
            }
            else if (data.stdout)`,
  `            else if (data.ready) {
                clearTimeout(startupTimer);
                if (data.wasmMemory)
                    processWasmMemory = data.wasmMemory;
                if (typeof data.memoryBytes === 'number')
                    scope.postMessage({ memoryBytes: data.memoryBytes });
                resolve();
            }
            else if (typeof data.memoryBytes === 'number')
                scope.postMessage({ memoryBytes: data.memoryBytes });
            else if (data.stdout)`,
  'worker relay wasmMemory and memoryBytes',
);

applyPatch(
  leanWorker,
  `    const process = {
        ready,
        send: (message) => {`,
  `    const process = {
        ready,
        sampleMemoryBytes: () => processWasmMemory?.buffer.byteLength ?? null,
        send: (message) => {`,
  'worker sampleMemoryBytes on process',
);

applyPatch(
  leanWorker,
  `            stdin.close();
            for (const pthread of pthreads.values())`,
  `            stdin.close();
            processWasmMemory = undefined;
            for (const pthread of pthreads.values())`,
  'worker clear processWasmMemory on dispose',
);

applyPatch(
  leanWorker,
  `    if (data?.type === 'lean-worker-event') {
        const worker = ownedWorkers.get(data.id);
        if (data.error)
            worker?.onerror?.({ message: data.error, preventDefault() { } });
        else
            worker?.onmessage?.({ data: data.data });
        return;
    }
    queued = queued`,
  `    if (data?.type === 'lean-worker-event') {
        const worker = ownedWorkers.get(data.id);
        if (data.error)
            worker?.onerror?.({ message: data.error, preventDefault() { } });
        else
            worker?.onmessage?.({ data: data.data });
        return;
    }
    if (data?.type === 'pollMemory') {
        const memoryBytes = fileProcess?.sampleMemoryBytes?.() ?? null;
        scope.postMessage({ type: 'memorySample', id: data.id, memoryBytes });
        return;
    }
    queued = queued`,
  'worker non-blocking pollMemory handler',
);

/**
 * 5. 包内硬编码的 runner worker 字节数与 SHA-256 用我们的源文件动态重算，
 *    并同步到 workerReceipt；?v= 随之变化，cacheKey 保持不变。
 */
const workerPath = path.join(root, 'scripts', 'assets', 'runner-worker.js');
const workerBytes = readFileSync(workerPath);
const workerSha = createHash('sha256').update(workerBytes).digest('hex');
const runtimePath = path.join(lspDist, 'bundledLean4Runtime.js');

/**
 * 6. 把 config/lean4-runtime.json 的交付哈希同步进包内 profile。
 *    这里直接 import 干净包里的 profile、改 assets 再整体写回，避免用正则
 *    逐个匹配六个 pack；上游升级后字段形状变化会在这里立刻暴露。
 */
const manifest = JSON.parse(readFileSync(path.join(root, 'config', 'lean4-runtime.json'), 'utf8'));
const { WASM_LEAN4_PROFILE: profile } = await import(pathToFileURL(runtimePath).href);
const runtimeVersion = /(\d+\.\d+\.\d+)/.exec(manifest.runtime ?? '')?.[1];
if (runtimeVersion) {
  profile.version = runtimeVersion;
  profile.profileId = String(profile.profileId).replace(/\d+\.\d+\.\d+/, runtimeVersion);
}
for (const asset of manifest.assets) {
  const entry = profile.assets[asset.name];
  if (!entry) continue;
  entry.bytes = asset.bytes;
  entry.sha256 = asset.sha256;
  if (asset.encoding === 'zstd') {
    entry.encoding = 'zstd';
    entry.uncompressed = {
      bytes: asset.uncompressedBytes,
      sha256: asset.uncompressedSha256,
    };
  }
}
profile.workerReceipt = { bytes: workerBytes.length, sha256: workerSha };
writeFileSync(
  runtimePath,
  `export const WASM_LEAN4_PROFILE = ${JSON.stringify(profile, null, 4)};\n//# sourceMappingURL=bundledLean4Runtime.js.map\n`,
);
console.log(
  `lsp patch: profile assets synced (${profile.version ?? 'unknown'}); workerReceipt -> ${workerBytes.length} bytes / ${workerSha.slice(0, 12)}…`,
);
