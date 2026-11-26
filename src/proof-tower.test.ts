import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isExerciseSolved } from './exercise';
import {
  applyTowerCard,
  buildTowerLeanCode,
  computeChallengeRank,
  createInitialTowerState,
  formatElapsedMs,
  TOWER_FLOORS,
  TOWER_PROGRESS_KEY,
  towerFloorById,
  towerLadderRank,
  TowerProgressStore,
  undoTowerStep,
  type TowerFloorId,
  type TowerTacticId,
} from './proof-tower';

const playSequence = (floorId: TowerFloorId, cards: readonly TowerTacticId[]) => {
  let state = createInitialTowerState(floorId);
  for (const card of cards) {
    state = applyTowerCard(state, card);
  }
  return state;
};

describe('证明爬塔天梯核心逻辑', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('6 层核心塔覆盖完整 NNG4 递进路径，且每层通关代码严格通过 isExerciseSolved', () => {
    const winningRuns: Record<TowerFloorId, TowerTacticId[]> = {
      f1: ['rfl'],
      f2: ['rw_hx', 'rw_hy'],
      f3: ['rw_rev_h1', 'rw_h2'],
      f4: ['intro_hp', 'apply_hqr', 'apply_hpq', 'exact_hp'],
      f5: ['constructor', 'exact_hq', 'exact_hp'],
      f6: ['unfold_withdraw', 'omega'],
    };

    for (const floor of TOWER_FLOORS) {
      const result = playSequence(floor.id, winningRuns[floor.id]);
      expect(result.cleared, floor.id).toBe(true);
      expect(result.goals, floor.id).toHaveLength(0);
      expect(result.mistakes, floor.id).toBe(0);

      for (const locale of ['zh', 'en'] as const) {
        const leanCode = buildTowerLeanCode(floor, result.played, locale, true);
        expect(leanCode, `${floor.id}:${locale}`).not.toMatch(/\bsorry\b/);
        expect(isExerciseSolved(floor.starterCode, leanCode, []), `${floor.id}:${locale}`).toBe(
          true,
        );
      }
      expect(buildTowerLeanCode(floor, result.played, 'en', true)).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('支持多条合法出牌顺序（2F 交换代换、3F 右侧逆推、6F 标准库引理）', () => {
    const f2Alt = playSequence('f2', ['rw_hy', 'rw_hx']);
    expect(f2Alt.cleared).toBe(true);

    const f3Alt = playSequence('f3', ['rw_rev_h2', 'rw_rev_h1']);
    expect(f3Alt.cleared).toBe(true);

    const f6Alt = playSequence('f6', ['unfold_withdraw', 'exact_sub_add_cancel']);
    expect(f6Alt.cleared).toBe(true);
    expect(
      isExerciseSolved(
        towerFloorById('f6').starterCode,
        buildTowerLeanCode(towerFloorById('f6'), f6Alt.played, 'en', true),
        [],
      ),
    ).toBe(true);
  });

  it('错误出牌会被精准格挡并累计失误，撤销可无损回到上一步', () => {
    // 1F 错误出 intro
    const s1 = applyTowerCard(createInitialTowerState('f1'), 'intro_hp');
    expect(s1.cleared).toBe(false);
    expect(s1.mistakes).toBe(1);
    expect(s1.lastEvent?.ok).toBe(false);

    // 3F 正向代换打空，反向后再撤销保留失误计数
    let s3 = applyTowerCard(createInitialTowerState('f3'), 'rw_h1');
    expect(s3.mistakes).toBe(1);
    s3 = applyTowerCard(s3, 'rw_rev_h1');
    expect(s3.goals[0]!.target).toBe('b = c');
    s3 = undoTowerStep(s3);
    expect(s3.goals[0]!.target).toBe('a = c');
    expect(s3.mistakes).toBe(1);

    // 5F 劈裂前出 exact_hp 被挡，劈裂后先出 exact_hp 同样被挡（先破 Q 再破 P）
    let s5 = applyTowerCard(createInitialTowerState('f5'), 'exact_hp');
    expect(s5.mistakes).toBe(1);
    s5 = applyTowerCard(s5, 'constructor');
    expect(s5.goals.map((g) => g.target)).toEqual(['Q', 'P']);
    const partialCode = buildTowerLeanCode(towerFloorById('f5'), s5.played, 'zh', false);
    expect(partialCode).toContain('· sorry');
    s5 = applyTowerCard(s5, 'exact_hp');
    expect(s5.mistakes).toBe(2);
    expect(s5.lastEvent?.message.zh).toContain('Q');

    // 6F 未展开就打 omega 被挡
    const s6 = applyTowerCard(createInitialTowerState('f6'), 'omega');
    expect(s6.mistakes).toBe(1);
    expect(s6.cleared).toBe(false);
  });

  it('未通关前生成的 Lean 代码保留 sorry 占位，保证语法合法', () => {
    const f4 = towerFloorById('f4');
    expect(buildTowerLeanCode(f4, [], 'en', false)).toContain('sorry');
    expect(buildTowerLeanCode(f4, ['intro_hp'], 'zh', false)).toContain('intro hp\n  sorry');
  });

  it('天梯段位、战绩持久化与评分计时工具稳定工作', () => {
    expect(computeChallengeRank(50, 50)).toBe('S');
    expect(computeChallengeRank(130, 100)).toBe('A');
    expect(computeChallengeRank(220, 100)).toBe('B');
    expect(formatElapsedMs(-100)).toBe('00:00');
    expect(formatElapsedMs(65_000)).toBe('01:05');

    expect(towerLadderRank(0, 'zh').nextAt).toBe(1);
    expect(towerLadderRank(6, 'en')).toEqual({ tier: '👑 Formal Master', nextAt: null });

    const store = new TowerProgressStore();
    expect(store.firstPendingFloor()).toBe('f1');
    store.markCleared('f1', 1);
    store.markVerified('f1');
    store.markCleared('f2', 3);
    store.markCleared('f2', 2);
    expect(store.firstPendingFloor()).toBe('f3');
    expect(store.unlockedCodes()).toEqual(['rfl', 'rw [h]']);
    expect(store.snapshot().bestSteps.f2).toBe(2);
    expect(store.snapshot().verified).toEqual(['f1']);

    localStorage.setItem(TOWER_PROGRESS_KEY, 'not-json');
    expect(store.snapshot().cleared).toEqual([]);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => store.markCleared('f1', 1)).not.toThrow();
  });
});
