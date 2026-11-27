import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOWER_FLOORS, TowerProgressStore } from '../proof-tower';
import { messagesFor } from '../i18n';

const { createLeanPanel } = vi.hoisted(() => ({ createLeanPanel: vi.fn() }));
vi.mock('../components/lean-panel', () => ({ createLeanPanel }));

const { mountProofTower, renderProofTower } = await import('./proof-tower-ui');

const makePanel = () => ({
  setCode: vi.fn(),
  getCode: vi.fn(() => ''),
  focus: vi.fn(),
  insert: vi.fn(),
});

describe('证明爬塔天梯视图', () => {
  beforeEach(() => {
    localStorage.clear();
    createLeanPanel.mockReset();
    createLeanPanel.mockReturnValue(makePanel());
  });

  it('SSG 静态渲染包含 6 层楼按钮与极简战场，英文版不含任何中文字符', () => {
    for (const locale of ['zh', 'en'] as const) {
      const html = renderProofTower(locale);
      expect(html).toContain('data-role="proof-tower"');
      for (const floor of TOWER_FLOORS) {
        expect(html).toContain(`data-tower-floor="${floor.id}"`);
      }
      expect(html).toContain('data-role="tower-goal"');
      expect(html).toContain('data-role="tower-verify-btn"');
    }

    const enHtml = renderProofTower('en');
    const doc = new DOMParser().parseFromString(enHtml, 'text/html');
    expect(doc.body.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('0 MB 出牌通关 1F、3F 反向破盾、5F 分裂怪与 6F 终局 Boss，支持撤销、重开与技能书解锁', () => {
    document.body.innerHTML = renderProofTower('zh');
    mountProofTower(document.body, 'zh');

    // 默认绝不主动加载 Lean 面板
    expect(createLeanPanel).not.toHaveBeenCalled();

    // 1F：先点错 intro_hp 被格挡，再点 rfl 一击秒杀
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="intro_hp"]')!.click();
    expect(document.body.querySelector('[data-role="tower-log"]')?.textContent).toContain('格挡');
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rfl"]')!.click();
    expect(document.body.querySelector<HTMLElement>('[data-role="tower-victory"]')?.hidden).toBe(
      false,
    );
    expect(document.body.querySelector('[data-role="tower-spellbook"]')?.textContent).toContain(
      'rfl',
    );

    // 切换到 3F：验证反向 rw [← h1] + 撤销 + 正向 rw [h2]
    document.body.querySelector<HTMLButtonElement>('[data-tower-floor="f3"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_rev_h1"]')!.click();
    expect(document.body.querySelector('[data-role="tower-goal"]')?.textContent).toBe('⊢ b = c');
    document.body.querySelector<HTMLButtonElement>('[data-role="tower-undo"]')!.click();
    expect(document.body.querySelector('[data-role="tower-goal"]')?.textContent).toBe('⊢ a = c');
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_rev_h1"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_h2"]')!.click();
    expect(document.body.querySelector<HTMLElement>('[data-role="tower-victory"]')?.hidden).toBe(
      false,
    );

    // 切换到 5F：劈裂双盾显示 queued subgoal，先打 exact_hp 被拒，按顺序击败
    document.body.querySelector<HTMLButtonElement>('[data-tower-floor="f5"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="constructor"]')!.click();
    expect(
      document.body.querySelector<HTMLElement>('[data-role="tower-queued-goals"]')?.hidden,
    ).toBe(false);
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="exact_hp"]')!.click();
    expect(document.body.querySelector('[data-role="tower-log"]')?.textContent).toContain('Q');
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="exact_hq"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="exact_hp"]')!.click();
    expect(document.body.querySelector<HTMLElement>('[data-role="tower-victory"]')?.hidden).toBe(
      false,
    );

    // 切换到 6F：展开函数后用 omega 清场，查看真代码并重置
    document.body.querySelector<HTMLButtonElement>('[data-tower-floor="f6"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="unfold_withdraw"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="omega"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-role="tower-toggle-code"]')!.click();
    expect(document.body.querySelector<HTMLElement>('[data-role="tower-code"]')?.hidden).toBe(
      false,
    );
    expect(document.body.querySelector('[data-role="tower-code"]')?.textContent).toContain(
      'unfold safeWithdraw',
    );
  });

  it('绝不静默启动 102MB 内核；只有通关并显式点击认证按钮后才按需唤醒真 Lean 并写入 verified', async () => {
    document.body.innerHTML = renderProofTower('zh');
    mountProofTower(document.body, 'zh');

    // 未通关时点认证只给出提示，不加载 Lean
    const verifyBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-role="tower-verify-btn"]',
    )!;
    verifyBtn.click();
    expect(createLeanPanel).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-role="tower-verify-status"]')?.textContent).toBe(
      messagesFor('zh').challenges.tower.verifyErrorStatus,
    );

    // 通关 1F 后点认证：触发按需加载（autoStart: false, startImmediately: true）
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rfl"]')!.click();
    verifyBtn.click();

    await vi.waitFor(() => expect(createLeanPanel).toHaveBeenCalledTimes(1));
    const [, options] = createLeanPanel.mock.calls[0] as [
      HTMLElement,
      {
        variant: string;
        code: string;
        autoStart: boolean;
        startImmediately: boolean;
        onDiagnostics: (d: Array<{ severity?: number }>) => void;
      },
    ];
    expect(options.variant).toBe('compact');
    expect(options.autoStart).toBe(false);
    expect(options.startImmediately).toBe(true);
    expect(options.code).toContain('theorem tower_f1');

    options.onDiagnostics([]);
    expect(new TowerProgressStore().snapshot().verified).toContain('f1');
    expect(
      document.body.querySelector<HTMLElement>('[data-role="tower-verified-badge"]')?.hidden,
    ).toBe(false);

    // 通关后切换到 2F 再点认证复用同一面板（只调用一次 createLeanPanel）
    document.body.querySelector<HTMLButtonElement>('[data-role="tower-next"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_hx"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_hy"]')!.click();
    verifyBtn.click();
    const panel = createLeanPanel.mock.results[0]!.value as ReturnType<typeof makePanel>;
    expect(panel.setCode).toHaveBeenCalledWith(expect.stringContaining('theorem tower_f2'), {
      focus: false,
    });
  });

  it('2F 步数进度与 5F 多子目标语义清晰拆分，支持复制纯文本战报与 pageshow 状态同步', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    document.body.innerHTML = renderProofTower('zh');
    mountProofTower(document.body, 'zh');

    // 2F 单目标：未破盾前还差 2 步，打完 rw [hx] 后明确减成还差 1 步。
    document.body.querySelector<HTMLButtonElement>('[data-tower-floor="f2"]')!.click();
    const shields = document.body.querySelector('[data-role="tower-shields"]')!;
    expect(shields.textContent).toBe(messagesFor('zh').challenges.tower.stepProgress(2));
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_hx"]')!.click();
    expect(shields.textContent).toBe(messagesFor('zh').challenges.tower.stepProgress(1));
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="rw_hy"]')!.click();

    // 胜利后可一键复制纯文本战报。
    document.body.querySelector<HTMLButtonElement>('[data-role="tower-copy-text"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain('/zh/challenges');
    expect(document.body.querySelector('[data-role="tower-copy-status"]')?.textContent).toBe(
      messagesFor('zh').challenges.tower.copyTextDone,
    );

    // 5F constructor 拆分出 2 个子目标时展示「剩余子目标 2」。
    document.body.querySelector<HTMLButtonElement>('[data-tower-floor="f5"]')!.click();
    document.body.querySelector<HTMLButtonElement>('[data-tower-card="constructor"]')!.click();
    expect(shields.textContent).toBe(messagesFor('zh').challenges.tower.shieldsLeft(2));

    // pageshow 返回列表页时同步全通横幅及高亮按钮。
    const store = new TowerProgressStore();
    for (const floor of TOWER_FLOORS) store.markCleared(floor.id, floor.parSteps);
    document.body.innerHTML = renderProofTower('zh');
    mountProofTower(document.body, 'zh');
    window.dispatchEvent(new Event('pageshow'));
    expect(
      document.body.querySelector<HTMLElement>('[data-role="tower-all-cleared-banner"]')?.hidden,
    ).toBe(false);
    expect(
      document.body.querySelector('[data-tower-floor="f6"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
