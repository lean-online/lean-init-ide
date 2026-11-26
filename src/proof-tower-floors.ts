/**
 * 证明爬塔天梯 6 层核心关卡数据（类型与关卡牌组）。
 */
import type { LocalizedText } from './challenges';

export type TowerFloorId = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6';

export type TowerMonsterId = 'slime' | 'goblin' | 'golem' | 'sentinel' | 'hydra' | 'king';

export type TowerTacticId =
  | 'rfl'
  | 'rw_hx'
  | 'rw_hy'
  | 'rw_h1'
  | 'rw_h2'
  | 'rw_rev_h1'
  | 'rw_rev_h2'
  | 'exact_h2'
  | 'intro_hp'
  | 'apply_hqr'
  | 'apply_hpq'
  | 'exact_hp'
  | 'constructor'
  | 'exact_hq'
  | 'unfold_withdraw'
  | 'omega'
  | 'exact_sub_add_cancel';

export type TowerCard = {
  id: TowerTacticId;
  code: string;
  label: LocalizedText;
  hint: LocalizedText;
  kind: 'finish' | 'rewrite' | 'split' | 'logic' | 'auto';
};

export type TowerGoalNode = {
  id: string;
  label: LocalizedText;
  target: string;
};

export type TowerState = {
  floorId: TowerFloorId;
  hypotheses: string[];
  goals: TowerGoalNode[];
  played: TowerTacticId[];
  mistakes: number;
  cleared: boolean;
  lastEvent: { ok: boolean; message: LocalizedText } | null;
};

export type TowerFloor = {
  id: TowerFloorId;
  level: number;
  monsterId: TowerMonsterId;
  monsterName: LocalizedText;
  title: LocalizedText;
  premise: LocalizedText;
  preambleCode?: string;
  headerCode: string;
  starterCode: string;
  initialHypotheses: string[];
  initialGoals: TowerGoalNode[];
  deck: readonly TowerCard[];
  parSteps: number;
  unlocks: LocalizedText;
  unlocksCode: string;
};

const t = (zh: string, en: string): LocalizedText => ({ zh, en });

const card = (
  id: TowerTacticId,
  code: string,
  kind: TowerCard['kind'],
  label: LocalizedText,
  hint: LocalizedText,
): TowerCard => ({ id, code, kind, label, hint });

export const TOWER_FLOORS: readonly TowerFloor[] = [
  {
    id: 'f1',
    level: 1,
    monsterId: 'slime',
    monsterName: t('镜像史莱姆', 'Mirror Slime'),
    title: t('1F · 镜像秒杀：rfl', '1F · Instant Mirror: rfl'),
    premise: t(
      '第一层热身！史莱姆左右两边本来就相等（2 + 2 = 4），打出一张 rfl 直接一击秒杀。',
      'Warmup floor! Both sides (2 + 2 and 4) are already equal—play rfl for an instant KO.',
    ),
    headerCode: 'theorem tower_f1 : 2 + 2 = 4 := by',
    starterCode: 'theorem tower_f1 : 2 + 2 = 4 := by\n  sorry\n',
    initialHypotheses: [],
    initialGoals: [{ id: 'main', label: t('主目标', 'Main Goal'), target: '2 + 2 = 4' }],
    deck: [
      card(
        'rfl',
        'rfl',
        'finish',
        t('两边已相等，直接收尾', 'Both sides match: close goal'),
        t(
          '自反性公理：化简后两边一模一样时一刀秒。',
          'Reflexivity: closes when both sides simplify to the same term.',
        ),
      ),
      card(
        'intro_hp',
        'intro hp',
        'logic',
        t('拆出「如果…」的前提', 'Unpack an implication premise'),
        t('只有目标里有 → 才能拆出新假设。', 'Only applies when the goal is an implication (→).'),
      ),
    ],
    parSteps: 1,
    unlocks: t('rfl · 镜像斩', 'rfl · Reflexive Strike'),
    unlocksCode: 'rfl',
  },
  {
    id: 'f2',
    level: 2,
    monsterId: 'goblin',
    monsterName: t('替身哥布林', 'Shadow Goblin'),
    title: t('2F · 武器代换：rw [h]', '2F · Weapon Rewrite: rw [h]'),
    premise: t(
      '哥布林躲在未知数 x 与 y 背后！你手里有 hx : x = 3 和 hy : y = 2 两张代换卷轴，把它们全替换进去就能让 3 + 2 = 5 自动闭合。',
      'The goblin hides behind x and y! Use hx : x = 3 and hy : y = 2 to rewrite both—Lean closes 3 + 2 = 5 automatically on the final rewrite.',
    ),
    headerCode: 'theorem tower_f2 (x y : Nat) (hx : x = 3) (hy : y = 2) : x + y = 5 := by',
    starterCode:
      'theorem tower_f2 (x y : Nat) (hx : x = 3) (hy : y = 2) : x + y = 5 := by\n  sorry\n',
    initialHypotheses: ['hx : x = 3', 'hy : y = 2'],
    initialGoals: [{ id: 'main', label: t('主目标', 'Main Goal'), target: 'x + y = 5' }],
    deck: [
      card(
        'rw_hx',
        'rw [hx]',
        'rewrite',
        t('把 x 替换成 3', 'Replace x with 3'),
        t('用等式 hx 把目标里的 x 换成已知常数 3。', 'Rewrites x using hx : x = 3.'),
      ),
      card(
        'rw_hy',
        'rw [hy]',
        'rewrite',
        t('把 y 替换成 2', 'Replace y with 2'),
        t('用等式 hy 把目标里的 y 换成已知常数 2。', 'Rewrites y using hy : y = 2.'),
      ),
      card(
        'rfl',
        'rfl',
        'finish',
        t('尝试直接收尾', 'Try closing directly'),
        t('未知数还没替换完时，两边并不定义相等。', 'Fails while unrewritten variables remain.'),
      ),
    ],
    parSteps: 2,
    unlocks: t('rw [h] · 替身代换', 'rw [h] · Equality Rewrite'),
    unlocksCode: 'rw [h]',
  },
  {
    id: 'f3',
    level: 3,
    monsterId: 'golem',
    monsterName: t('反转魔像', 'Reverse Golem'),
    title: t('3F · 反向破盾：rw [← h]', '3F · Reverse Shield: rw [← h]'),
    premise: t(
      '目标是 a = c，可手里的盾牌是 b = a 和 b = c！目标里根本没有 b，正向 rw 会打空——必须使用「反向代换 ←」把 a 变成 b！',
      'Goal is a = c, but you hold b = a and b = c. Since b is absent from the goal, forward rw misses—flip a rule with ← first!',
    ),
    headerCode: 'theorem tower_f3 (a b c : Nat) (h1 : b = a) (h2 : b = c) : a = c := by',
    starterCode:
      'theorem tower_f3 (a b c : Nat) (h1 : b = a) (h2 : b = c) : a = c := by\n  sorry\n',
    initialHypotheses: ['h1 : b = a', 'h2 : b = c'],
    initialGoals: [{ id: 'main', label: t('主目标', 'Main Goal'), target: 'a = c' }],
    deck: [
      card(
        'rw_rev_h1',
        'rw [← h1]',
        'rewrite',
        t('反向代换：把 a 换回 b', 'Reverse: rewrite a back to b'),
        t('← 把等式 h1 右边的 a 替换成左边的 b。', 'Arrow ← flips b = a to replace a with b.'),
      ),
      card(
        'rw_h2',
        'rw [h2]',
        'rewrite',
        t('正向代换：把 b 换成 c', 'Forward: replace b with c'),
        t('把目标里的 b 替换成 c。', 'Rewrites b into c using h2 : b = c.'),
      ),
      card(
        'rw_rev_h2',
        'rw [← h2]',
        'rewrite',
        t('反向代换：把 c 换回 b', 'Reverse: rewrite c back to b'),
        t('← 把等式 h2 右边的 c 替换成左边的 b。', 'Arrow ← flips b = c to replace c with b.'),
      ),
      card(
        'rw_h1',
        'rw [h1]',
        'rewrite',
        t('正向代换：把 b 换成 a', 'Forward: replace b with a'),
        t('注意：目标 a = c 里当前根本没有 b！', 'Watch out: b is not in a = c yet!'),
      ),
    ],
    parSteps: 2,
    unlocks: t('rw [← h] · 镜像逆转', 'rw [← h] · Reverse Rewrite'),
    unlocksCode: 'rw [← h]',
  },
  {
    id: 'f4',
    level: 4,
    monsterId: 'sentinel',
    monsterName: t('契约守卫', 'Contract Sentinel'),
    title: t('4F · 推理连击：intro + apply', '4F · Logic Chain: intro + apply'),
    premise: t(
      '遇到「如果 P 那么 R」（P → R）了！先用 intro 把假设 P 收入背包，再用 apply 沿推理链条一步步倒推到已知的 hp。',
      'Facing an implication P → R! Move P into your pack with intro hp, then chain backwards with apply until exact hp finishes it.',
    ),
    headerCode: 'theorem tower_f4 (P Q R : Prop) (hpq : P → Q) (hqr : Q → R) : P → R := by',
    starterCode:
      'theorem tower_f4 (P Q R : Prop) (hpq : P → Q) (hqr : Q → R) : P → R := by\n  sorry\n',
    initialHypotheses: ['hpq : P → Q', 'hqr : Q → R'],
    initialGoals: [{ id: 'main', label: t('主目标', 'Main Goal'), target: 'P → R' }],
    deck: [
      card(
        'intro_hp',
        'intro hp',
        'logic',
        t('收下前提 P 到背包', 'Assume P as hp'),
        t('剥开 P → R，把 P 变成已知假设 hp : P。', 'Turns P → R into goal R with hp : P.'),
      ),
      card(
        'apply_hqr',
        'apply hqr',
        'logic',
        t('倒推：要证 R 先证 Q', 'Backchain hqr: R ← Q'),
        t('既然 Q → R，只要改证 Q 就行。', 'Matches conclusion R and reduces goal to Q.'),
      ),
      card(
        'apply_hpq',
        'apply hpq',
        'logic',
        t('倒推：要证 Q 先证 P', 'Backchain hpq: Q ← P'),
        t('既然 P → Q，只要改证 P 就行。', 'Matches conclusion Q and reduces goal to P.'),
      ),
      card(
        'exact_hp',
        'exact hp',
        'finish',
        t('交出背包里的 hp', 'Present hp from pack'),
        t(
          '当目标就是 P 且背包已有 hp : P 时一击必杀。',
          'Closes goal P when hp : P is in context.',
        ),
      ),
    ],
    parSteps: 4,
    unlocks: t('intro / apply · 推理锁链', 'intro / apply · Logic Chain'),
    unlocksCode: 'intro / apply',
  },
  {
    id: 'f5',
    level: 5,
    monsterId: 'hydra',
    monsterName: t('双盾分裂怪', 'Twin-Shield Hydra'),
    title: t('5F · 劈裂双盾：constructor', '5F · Split Twin Shields: constructor'),
    premise: t(
      'Boss 举起了「且（∧）」双护盾 Q ∧ P！打出 constructor 把它当场劈成两只小怪（先破 Q、再破 P），顺序错一招就会被反伤格挡！',
      'The Hydra holds a ∧ twin shield (Q ∧ P)! Split it into two subgoals with constructor, then defeat Q first and P second.',
    ),
    headerCode: 'theorem tower_f5 (P Q : Prop) (hp : P) (hq : Q) : Q ∧ P := by',
    starterCode: 'theorem tower_f5 (P Q : Prop) (hp : P) (hq : Q) : Q ∧ P := by\n  sorry\n',
    initialHypotheses: ['hp : P', 'hq : Q'],
    initialGoals: [{ id: 'main', label: t('双盾合体', 'Twin Shield'), target: 'Q ∧ P' }],
    deck: [
      card(
        'constructor',
        'constructor',
        'split',
        t('劈开 Q ∧ P 成两个子目标', 'Split Q ∧ P into 2 shields'),
        t('合取 ∧ 需要左右两边分别攻破。', 'Splits ∧ goal into left (Q) then right (P).'),
      ),
      card(
        'exact_hq',
        'exact hq',
        'finish',
        t('交出 hq 击碎目标 Q', 'Strike goal Q with hq'),
        t('只能用来命中当前锁定的 Q 目标。', 'Closes the active goal when it is Q.'),
      ),
      card(
        'exact_hp',
        'exact hp',
        'finish',
        t('交出 hp 击碎目标 P', 'Strike goal P with hp'),
        t('只能用来命中当前锁定的 P 目标。', 'Closes the active goal when it is P.'),
      ),
    ],
    parSteps: 3,
    unlocks: t('constructor · 分裂斩', 'constructor · Dual Split'),
    unlocksCode: 'constructor',
  },
  {
    id: 'f6',
    level: 6,
    monsterId: 'king',
    monsterName: t('钱包印钞王', 'Wallet Exploit King'),
    title: t('6F · 终局算术核弹：unfold + omega', '6F · Boss Finisher: unfold + omega'),
    premise: t(
      '终极 Boss！safeWithdraw 把扣款函数包了一层。先用 unfold 剥开函数定义露出真面目，再祭出线性算术核弹 omega（或精确引理）一发清场！',
      'Final Boss! safeWithdraw wraps subtraction behind a helper. Peel it open with unfold safeWithdraw, then detonate omega!',
    ),
    preambleCode: 'def safeWithdraw (balance amount : Nat) : Nat :=\n  balance - amount\n',
    headerCode:
      'theorem tower_f6 (balance amount : Nat) (h : amount ≤ balance) :\n    safeWithdraw balance amount + amount = balance := by',
    starterCode:
      'def safeWithdraw (balance amount : Nat) : Nat :=\n  balance - amount\n\ntheorem tower_f6 (balance amount : Nat) (h : amount ≤ balance) :\n    safeWithdraw balance amount + amount = balance := by\n  sorry\n',
    initialHypotheses: ['safeWithdraw := balance - amount', 'h : amount ≤ balance'],
    initialGoals: [
      {
        id: 'main',
        label: t('守恒契约', 'Balance Invariant'),
        target: 'safeWithdraw balance amount + amount = balance',
      },
    ],
    deck: [
      card(
        'unfold_withdraw',
        'unfold safeWithdraw',
        'rewrite',
        t('展开 safeWithdraw 函数外壳', 'Unfold safeWithdraw body'),
        t('让目标直接暴露出 balance - amount。', 'Expands safeWithdraw to balance - amount.'),
      ),
      card(
        'omega',
        'omega',
        'auto',
        t('算术核弹：线性整数/自然数求解', 'Arithmetic nuke: solve linear goal'),
        t(
          '在展开之后结合 h : amount ≤ balance 直接证死！',
          'Solves linear Nat inequalities once unfolded.',
        ),
      ),
      card(
        'exact_sub_add_cancel',
        'exact Nat.sub_add_cancel h',
        'finish',
        t('精确引理：Nat.sub_add_cancel h', 'Exact lemma: Nat.sub_add_cancel h'),
        t(
          '展开后也可以用标准库减加消去引理一击收尾。',
          'Standard library lemma matching n - m + m = n.',
        ),
      ),
      card(
        'rfl',
        'rfl',
        'finish',
        t('尝试直接 rfl', 'Try bare rfl'),
        t(
          '带有前提 h 的自然数减法消去不是纯定义化简。',
          'Subtraction cancellation requires h, not rfl.',
        ),
      ),
    ],
    parSteps: 2,
    unlocks: t('omega · 算术终结技', 'omega · Linear Solver'),
    unlocksCode: 'unfold / omega',
  },
];

export const towerFloorById = (id: TowerFloorId | string | undefined): TowerFloor =>
  TOWER_FLOORS.find((floor) => floor.id === id) ?? TOWER_FLOORS[0]!;
