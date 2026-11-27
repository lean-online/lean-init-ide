/**
 * 运行时架构（wasm32 / 实验性 wasm64）与扩展库按需加载控制器：
 * 负责扩展依赖展开、按架构隔离的默认勾选偏好、队列防重入、
 * sessionStorage/localStorage 持久化、缓存释放生命周期以及架构切换同步。
 */
import { DEFAULT_RUNTIME_ARCH, probeMemory64Support, type LeanRuntimeArch } from '../../device';
import type { Messages } from '../../i18n/types';
import { wasm64Available } from '../../lean-wasm64-available';
import {
  extensionById,
  loadExtensionPacks,
  resolveExtensionIds,
  runtimeExtensions,
  runtimeExtensionsFor,
  type ExtensionPacks,
  type RuntimeArch,
  type RuntimeExtensionId,
} from '../../runtime-extensions';
import {
  getDefaultExtensions,
  getRuntimeArch,
  readRuntimeSession,
  setDefaultExtensions,
  setRuntimeArch,
  writeRuntimeSession,
} from '../../settings';

type StatusKind = 'idle' | 'loading' | 'ready' | 'error';

export type ExtensionControllerOptions = {
  readonly host: HTMLElement;
  readonly t: Messages['playground'];
  readonly requiredExtensions: readonly RuntimeExtensionId[];
  readonly log: (message: string) => void;
  readonly setStatus: (text: string, kind: StatusKind) => void;
  readonly closeMenus: () => void;
  readonly isSessionActive: () => boolean;
  readonly restartSession: () => Promise<void>;
  readonly onArchChanged?: (arch: LeanRuntimeArch) => void;
  readonly hasExtensionOnArch?: (arch: RuntimeArch, id: RuntimeExtensionId) => boolean;
  readonly resolveIds?: typeof resolveExtensionIds;
  readonly loadPacks?: typeof loadExtensionPacks;
  readonly probeMemory64?: typeof probeMemory64Support;
  readonly isWasm64Published?: typeof wasm64Available;
};

const isRuntimeExtensionId = (id: string): id is RuntimeExtensionId =>
  runtimeExtensions.some((extension) => extension.id === id);

const encodeDefaultExtensions = (
  byArch: Readonly<Record<RuntimeArch, ReadonlySet<RuntimeExtensionId>>>,
): string[] => [
  ...[...byArch.wasm32].map((id) => `wasm32:${id}`),
  ...[...byArch.wasm64].map((id) => `wasm64:${id}`),
];

export const createExtensionController = (options: ExtensionControllerOptions) => {
  const {
    host,
    t,
    requiredExtensions,
    log,
    setStatus,
    closeMenus,
    isSessionActive,
    restartSession,
  } = options;
  const loadPacks = options.loadPacks ?? loadExtensionPacks;
  const memory64Supported = (options.probeMemory64 ?? probeMemory64Support)();
  const wasm64Published = (options.isWasm64Published ?? wasm64Available)();
  let selectedArch: LeanRuntimeArch =
    getRuntimeArch() === 'wasm64' && memory64Supported && wasm64Published
      ? 'wasm64'
      : DEFAULT_RUNTIME_ARCH;

  // 课程声明 requires 但 wasm64 尚未发布对应扩展时，先把实验性 wasm64 退回稳定版。
  const resolveForArch = options.resolveIds ?? resolveExtensionIds;
  const extensionAvailableOn =
    options.hasExtensionOnArch ??
    ((arch: RuntimeArch, id: RuntimeExtensionId) => extensionById(id, arch)?.arch === arch);
  const wasm64BlockedByExtensions = requiredExtensions.some(
    (id) => !extensionAvailableOn('wasm64', id),
  );
  const autoStableFromWasm64 = wasm64BlockedByExtensions && selectedArch === 'wasm64';
  if (autoStableFromWasm64) {
    selectedArch = DEFAULT_RUNTIME_ARCH;
    setRuntimeArch(selectedArch);
  }

  const savedSession = readRuntimeSession();
  const sessionExtensionIds = (savedSession?.extensions ?? []).filter(isRuntimeExtensionId);

  // 按架构隔离默认勾选偏好（例如 wasm32 勾 Std 不应隐式触发 wasm64 280MB Std 默认下载）；
  // 旧版未带前缀的纯 id 兼容视为 wasm32 偏好。
  const defaultExtensionsByArch: Record<RuntimeArch, Set<RuntimeExtensionId>> = {
    wasm32: new Set<RuntimeExtensionId>(),
    wasm64: new Set<RuntimeExtensionId>(),
  };
  for (const raw of getDefaultExtensions()) {
    if (raw.startsWith('wasm32:')) {
      const id = raw.slice('wasm32:'.length);
      if (isRuntimeExtensionId(id) && extensionAvailableOn('wasm32', id)) {
        defaultExtensionsByArch.wasm32.add(id);
      }
    } else if (raw.startsWith('wasm64:')) {
      const id = raw.slice('wasm64:'.length);
      if (isRuntimeExtensionId(id) && extensionAvailableOn('wasm64', id)) {
        defaultExtensionsByArch.wasm64.add(id);
      }
    } else if (isRuntimeExtensionId(raw) && extensionAvailableOn('wasm32', raw)) {
      defaultExtensionsByArch.wasm32.add(raw);
    }
  }

  const navEntry = performance?.getEntriesByType?.('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const resumeRuntime = savedSession?.active === true && navEntry?.type !== 'reload';

  const extensionPackCache = new Map<RuntimeExtensionId, ExtensionPacks>();
  const activeExtensions = new Set<RuntimeExtensionId>();
  let extensionPacks: ExtensionPacks = {};
  let desiredExtensions = new Set<RuntimeExtensionId>();
  let pendingSelection: Set<RuntimeExtensionId> | null = null;
  let restorePromise: Promise<void> | null = null;
  let activeDrainPromise: Promise<void> | null = null;

  const libraryButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-library]')];
  const defaultCheckboxes = [...host.querySelectorAll<HTMLInputElement>('[data-library-default]')];
  const releaseAllEl = host.querySelector<HTMLButtonElement>('[data-role="release-all-libraries"]');
  const runtimeArchLabelEl = host.querySelector<HTMLElement>('[data-role="runtime-arch-label"]');
  const runtimeArchNoteEl = host.querySelector<HTMLElement>('[data-role="runtime-arch-note"]');
  const runtimeArchButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-runtime-arch]')];

  const librariesUnavailable = () =>
    selectedArch === 'wasm64' && runtimeExtensionsFor('wasm64').length === 0;
  const archOfElement = (element: HTMLElement): RuntimeArch =>
    (element.dataset.extensionArch as RuntimeArch | undefined) ?? 'wasm32';
  const extensionAvailable = (id: RuntimeExtensionId) => extensionAvailableOn(selectedArch, id);
  const persistSession = (active: boolean) => {
    writeRuntimeSession({ active, extensions: [...activeExtensions] });
  };

  const syncLibraryButtons = () => {
    for (const button of libraryButtons) {
      const id = button.dataset.library as RuntimeExtensionId;
      const visible = archOfElement(button) === selectedArch;
      const row = button.closest<HTMLElement>('[data-extension-row]');
      if (row) row.hidden = !visible;
      button.hidden = !visible;
      const active = visible && extensionAvailable(id) && activeExtensions.has(id);
      button.textContent = active ? t.libraryRelease : t.libraryLoad;
      button.dataset.state = active ? 'loaded' : 'idle';
      button.disabled = librariesUnavailable() || !visible || !extensionAvailable(id);
    }
    if (releaseAllEl) releaseAllEl.disabled = activeExtensions.size === 0;
  };

  const syncDefaultCheckboxes = () => {
    const defaultsForArch = defaultExtensionsByArch[selectedArch];
    for (const input of defaultCheckboxes) {
      const id = input.dataset.libraryDefault as RuntimeExtensionId;
      const visible = archOfElement(input) === selectedArch;
      input.hidden = !visible;
      input.checked = visible && extensionAvailable(id) && defaultsForArch.has(id);
      input.disabled = librariesUnavailable() || !visible || !extensionAvailable(id);
    }
  };

  for (const input of defaultCheckboxes) {
    input.addEventListener('change', () => {
      if (librariesUnavailable() || archOfElement(input) !== selectedArch) return;
      const id = input.dataset.libraryDefault as RuntimeExtensionId;
      const defaultsForArch = defaultExtensionsByArch[selectedArch];
      if (input.checked) {
        for (const dependency of resolveForArch([id], selectedArch)) {
          defaultsForArch.add(dependency);
        }
      } else {
        defaultsForArch.delete(id);
        for (const extension of runtimeExtensionsFor(selectedArch)) {
          if (extension.requires.includes(id)) defaultsForArch.delete(extension.id);
        }
      }
      setDefaultExtensions(encodeDefaultExtensions(defaultExtensionsByArch));
      syncDefaultCheckboxes();
    });
  }
  syncDefaultCheckboxes();

  const wasm64Note = () =>
    !memory64Supported
      ? t.runtimeWasm64Unsupported
      : !wasm64Published
        ? t.runtimeWasm64NotPublished
        : wasm64BlockedByExtensions
          ? t.runtimeWasm64NoLibraries
          : '';

  const syncRuntimeArchUi = () => {
    if (runtimeArchLabelEl) {
      runtimeArchLabelEl.textContent = `${t.runtimeTitle}: ${selectedArch === 'wasm64' ? t.runtimeWasm64 : 'wasm32'}`;
    }
    const wasm64Unavailable = wasm64Note() !== '';
    for (const button of runtimeArchButtons) {
      const arch = button.dataset.runtimeArch as LeanRuntimeArch;
      const active = arch === selectedArch;
      button.dataset.active = String(active);
      button.setAttribute('aria-checked', String(active));
      if (arch === 'wasm64' && wasm64Unavailable) button.disabled = true;
    }
    if (runtimeArchNoteEl) {
      runtimeArchNoteEl.textContent =
        wasm64Note() || (selectedArch === 'wasm64' ? t.runtimeWasm64AssetNote : '');
    }
    syncDefaultCheckboxes();
    syncLibraryButtons();
  };

  const commitExtensionSet = (ids: Iterable<RuntimeExtensionId>, buildPacks = true) => {
    const list = [...ids];
    extensionPacks = buildPacks
      ? Object.assign({}, ...(list.length ? list.map((id) => extensionPackCache.get(id)) : []))
      : {};
    activeExtensions.clear();
    for (const id of list) activeExtensions.add(id);
    desiredExtensions = new Set(activeExtensions);
  };

  const prunePackCache = (keep: ReadonlySet<RuntimeExtensionId>) => {
    for (const id of [...extensionPackCache.keys()]) {
      if (!keep.has(id)) extensionPackCache.delete(id);
    }
  };

  /** 清空主线程持有的扩展包缓存并重置加载标志，供退出/退后台/硬限时立即释放内存。 */
  const clearPackCache = () => {
    extensionPackCache.clear();
    extensionPacks = {};
    restorePromise = null;
  };

  const loadMissingPacks = async (
    ids: readonly RuntimeExtensionId[],
    showProgress = false,
    arch: RuntimeArch = selectedArch,
  ) => {
    for (const id of ids) {
      if (extensionPackCache.has(id)) continue;
      const onProgress = showProgress
        ? (ratio: number) => {
            const button = libraryButtons.find(
              (item) => item.dataset.library === id && archOfElement(item) === arch,
            );
            if (button) button.textContent = t.libraryLoading(`${Math.round(ratio * 100)}%`);
          }
        : undefined;
      const packs =
        !showProgress && arch === 'wasm32'
          ? await loadPacks([id])
          : await loadPacks([id], onProgress, arch);
      // wasm64 扩展包已由 OPFS 持久化，由 loadWasm64Runtime 按 id 挂载，无需在主线程保留 packs。
      extensionPackCache.set(id, arch === 'wasm64' ? {} : packs);
    }
  };

  const applyExtensionSelection = async (next: Set<RuntimeExtensionId>) => {
    const previous = new Set(activeExtensions);
    const resolved = resolveForArch(next, selectedArch);
    const wasActive = isSessionActive();
    try {
      await loadMissingPacks(resolved, true, selectedArch);
      prunePackCache(new Set(resolved));
      commitExtensionSet(resolved, selectedArch !== 'wasm64');
      syncLibraryButtons();
      if (wasActive) {
        setStatus(t.libraryRestarting, 'loading');
        await restartSession();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(t.libraryError(message));
      setStatus(t.libraryError(message), 'error');
      prunePackCache(previous);
      commitExtensionSet(previous, selectedArch !== 'wasm64');
      syncLibraryButtons();
    }
    persistSession(isSessionActive());
  };

  const drainExtensionSelections = (): Promise<void> => {
    if (activeDrainPromise) return activeDrainPromise;
    if (!pendingSelection) return restorePromise ?? Promise.resolve();
    activeDrainPromise = (async () => {
      if (restorePromise) await restorePromise;
      syncLibraryButtons();
      try {
        while (pendingSelection) {
          const next = pendingSelection;
          pendingSelection = null;
          await applyExtensionSelection(next);
        }
      } finally {
        activeDrainPromise = null;
        syncLibraryButtons();
      }
    })();
    return activeDrainPromise;
  };

  const enqueueExtensionSelection = (next: Set<RuntimeExtensionId>) => {
    desiredExtensions = new Set(next);
    pendingSelection = new Set(next);
    restorePromise ??= Promise.resolve();
    void drainExtensionSelections();
  };

  for (const button of runtimeArchButtons) {
    button.addEventListener('click', () => {
      const nextArch = button.dataset.runtimeArch as LeanRuntimeArch;
      const blockedReason = nextArch === 'wasm64' ? wasm64Note() : '';
      if (blockedReason) {
        log(blockedReason);
        syncRuntimeArchUi();
        return;
      }
      if (nextArch === selectedArch) return;

      // 切换架构后必须先清空旧架构的 pack 与「已加载」UI 假状态；
      // 对新架构依然支持的保留扩展（如 wasm64 <-> wasm32 的 std），重新下载/OPFS 恢复并重启会话。
      const retained = resolveForArch(activeExtensions, nextArch);
      selectedArch = nextArch;
      setRuntimeArch(nextArch);
      clearPackCache();
      pendingSelection = null;
      activeExtensions.clear();
      desiredExtensions = new Set(retained);
      options.onArchChanged?.(nextArch);
      syncRuntimeArchUi();
      log(t.logRuntimeArchSelected(nextArch === 'wasm64' ? t.runtimeWasm64 : t.runtimeWasm32));
      if (nextArch === 'wasm64') log(t.runtimeWasm64AssetNote);
      closeMenus();
      if (retained.length > 0) {
        enqueueExtensionSelection(new Set(retained));
      } else if (isSessionActive()) {
        void restartSession();
      }
    });
  }
  syncRuntimeArchUi();

  const restoreSavedExtensions = (): Promise<void> => {
    if (restorePromise) return restorePromise;
    const arch = selectedArch;
    const ids = resolveForArch(
      [...sessionExtensionIds, ...defaultExtensionsByArch[arch], ...requiredExtensions],
      arch,
    );
    if (ids.length === 0) {
      restorePromise = Promise.resolve();
      return restorePromise;
    }
    restorePromise = (async () => {
      syncLibraryButtons();
      for (const button of libraryButtons) button.disabled = true;
      setStatus(isSessionActive() ? t.libraryRestarting : t.statusLoading, 'loading');
      try {
        await loadMissingPacks(ids, false, arch);
        commitExtensionSet(ids, arch !== 'wasm64');
      } catch (error) {
        log(t.libraryError(error instanceof Error ? error.message : String(error)));
        writeRuntimeSession({ active: false, extensions: [] });
      } finally {
        syncLibraryButtons();
      }
    })();
    return restorePromise;
  };

  for (const button of libraryButtons) {
    button.addEventListener('click', () => {
      if (librariesUnavailable() || archOfElement(button) !== selectedArch) return;
      const id = button.dataset.library as RuntimeExtensionId;
      const next = new Set(desiredExtensions);
      if (next.has(id)) {
        next.delete(id);
        for (const extension of runtimeExtensionsFor(selectedArch)) {
          if (extension.requires.includes(id)) next.delete(extension.id);
        }
      } else {
        next.add(id);
      }
      enqueueExtensionSelection(next);
    });
  }

  releaseAllEl?.addEventListener('click', () => {
    if (librariesUnavailable()) return;
    enqueueExtensionSelection(new Set());
  });
  syncLibraryButtons();

  return {
    getSelectedArch: () => selectedArch,
    getActiveExtensions: () => [...activeExtensions],
    getExtensionPacks: () => extensionPacks,
    shouldResumeRuntime: () => resumeRuntime,
    wasAutoSwitchedFromWasm64: () => autoStableFromWasm64,
    restoreSavedExtensions,
    drainExtensionSelections,
    clearPackCache,
    dispose: () => {
      pendingSelection = null;
      clearPackCache();
    },
    enableFromQuickFix: (id: RuntimeExtensionId) => {
      if (selectedArch === 'wasm64' && !extensionAvailableOn('wasm64', id)) {
        selectedArch = DEFAULT_RUNTIME_ARCH;
        setRuntimeArch(selectedArch);
        clearPackCache();
        options.onArchChanged?.(selectedArch);
        syncRuntimeArchUi();
      }
      enqueueExtensionSelection(new Set([...desiredExtensions, id]));
    },
    persistSession,
  };
};

export type ExtensionController = ReturnType<typeof createExtensionController>;
