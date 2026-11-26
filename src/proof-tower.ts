/**
 * 「证明爬塔天梯 · Proof Tower」核心引擎（参考 NNG4 渐进解锁与刷怪爬塔反馈）。
 *
 * - 纯逻辑与类型定义，不访问 DOM（SSG 安全）；
 * - 每一张技能卡 1:1 对应真实可编译的 Lean 4.36 Init 战术；
 * - 0 MB 离线交互推进，同时支持用户显式触发真实 Lean 4.36 内核零错误验证。
 */
import type { LocalizedText } from './challenges';
import type { Locale } from './i18n';
import {
  TOWER_FLOORS,
  towerFloorById,
  type TowerCard,
  type TowerFloor,
  type TowerFloorId,
  type TowerGoalNode,
  type TowerMonsterId,
  type TowerState,
  type TowerTacticId,
} from './proof-tower-floors';

export {
  TOWER_FLOORS,
  towerFloorById,
  type TowerCard,
  type TowerFloor,
  type TowerFloorId,
  type TowerGoalNode,
  type TowerMonsterId,
  type TowerState,
  type TowerTacticId,
};

export type ArcadeRank = 'S' | 'A' | 'B';

export const computeChallengeRank = (codeChars: number, solutionChars: number): ArcadeRank => {
  const chars = Math.max(0, Math.floor(codeChars));
  const ref = Math.max(1, Math.floor(solutionChars));
  if (chars <= Math.max(40, Math.ceil(ref * 1.15))) return 'S';
  if (chars <= Math.ceil(ref * 1.65)) return 'A';
  return 'B';
};

export const formatElapsedMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const t = (zh: string, en: string): LocalizedText => ({ zh, en });

export const createInitialTowerState = (floorId: TowerFloorId): TowerState => {
  const floor = towerFloorById(floorId);
  return {
    floorId: floor.id,
    hypotheses: [...floor.initialHypotheses],
    goals: floor.initialGoals.map((goal) => ({ ...goal })),
    played: [],
    mistakes: 0,
    cleared: false,
    lastEvent: null,
  };
};

const failStep = (state: TowerState, message: LocalizedText): TowerState => ({
  ...state,
  mistakes: state.mistakes + 1,
  lastEvent: { ok: false, message },
});

const winStep = (
  state: TowerState,
  cardId: TowerTacticId,
  message: LocalizedText,
  hypotheses = state.hypotheses,
): TowerState => ({
  ...state,
  hypotheses,
  goals: [],
  played: [...state.played, cardId],
  cleared: true,
  lastEvent: { ok: true, message },
});

const advanceStep = (
  state: TowerState,
  cardId: TowerTacticId,
  goals: TowerGoalNode[],
  message: LocalizedText,
  hypotheses = state.hypotheses,
): TowerState => ({
  ...state,
  hypotheses,
  goals,
  played: [...state.played, cardId],
  cleared: goals.length === 0,
  lastEvent: { ok: true, message },
});

export const applyTowerCard = (state: TowerState, cardId: TowerTacticId): TowerState => {
  if (state.cleared || state.goals.length === 0) return state;

  const active = state.goals[0]!;
  const target = active.target;

  if (state.floorId === 'f1') {
    if (cardId === 'rfl') {
      return winStep(
        state,
        cardId,
        t(
          '💥 暴击！2 + 2 化简为 4，两边相等一击秒杀！',
          '💥 Direct hit! 2 + 2 simplifies to 4 — KO!',
        ),
      );
    }
    return failStep(
      state,
      t(
        '🛡️ 格挡：目标 2 + 2 = 4 不是「→」蕴含式，intro 没地方拆！',
        '🛡️ Blocked: 2 + 2 = 4 has no → for intro!',
      ),
    );
  }

  if (state.floorId === 'f2') {
    if (cardId === 'rw_hx') {
      if (!target.includes('x')) {
        return failStep(
          state,
          t(
            '🛡️ 打空：目标里已经没有 x 了，试试还没用上的 hy！',
            '🛡️ Missed: x is already replaced — try hy!',
          ),
        );
      }
      const nextTarget = target.replace(/\bx\b/, '3');
      if (nextTarget === '3 + 2 = 5') {
        return winStep(
          state,
          cardId,
          t(
            '💥 连击终结！3 + 2 = 5 由 rw 自动合拢，哥布林倒下！',
            '💥 Combo KO! 3 + 2 = 5 closes automatically!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: nextTarget }],
        t(
          '⚔️ 命中！x 已被替换为 3，哥布林破去半盾！',
          '⚔️ Hit! Replaced x with 3 — one variable left!',
        ),
      );
    }
    if (cardId === 'rw_hy') {
      if (!target.includes('y')) {
        return failStep(
          state,
          t(
            '🛡️ 打空：目标里已经没有 y 了，试试还没用上的 hx！',
            '🛡️ Missed: y is already replaced — try hx!',
          ),
        );
      }
      const nextTarget = target.replace(/\by\b/, '2');
      if (nextTarget === '3 + 2 = 5') {
        return winStep(
          state,
          cardId,
          t(
            '💥 连击终结！3 + 2 = 5 由 rw 自动合拢，哥布林倒下！',
            '💥 Combo KO! 3 + 2 = 5 closes automatically!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: nextTarget }],
        t(
          '⚔️ 命中！y 已被替换为 2，哥布林破去半盾！',
          '⚔️ Hit! Replaced y with 2 — one variable left!',
        ),
      );
    }
    return failStep(
      state,
      t(
        '🛡️ 格挡：目标里还留着未知数，先用 rw 把 hx / hy 代进去！',
        '🛡️ Blocked: unknown variables remain — rewrite them first!',
      ),
    );
  }

  if (state.floorId === 'f3') {
    if (cardId === 'rw_rev_h1') {
      if (!target.includes('a')) {
        return failStep(
          state,
          t('🛡️ 打空：当前目标里已经没有 a！', '🛡️ Missed: a is no longer in the goal!'),
        );
      }
      const nextTarget = target.replace(/\ba\b/, 'b');
      if (nextTarget === 'b = b') {
        return winStep(
          state,
          cardId,
          t(
            '💥 破盾秒杀！反向代换直接凑出 b = b！',
            '💥 Shield shattered! Reverse rewrite yields b = b!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: nextTarget }],
        t(
          '⚔️ 反向命中！a 变成 b，目标变为 b = c，马上用 h2 收尾！',
          '⚔️ Reverse hit! a turned into b — finish with rw [h2]!',
        ),
      );
    }
    if (cardId === 'rw_rev_h2') {
      if (!target.includes('c')) {
        return failStep(
          state,
          t('🛡️ 打空：当前目标里已经没有 c！', '🛡️ Missed: c is no longer in the goal!'),
        );
      }
      const nextTarget = target.replace(/\bc\b/, 'b');
      if (nextTarget === 'b = b') {
        return winStep(
          state,
          cardId,
          t(
            '💥 破盾秒杀！反向代换凑出 b = b！',
            '💥 Shield shattered! Reverse rewrite yields b = b!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: nextTarget }],
        t(
          '⚔️ 反向命中！c 变成 b，再用 ← h1 把 a 也变成 b！',
          '⚔️ Reverse hit! c turned into b — finish with rw [← h1]!',
        ),
      );
    }
    if (cardId === 'rw_h2') {
      if (!target.includes('b')) {
        return failStep(
          state,
          t(
            '🛡️ 格挡！目标 a = c 里没有 b，正向 rw [h2] 找不到入口，试试 ← 反向代换！',
            '🛡️ Missed! No b in a = c for forward rw [h2] — try reverse ←!',
          ),
        );
      }
      const nextTarget = target.replace(/\bb\b/, 'c');
      if (nextTarget === 'c = c') {
        return winStep(
          state,
          cardId,
          t(
            '💥 完美桥接！b 换成 c 后左右相等，魔像碎裂！',
            '💥 Bridge complete! c = c closes automatically!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: nextTarget }],
        t('⚔️ 命中：b 替换为 c。', '⚔️ Hit: replaced b with c.'),
      );
    }
    if (cardId === 'rw_h1') {
      if (!target.includes('b')) {
        return failStep(
          state,
          t(
            '🛡️ 格挡！目标 a = c 里没有 b，正向 rw [h1] 打空了！',
            '🛡️ Missed! No b in a = c for forward rw [h1]!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: target.replace(/\bb\b/, 'a') }],
        t('⚔️ 命中：b 替换为 a。', '⚔️ Hit: replaced b with a.'),
      );
    }
  }

  if (state.floorId === 'f4') {
    if (cardId === 'intro_hp') {
      if (target !== 'P → R') {
        return failStep(
          state,
          t(
            '🛡️ 已经剥开过前提 P 了，接下来该用 apply 倒推！',
            '🛡️ P is already in your pack—use apply to backchain!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: 'R' }],
        t(
          '⚔️ 收入囊中！假设 hp : P 已进背包，目标缩成 R！',
          '⚔️ Gained hp : P! Goal shrinks to R.',
        ),
        [...state.hypotheses, 'hp : P'],
      );
    }
    if (cardId === 'apply_hqr') {
      if (target !== 'R') {
        return failStep(
          state,
          t(
            '🛡️ hqr 的结论是 R，当前目标不是 R（先把外层 P → 拿进来或检查当前目标）！',
            '🛡️ hqr proves R, which does not match the current goal!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: 'Q' }],
        t('⚔️ 倒推成功！要证 R 先证 Q！', '⚔️ Backchained hqr! Now prove Q.'),
      );
    }
    if (cardId === 'apply_hpq') {
      if (target !== 'Q') {
        return failStep(
          state,
          t(
            '🛡️ hpq 的结论是 Q，当前还够不到 Q（先用 apply hqr 把 R 变成 Q）！',
            '🛡️ hpq targets Q—backchain from R using hqr first!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: 'P' }],
        t(
          '⚔️ 逼近终局！目标已经缩成 P，亮出背包里的 hp！',
          '⚔️ One hit left! Goal is P — finish with exact hp!',
        ),
      );
    }
    if (cardId === 'exact_hp') {
      if (target === 'P' && state.hypotheses.includes('hp : P')) {
        return winStep(
          state,
          cardId,
          t(
            '💥 推理链闭合！hp 精准穿透契约守卫！',
            '💥 Chain closed! exact hp defeats the Sentinel!',
          ),
        );
      }
      return failStep(
        state,
        t(
          '🛡️ 目标还不是 P（或背包还没拿到 hp : P），先完成前面步骤！',
          '🛡️ Goal is not P yet (or hp is not in context)!',
        ),
      );
    }
  }

  if (state.floorId === 'f5') {
    if (cardId === 'constructor') {
      if (target !== 'Q ∧ P') {
        return failStep(
          state,
          t(
            '🛡️ 护盾已经劈开啦，直接击破剩余小盾牌！',
            '🛡️ Already split — strike the active subgoal!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [
          { id: 'left', label: t('① 左护盾（先破）', '1. Left Shield (active)'), target: 'Q' },
          { id: 'right', label: t('② 右护盾（待机）', '2. Right Shield (queued)'), target: 'P' },
        ],
        t(
          '⚔️ 双盾劈裂！Hydra 分裂成左盾 Q 与右盾 P，先击破左盾 Q！',
          '⚔️ Split! Two subgoals spawned — clear Q first!',
        ),
      );
    }
    if (cardId === 'exact_hq') {
      if (target === 'Q') {
        const rest = state.goals.slice(1);
        return rest.length === 0
          ? winStep(state, cardId, t('💥 全部护盾清零！', '💥 All shields shattered!'))
          : advanceStep(
              state,
              cardId,
              rest,
              t(
                '⚔️ 左盾 Q 击碎！自动锁定最后一面右盾 P！',
                '⚔️ Shield Q shattered! Switching lock to P!',
              ),
            );
      }
      return failStep(
        state,
        t(
          '🛡️ 格挡！先用 constructor 劈裂双盾（或当前锁定的不是 Q）！',
          '🛡️ Blocked! Split Q ∧ P first or match the active target!',
        ),
      );
    }
    if (cardId === 'exact_hp') {
      if (target === 'P') {
        const rest = state.goals.slice(1);
        return rest.length === 0
          ? winStep(
              state,
              cardId,
              t(
                '💥 右盾 P 碎裂！双盾分裂怪彻底通关！',
                '💥 Shield P shattered! Twin-Shield Hydra defeated!',
              ),
            )
          : advanceStep(state, cardId, rest, t('⚔️ P 击破！', '⚔️ P cleared!'));
      }
      return failStep(
        state,
        target === 'Q'
          ? t(
              '🛡️ 打歪了！当前锁定的是左盾 Q，hp 只能破 P！',
              '🛡️ Wrong shield! Active goal is Q, not P!',
            )
          : t(
              '🛡️ 先用 constructor 把 Q ∧ P 劈成两个子目标！',
              '🛡️ Split Q ∧ P with constructor first!',
            ),
      );
    }
  }

  if (state.floorId === 'f6') {
    const unfolded = state.played.includes('unfold_withdraw');
    if (cardId === 'unfold_withdraw') {
      if (unfolded) {
        return failStep(
          state,
          t(
            '🛡️ 已经展开过 safeWithdraw 啦，直接上算术终结技！',
            '🛡️ Already unfolded — finish with omega!',
          ),
        );
      }
      return advanceStep(
        state,
        cardId,
        [{ ...active, target: '(balance - amount) + amount = balance' }],
        t(
          '⚔️ 剥开外壳！露出 (balance - amount) + amount = balance，快上核弹 omega！',
          '⚔️ Unfolded! Launch omega or Nat.sub_add_cancel h!',
        ),
      );
    }
    if (cardId === 'omega' || cardId === 'exact_sub_add_cancel') {
      if (!unfolded) {
        return failStep(
          state,
          t(
            '🛡️ 被函数外壳挡住了！omega 看不穿 safeWithdraw 的定义，先出 unfold safeWithdraw！',
            '🛡️ Blocked by wrapper! Unfold safeWithdraw before finishing!',
          ),
        );
      }
      return winStep(
        state,
        cardId,
        t(
          '💥 终极 Boss 击破！钱包余额守恒已在数学上永久证死！',
          '💥 Final Boss KO! Wallet conservation is mathematically proved!',
        ),
      );
    }
    if (cardId === 'rfl') {
      return failStep(
        state,
        t(
          '🛡️ rfl 破不了带条件 h 的减法消去，展开后用 omega 或 Nat.sub_add_cancel h！',
          '🛡️ rfl cannot use hypothesis h — unfold and use omega!',
        ),
      );
    }
  }

  return failStep(state, t('🛡️ 这张牌当前不适用。', '🛡️ This tactic does not apply right now.'));
};

export const undoTowerStep = (state: TowerState): TowerState => {
  if (state.played.length === 0) return createInitialTowerState(state.floorId);
  let next = createInitialTowerState(state.floorId);
  for (const id of state.played.slice(0, -1)) {
    next = applyTowerCard(next, id);
  }
  return { ...next, mistakes: state.mistakes };
};

export const buildTowerLeanCode = (
  floor: TowerFloor,
  played: readonly TowerTacticId[],
  locale: Locale,
  cleared = false,
): string => {
  const preamble = floor.preambleCode ? `${floor.preambleCode}\n` : '';
  const comment =
    locale === 'zh'
      ? `-- 证明爬塔 ${floor.level}F：${floor.monsterName.zh}`
      : `-- Proof Tower ${floor.level}F: ${floor.monsterName.en}`;

  if (played.length === 0) {
    return `${preamble}${comment}\n${floor.headerCode}\n  sorry\n`;
  }

  const cardById = new Map(floor.deck.map((c) => [c.id, c.code]));
  const lines: string[] = [];

  if (floor.id === 'f5' && played[0] === 'constructor') {
    lines.push('  constructor');
    const subMoves = played.slice(1);
    for (const id of subMoves) {
      const code = cardById.get(id);
      if (code) lines.push(`  · ${code}`);
    }
    if (subMoves.length < 2) {
      lines.push('  · sorry');
      if (subMoves.length === 0) lines.push('  · sorry');
    }
  } else {
    for (const id of played) {
      const code = cardById.get(id);
      if (code) lines.push(`  ${code}`);
    }
    if (!cleared) lines.push('  sorry');
  }

  return `${preamble}${comment}\n${floor.headerCode}\n${lines.join('\n')}\n`;
};

export const towerLadderRank = (
  clearedCount: number,
  locale: Locale,
): { tier: string; nextAt: number | null } => {
  if (locale === 'zh') {
    if (clearedCount >= 6) return { tier: '👑 形式化大师', nextAt: null };
    if (clearedCount >= 5) return { tier: '🥇 黄金领主', nextAt: 6 };
    if (clearedCount >= 3) return { tier: '🥈 白银骑士', nextAt: 5 };
    if (clearedCount >= 1) return { tier: '🥉 青铜术士', nextAt: 3 };
    return { tier: '🌱 见习学徒', nextAt: 1 };
  }
  if (clearedCount >= 6) return { tier: '👑 Formal Master', nextAt: null };
  if (clearedCount >= 5) return { tier: '🥇 Gold Lord', nextAt: 6 };
  if (clearedCount >= 3) return { tier: '🥈 Silver Knight', nextAt: 5 };
  if (clearedCount >= 1) return { tier: '🥉 Bronze Tactician', nextAt: 3 };
  return { tier: '🌱 Apprentice', nextAt: 1 };
};

export const TOWER_PROGRESS_KEY = 'lean-init-ide:proof-tower:v1';

export type TowerProgressData = {
  version: 1;
  cleared: TowerFloorId[];
  verified: TowerFloorId[];
  bestSteps: Partial<Record<TowerFloorId, number>>;
};

const VALID_IDS = new Set<string>(TOWER_FLOORS.map((f) => f.id));
const isFloorId = (value: unknown): value is TowerFloorId =>
  typeof value === 'string' && VALID_IDS.has(value);

const emptyProgress = (): TowerProgressData => ({
  version: 1,
  cleared: [],
  verified: [],
  bestSteps: {},
});

export class TowerProgressStore {
  snapshot(): TowerProgressData {
    try {
      const raw = localStorage.getItem(TOWER_PROGRESS_KEY);
      if (!raw) return emptyProgress();
      const parsed = JSON.parse(raw) as Partial<TowerProgressData>;
      if (!parsed || typeof parsed !== 'object') return emptyProgress();
      const cleared = Array.isArray(parsed.cleared)
        ? [...new Set(parsed.cleared.filter(isFloorId))]
        : [];
      const verified = Array.isArray(parsed.verified)
        ? [...new Set(parsed.verified.filter(isFloorId))]
        : [];
      const bestSteps: Partial<Record<TowerFloorId, number>> = {};
      if (parsed.bestSteps && typeof parsed.bestSteps === 'object') {
        for (const [k, v] of Object.entries(parsed.bestSteps)) {
          if (isFloorId(k) && typeof v === 'number' && Number.isFinite(v) && v >= 1) {
            bestSteps[k] = Math.floor(v);
          }
        }
      }
      return { version: 1, cleared, verified, bestSteps };
    } catch {
      return emptyProgress();
    }
  }

  private save(data: TowerProgressData): void {
    try {
      localStorage.setItem(TOWER_PROGRESS_KEY, JSON.stringify(data));
    } catch {
      // 隐私模式下忽略写入失败。
    }
  }

  markCleared(floorId: TowerFloorId, steps: number): TowerProgressData {
    const data = this.snapshot();
    if (!data.cleared.includes(floorId)) data.cleared.push(floorId);
    const prev = data.bestSteps[floorId];
    const cleanSteps = Math.max(1, Math.floor(steps));
    data.bestSteps[floorId] = prev === undefined ? cleanSteps : Math.min(prev, cleanSteps);
    this.save(data);
    return data;
  }

  markVerified(floorId: TowerFloorId): TowerProgressData {
    const data = this.snapshot();
    if (!data.cleared.includes(floorId)) data.cleared.push(floorId);
    if (!data.verified.includes(floorId)) data.verified.push(floorId);
    this.save(data);
    return data;
  }

  firstPendingFloor(): TowerFloorId {
    const data = this.snapshot();
    const pending = TOWER_FLOORS.find((floor) => !data.cleared.includes(floor.id));
    return pending ? pending.id : TOWER_FLOORS[TOWER_FLOORS.length - 1]!.id;
  }

  unlockedCodes(): string[] {
    const clearedSet = new Set(this.snapshot().cleared);
    return TOWER_FLOORS.filter((f) => clearedSet.has(f.id)).map((f) => f.unlocksCode);
  }
}
