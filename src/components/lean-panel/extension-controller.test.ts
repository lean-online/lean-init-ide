import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../i18n/zh';
import { createExtensionController } from './extension-controller';

const buildHost = () => {
  const host = document.createElement('div');
  host.innerHTML = `
    <span data-role="runtime-arch-label"></span>
    <span data-role="runtime-arch-note"></span>
    <button data-runtime-arch="wasm32"></button>
    <button data-runtime-arch="wasm64"></button>
    <div data-extension-row>
      <input type="checkbox" data-library-default="std" data-extension-arch="wasm32" />
      <button data-library="std" data-extension-arch="wasm32"></button>
    </div>
    <div data-extension-row>
      <input type="checkbox" data-library-default="batteries" data-extension-arch="wasm32" />
      <button data-library="batteries" data-extension-arch="wasm32"></button>
    </div>
    <button data-role="release-all-libraries"></button>
  `;
  return host;
};

describe('createExtensionController', () => {
  const t = zh.playground;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('课程需要 wasm32 扩展时自动把已存的 wasm64 偏好切回 wasm32 并持久化', async () => {
    localStorage.setItem('lean:runtime-arch', 'wasm64');
    const host = buildHost();
    const loadPacks = vi.fn().mockResolvedValue({ 'lean-std.index.json': new ArrayBuffer(4) });
    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: ['std'],
      log: () => {},
      setStatus: () => {},
      closeMenus: () => {},
      isSessionActive: () => false,
      restartSession: async () => {},
      hasExtensionOnArch: (arch) => arch === 'wasm32',
      loadPacks,
      probeMemory64: () => true,
      isWasm64Published: () => true,
    });

    expect(controller.getSelectedArch()).toBe('wasm32');
    expect(controller.wasAutoSwitchedFromWasm64()).toBe(true);
    expect(localStorage.getItem('lean:runtime-arch')).toBe('wasm32');

    await controller.restoreSavedExtensions();
    expect(loadPacks).toHaveBeenCalledWith(['std']);
    expect(controller.getActiveExtensions()).toEqual(['std']);
  });

  it('首次未启动会话恢复扩展时不误显正在重启文案，排队下载可被 drainExtensionSelections 完整等待', async () => {
    localStorage.setItem('lean:default-extensions', JSON.stringify(['std']));
    const host = buildHost();
    const statuses: string[] = [];
    let releaseLoad!: () => void;
    const loadPacks = vi.fn(
      () =>
        new Promise<Record<string, ArrayBuffer>>((resolve) => {
          releaseLoad = () => resolve({ 'lean-std.index.json': new ArrayBuffer(4) });
        }),
    );

    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: [],
      log: () => {},
      setStatus: (text) => statuses.push(text),
      closeMenus: () => {},
      isSessionActive: () => false,
      restartSession: async () => {},
      loadPacks,
    });

    const restoring = controller.restoreSavedExtensions();
    expect(statuses).toContain(t.statusLoading);
    expect(statuses).not.toContain(t.libraryRestarting);

    releaseLoad();
    await restoring;

    // 手动触发按钮下载，确认 drainExtensionSelections 会真正等到在途 Promise 结束。
    let resolvedManual = false;
    loadPacks.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolvedManual = true;
            resolve({ 'lean-batteries.index.json': new ArrayBuffer(4) });
          }, 10),
        ),
    );
    host.querySelector<HTMLButtonElement>('[data-library="batteries"]')!.click();
    await controller.drainExtensionSelections();
    expect(resolvedManual).toBe(true);
    expect(controller.getActiveExtensions()).toContain('batteries');
  });

  it('切换运行时架构触发 onArchChanged 与重启，并支持 quick-fix 回切加载扩展', async () => {
    const host = buildHost();
    const onArchChanged = vi.fn();
    const restartSession = vi.fn(async () => {});
    const loadPacks = vi.fn().mockResolvedValue({ 'lean-std.index.json': new ArrayBuffer(8) });
    const logs: string[] = [];

    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: [],
      log: (m) => logs.push(m),
      setStatus: () => {},
      closeMenus: () => {},
      isSessionActive: () => true,
      restartSession,
      onArchChanged,
      hasExtensionOnArch: (arch) => arch === 'wasm32',
      loadPacks,
      probeMemory64: () => true,
      isWasm64Published: () => true,
    });

    host.querySelector<HTMLButtonElement>('[data-runtime-arch="wasm64"]')!.click();
    expect(controller.getSelectedArch()).toBe('wasm64');
    expect(onArchChanged).toHaveBeenCalledWith('wasm64');
    expect(restartSession).toHaveBeenCalledTimes(1);

    controller.enableFromQuickFix('std');
    await Promise.resolve();
    await controller.drainExtensionSelections();
    expect(controller.getSelectedArch()).toBe('wasm32');
    expect(onArchChanged).toHaveBeenLastCalledWith('wasm32');
    expect(controller.getActiveExtensions()).toEqual(['std']);
  });

  it('勾选默认库同步依赖并支持释放全部及加载失败回滚', async () => {
    const host = buildHost();
    let failLoad = false;
    const loadPacks = vi.fn(async (ids) => {
      if (failLoad) throw new Error('download error');
      return { [`${ids[0]}.pack`]: new ArrayBuffer(4) };
    });
    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: [],
      log: () => {},
      setStatus: () => {},
      closeMenus: () => {},
      isSessionActive: () => false,
      restartSession: async () => {},
      loadPacks,
      probeMemory64: () => false,
      isWasm64Published: () => false,
    });

    // 默认选中 batteries 会联动选中 std。
    const batDefault = host.querySelector<HTMLInputElement>('[data-library-default="batteries"]')!;
    const stdDefault = host.querySelector<HTMLInputElement>('[data-library-default="std"]')!;
    batDefault.checked = true;
    batDefault.dispatchEvent(new Event('change'));
    expect(stdDefault.checked).toBe(true);

    // 点击加载 std 后再点释放全部。
    host.querySelector<HTMLButtonElement>('[data-library="std"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getActiveExtensions()).toEqual(['std']);

    host.querySelector<HTMLButtonElement>('[data-role="release-all-libraries"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getActiveExtensions()).toEqual([]);

    // 加载失败应保持先前状态。
    failLoad = true;
    host.querySelector<HTMLButtonElement>('[data-library="std"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getActiveExtensions()).toEqual([]);
  });

  it('wasm64 已发布对应扩展时保留 wasm64 架构并在 quick-fix 中不误回退 wasm32', async () => {
    localStorage.setItem('lean:runtime-arch', 'wasm64');
    const host = buildHost();
    const onArchChanged = vi.fn();
    const loadPacks = vi.fn().mockResolvedValue({});
    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: ['std'],
      log: () => {},
      setStatus: () => {},
      closeMenus: () => {},
      isSessionActive: () => false,
      restartSession: async () => {},
      onArchChanged,
      hasExtensionOnArch: () => true,
      resolveIds: (ids) => [...ids],
      loadPacks,
      probeMemory64: () => true,
      isWasm64Published: () => true,
    });

    expect(controller.getSelectedArch()).toBe('wasm64');
    expect(controller.wasAutoSwitchedFromWasm64()).toBe(false);

    controller.enableFromQuickFix('std');
    await Promise.resolve();
    await controller.drainExtensionSelections();
    expect(controller.getSelectedArch()).toBe('wasm64');
    expect(onArchChanged).not.toHaveBeenCalled();
    expect(loadPacks).toHaveBeenCalledWith(['std'], expect.any(Function), 'wasm64');
    expect(controller.getActiveExtensions()).toEqual(['std']);
    expect(controller.getExtensionPacks()).toEqual({});
  });

  it('修复跨架构默认勾选串台、按钮进度隔离、切换重载与 clearPackCache 释放', async () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <span data-role="runtime-arch-label"></span>
      <span data-role="runtime-arch-note"></span>
      <button data-runtime-arch="wasm32"></button>
      <button data-runtime-arch="wasm64"></button>
      <div data-extension-row>
        <input type="checkbox" data-library-default="std" data-extension-arch="wasm32" />
        <button data-library="std" data-extension-arch="wasm32"></button>
      </div>
      <div data-extension-row>
        <input type="checkbox" data-library-default="std" data-extension-arch="wasm64" />
        <button data-library="std" data-extension-arch="wasm64"></button>
      </div>
      <button data-role="release-all-libraries"></button>
    `;
    let active = true;
    const restartSession = vi.fn(async () => {});
    const loadPacks = vi.fn(
      async (
        ids: Iterable<string>,
        onProgress?: (r: number, l: string) => void,
        arch = 'wasm32',
      ) => {
        onProgress?.(0.5, 'Std');
        return arch === 'wasm32'
          ? { [`${[...ids][0]}-32.pack`]: new ArrayBuffer(4) }
          : { [`${[...ids][0]}-64.pack`]: new ArrayBuffer(4) };
      },
    );

    const controller = createExtensionController({
      host,
      t,
      requiredExtensions: [],
      log: () => {},
      setStatus: () => {},
      closeMenus: () => {},
      isSessionActive: () => active,
      restartSession,
      hasExtensionOnArch: (_arch, id) => id === 'std',
      resolveIds: (ids) => [...ids],
      loadPacks,
      probeMemory64: () => true,
      isWasm64Published: () => true,
    });

    const chk32 = host.querySelector<HTMLInputElement>(
      '[data-library-default="std"][data-extension-arch="wasm32"]',
    )!;
    const chk64 = host.querySelector<HTMLInputElement>(
      '[data-library-default="std"][data-extension-arch="wasm64"]',
    )!;
    const btn32 = host.querySelector<HTMLButtonElement>(
      '[data-library="std"][data-extension-arch="wasm32"]',
    )!;
    const btn64 = host.querySelector<HTMLButtonElement>(
      '[data-library="std"][data-extension-arch="wasm64"]',
    )!;

    // 1. wasm32 勾选默认 Std，切到 wasm64 时不得自动勾上 wasm64 的 Std。
    chk32.checked = true;
    chk32.dispatchEvent(new Event('change'));
    host.querySelector<HTMLButtonElement>('[data-runtime-arch="wasm64"]')!.click();
    expect(chk64.checked).toBe(false);

    // 2. 在 wasm64 点击加载 Std，进度回调只更新 wasm64 按钮且真正调用 loadPacks(..., 'wasm64')。
    btn64.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(loadPacks).toHaveBeenCalledWith(['std'], expect.any(Function), 'wasm64');
    expect(btn32.textContent).toBe(t.libraryLoad);
    expect(btn64.dataset.state).toBe('loaded');

    // 3. 带已加载的 std 从 wasm64 切回 wasm32：自动按新架构重下 32 位 pack 并重启会话。
    host.querySelector<HTMLButtonElement>('[data-runtime-arch="wasm32"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getActiveExtensions()).toEqual(['std']);
    expect(Object.keys(controller.getExtensionPacks())).toEqual(['std-32.pack']);
    expect(restartSession).toHaveBeenCalledTimes(3);

    // 4. clearPackCache / dispose 立刻清空主线程缓存引用，后续按需可恢复。
    active = false;
    controller.clearPackCache();
    expect(controller.getExtensionPacks()).toEqual({});
    await controller.restoreSavedExtensions();
    controller.dispose();
    expect(controller.getExtensionPacks()).toEqual({});
  });
});
