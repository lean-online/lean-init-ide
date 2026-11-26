/**
 * 趣味挑战 0 MB 即时互动舞台的渲染与事件绑定。
 *
 * 渲染函数纯输出 HTML，不读 window / document / localStorage（SSG 安全）；
 * 所有事件绑定都在 Lean / Monaco 主包异步加载之前完成，让玩家点开即可上手。
 */
import {
  buildCollatzSparklinePoints,
  buildEvenSumCounterCode,
  buildNatSubCounterCode,
  computeCollatzSequence,
  evaluateDoubleNeg,
  evaluateEvenSum,
  evaluateNatSub,
  findGoldbachPairs,
  simulateBudgetWithdraw,
  simulateClamp,
  stageKindForSlug,
  type StageKind,
} from '../challenge-stage';
import type { Challenge } from '../challenges';
import { buttonClass, ghostButtonClass, toolbarButtonClass } from '../components/ui';
import type { ChallengeTier } from '../exercise';
import { messagesFor, type Locale } from '../i18n';
import { escapeHtml } from './html';

export type StageBindHooks = {
  onSubmitCode: (code: string, branch?: 'true' | 'false') => void;
  onSelectVerdictTrue: () => void;
  onFocusEditor: () => void;
  onInteraction: () => void;
  onSound: (kind: 'gavel' | 'alert' | 'click') => void;
};

export type StageController = {
  updateGoalHp: (remainingGoals: number | null) => void;
  updateBountyTiers: (tiers: readonly ChallengeTier[]) => void;
};

const INPUT_CLASS =
  'w-full min-w-0 rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none';

const CARD_SHELL = 'mt-4 rounded-2xl border border-accent/35 bg-panel-soft p-4';

const ZERO_MB_BADGE_CLASS =
  'rounded-full border border-ok/40 bg-ok/10 px-2.5 py-0.5 text-[11px] font-[650] text-ok';

const renderStageHeader = (title: string, subtitle: string, badge: string): string => `
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="m-0 text-[15px] font-bold text-fg">${escapeHtml(title)}</p>
    <span class="${ZERO_MB_BADGE_CLASS}">${escapeHtml(badge)}</span>
  </div>
  <p class="mt-1.5 mb-0 text-xs leading-relaxed text-muted">${escapeHtml(subtitle)}</p>
`;

const renderBountyBoard = (locale: Locale): string => {
  const detail = messagesFor(locale).challenges.detail;
  const st = detail.stage.collatzLab;
  return `
    <div class="mt-3 rounded-xl border border-line bg-panel p-3" data-role="bounty-board">
      <p class="m-0 mb-2 text-xs font-[650] text-muted">${escapeHtml(st.tierBoardTitle)}</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div data-bounty-tier="bronze" class="flex items-center justify-between rounded-lg border border-line bg-panel-soft px-3 py-2 text-xs">
          <span class="font-[650]">${escapeHtml(detail.tierLabels.bronze)}</span>
          <span data-role="tier-state" class="text-muted">${escapeHtml(st.tierLocked)}</span>
        </div>
        <div data-bounty-tier="silver" class="flex items-center justify-between rounded-lg border border-line bg-panel-soft px-3 py-2 text-xs">
          <span class="font-[650]">${escapeHtml(detail.tierLabels.silver)}</span>
          <span data-role="tier-state" class="text-muted">${escapeHtml(st.tierLocked)}</span>
        </div>
        <div data-bounty-tier="legend" class="flex items-center justify-between rounded-lg border border-warn/35 bg-warn/10 px-3 py-2 text-xs">
          <span class="font-[650] text-warn">${escapeHtml(detail.tierLabels.legend)}</span>
          <span data-role="tier-state" class="text-warn">${escapeHtml(st.tierLegendOpen)}</span>
        </div>
      </div>
    </div>`;
};

const renderNatSubStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = evaluateNatSub(5, 3);
  return `
    <section data-role="challenge-stage" data-stage-kind="nat-sub" class="${CARD_SHELL}">
      ${renderStageHeader(s.natSub.title, s.natSub.subtitle, s.badgeZeroMb)}
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.natSub.labelA)}</span>
          <input data-role="stage-input-a" type="number" min="0" max="9999" value="${init.a}" class="${INPUT_CLASS}" />
        </label>
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.natSub.labelB)}</span>
          <input data-role="stage-input-b" type="number" min="0" max="9999" value="${init.b}" class="${INPUT_CLASS}" />
        </label>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-2">
        <button type="button" class="${toolbarButtonClass}" data-role="stage-swap">${escapeHtml(s.natSub.swapButton)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-a="5" data-b="3">${escapeHtml(s.natSub.presetTrap)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-a="10" data-b="4">${escapeHtml(s.natSub.presetSafe)}</button>
      </div>
      <div class="mt-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 font-mono text-sm" data-role="stage-formula">
        (${init.a} - ${init.b}) + ${init.b} = ${init.diff} + ${init.b} = ${init.lhs}  vs  a = ${init.rhs}
      </div>
      <p class="mt-2 mb-0 text-xs font-[650] text-muted" data-role="stage-feedback" aria-live="polite">
        ${escapeHtml(s.natSub.statusSafe(init.lhs, init.rhs))}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="${buttonClass}" data-role="stage-submit" disabled>${escapeHtml(s.natSub.submitButton)}</button>
      </div>
    </section>`;
};

const renderEvenSumStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = evaluateEvenSum(2, 2);
  return `
    <section data-role="challenge-stage" data-stage-kind="even-sum" class="${CARD_SHELL}">
      ${renderStageHeader(s.evenSum.title, s.evenSum.subtitle, s.badgeZeroMb)}
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.evenSum.labelA)}</span>
          <input data-role="stage-input-a" type="number" min="0" max="9999" value="${init.a}" class="${INPUT_CLASS}" />
        </label>
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.evenSum.labelB)}</span>
          <input data-role="stage-input-b" type="number" min="0" max="9999" value="${init.b}" class="${INPUT_CLASS}" />
        </label>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-2">
        <button type="button" class="${toolbarButtonClass}" data-role="stage-bump">${escapeHtml(s.evenSum.bumpBothButton)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-a="2" data-b="2">${escapeHtml(s.evenSum.presetEven)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-a="4" data-b="6">${escapeHtml(s.evenSum.presetMixed)}</button>
      </div>
      <div class="mt-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 font-mono text-sm" data-role="stage-formula">
        ${init.a} + ${init.b} = ${init.sum}
      </div>
      <p class="mt-2 mb-0 text-xs font-[650] text-muted" data-role="stage-feedback" aria-live="polite">
        ${escapeHtml(s.evenSum.statusSafe(init.sum))}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="${buttonClass}" data-role="stage-submit" disabled>${escapeHtml(s.evenSum.submitButton)}</button>
      </div>
    </section>`;
};

const renderDoubleNegStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  return `
    <section data-role="challenge-stage" data-stage-kind="double-neg" class="${CARD_SHELL}">
      ${renderStageHeader(s.doubleNeg.title, s.doubleNeg.subtitle, s.badgeZeroMb)}
      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div class="rounded-lg border border-line bg-panel p-2.5">
          <p class="m-0 text-[11px] text-muted">${escapeHtml(s.doubleNeg.stepP)}</p>
          <p data-role="dn-p" class="m-0 mt-1 font-mono text-sm font-bold text-ok">${escapeHtml(s.doubleNeg.stateTrue)}</p>
        </div>
        <div class="rounded-lg border border-line bg-panel p-2.5">
          <p class="m-0 text-[11px] text-muted">${escapeHtml(s.doubleNeg.stepNotP)}</p>
          <p data-role="dn-not-p" class="m-0 mt-1 font-mono text-sm font-bold text-err">${escapeHtml(s.doubleNeg.stateFalse)}</p>
        </div>
        <div class="rounded-lg border border-line bg-panel p-2.5">
          <p class="m-0 text-[11px] text-muted">${escapeHtml(s.doubleNeg.stepNotNotP)}</p>
          <p data-role="dn-not-not-p" class="m-0 mt-1 font-mono text-sm font-bold text-ok">${escapeHtml(s.doubleNeg.stateTrue)}</p>
        </div>
      </div>
      <p class="mt-2.5 mb-0 text-xs leading-relaxed text-muted">${escapeHtml(s.doubleNeg.insight)}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="${toolbarButtonClass}" data-role="dn-toggle">${escapeHtml(s.doubleNeg.toggleButton)}</button>
        <button type="button" class="${ghostButtonClass}" data-role="dn-select-true">${escapeHtml(s.doubleNeg.switchToTrueButton)}</button>
      </div>
    </section>`;
};

const renderBudgetAtmStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = simulateBudgetWithdraw(100, 30);
  return `
    <section data-role="challenge-stage" data-stage-kind="budget-atm" class="${CARD_SHELL}">
      ${renderStageHeader(s.budgetAtm.title, s.budgetAtm.subtitle, s.badgeZeroMb)}
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.budgetAtm.labelBalance)}</span>
          <input data-role="stage-input-balance" type="number" min="0" max="999999" value="${init.balance}" class="${INPUT_CLASS}" />
        </label>
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.budgetAtm.labelAmount)}</span>
          <input data-role="stage-input-amount" type="number" min="0" max="999999" value="${init.amount}" class="${INPUT_CLASS}" />
        </label>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-2">
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-balance="100" data-amount="30">${escapeHtml(s.budgetAtm.presetNormal)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-balance="30" data-amount="100">${escapeHtml(s.budgetAtm.presetOverdraft)}</button>
      </div>
      <div class="mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err" data-role="stage-feedback" aria-live="polite">
        ${escapeHtml(s.budgetAtm.statusFreeMoney(init.balance, init.amount, init.buggyBalance, init.roundTrip))}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="${buttonClass}" data-role="stage-focus-editor">${escapeHtml(s.budgetAtm.fixInEditorButton)}</button>
      </div>
    </section>`;
};

const renderClampStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = simulateClamp(10, 20, 5);
  return `
    <section data-role="challenge-stage" data-stage-kind="clamp-sim" class="${CARD_SHELL}">
      ${renderStageHeader(s.clampSim.title, s.clampSim.subtitle, s.badgeZeroMb)}
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.clampSim.labelLo)}</span>
          <input data-role="stage-input-lo" type="number" min="0" max="9999" value="${init.lo}" class="${INPUT_CLASS}" />
        </label>
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.clampSim.labelHi)}</span>
          <input data-role="stage-input-hi" type="number" min="0" max="9999" value="${init.hi}" class="${INPUT_CLASS}" />
        </label>
        <label class="flex flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.clampSim.labelX)}</span>
          <input data-role="stage-input-x" type="number" min="0" max="9999" value="${init.x}" class="${INPUT_CLASS}" />
        </label>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-2">
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-lo="10" data-hi="20" data-x="5">${escapeHtml(s.clampSim.presetLow)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-lo="20" data-hi="10" data-x="15">${escapeHtml(s.clampSim.presetInverted)}</button>
      </div>
      <div class="mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err" data-role="stage-feedback" aria-live="polite">
        ${escapeHtml(s.clampSim.statusSwapped(init.lo, init.hi, init.x, init.buggyOut))}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="${buttonClass}" data-role="stage-focus-editor">${escapeHtml(s.clampSim.fixInEditorButton)}</button>
      </div>
    </section>`;
};

const renderCollatzStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = computeCollatzSequence(27);
  const points = buildCollatzSparklinePoints(init.steps, 320, 76);
  return `
    <section data-role="challenge-stage" data-stage-kind="collatz-lab" class="${CARD_SHELL}">
      ${renderStageHeader(s.collatzLab.title, s.collatzLab.subtitle, s.badgeZeroMb)}
      ${renderBountyBoard(locale)}
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <label class="flex min-w-[140px] flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.collatzLab.labelN)}</span>
          <input data-role="stage-input-n" type="number" min="1" max="100000" value="${init.start}" class="${INPUT_CLASS}" />
        </label>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-run-collatz">${escapeHtml(s.collatzLab.runButton)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="6">n = 6</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="27">n = 27</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="97">n = 97</button>
      </div>
      <div class="mt-3 rounded-xl border border-line bg-panel p-3">
        <svg viewBox="0 0 320 76" class="h-20 w-full" aria-hidden="true">
          <polyline data-role="collatz-line" fill="none" stroke="currentColor" class="text-ok" stroke-width="2" stroke-linejoin="round" points="${escapeHtml(points)}" />
        </svg>
        <p data-role="stage-feedback" class="m-0 mt-1.5 text-xs font-[650] text-fg" aria-live="polite">
          ${escapeHtml(s.collatzLab.stats(init.stepCount, init.peak, init.reachedOne))}
        </p>
      </div>
    </section>`;
};

const renderGoldbachStage = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage;
  const init = findGoldbachPairs(100);
  const first = init.firstPair ?? [3, 97];
  return `
    <section data-role="challenge-stage" data-stage-kind="goldbach-lab" class="${CARD_SHELL}">
      ${renderStageHeader(s.goldbachLab.title, s.goldbachLab.subtitle, s.badgeZeroMb)}
      ${renderBountyBoard(locale)}
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <label class="flex min-w-[140px] flex-col gap-1 text-xs font-[650] text-muted">
          <span>${escapeHtml(s.goldbachLab.labelN)}</span>
          <input data-role="stage-input-n" type="number" min="4" max="10000" step="2" value="${init.n}" class="${INPUT_CLASS}" />
        </label>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-run-goldbach">${escapeHtml(s.goldbachLab.splitButton)}</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="10">10</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="100">100</button>
        <button type="button" class="${toolbarButtonClass}" data-role="stage-preset" data-n="2026">2026</button>
      </div>
      <p data-role="stage-feedback" class="mt-3 mb-0 rounded-xl border border-ok/35 bg-ok/10 px-3.5 py-2.5 text-xs font-[650] text-ok" aria-live="polite">
        ${escapeHtml(s.goldbachLab.resultMatch(init.n, first[0], first[1], init.pairCount))}
      </p>
    </section>`;
};

const renderClassicArenaHud = (locale: Locale): string => {
  const s = messagesFor(locale).challenges.detail.stage.classicArena;
  return `
    <section data-role="challenge-stage" data-stage-kind="classic-arena" class="mt-4 rounded-xl border border-accent/30 bg-panel-soft px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-[650]">
        <span class="text-muted">${escapeHtml(s.hpLabel)}</span>
        <span data-role="goal-hp-text" class="text-accent">${escapeHtml(s.hpClear)}</span>
      </div>
      <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-panel">
        <div data-role="goal-hp-bar" class="h-full rounded-full bg-accent transition-all duration-300" style="width: 100%"></div>
      </div>
    </section>`;
};

export const renderChallengeStage = (challenge: Challenge, locale: Locale): string => {
  const kind: StageKind = stageKindForSlug(challenge.slug);
  if (kind === 'nat-sub') return renderNatSubStage(locale);
  if (kind === 'even-sum') return renderEvenSumStage(locale);
  if (kind === 'double-neg') return renderDoubleNegStage(locale);
  if (kind === 'budget-atm') return renderBudgetAtmStage(locale);
  if (kind === 'clamp-sim') return renderClampStage(locale);
  if (kind === 'collatz-lab') return renderCollatzStage(locale);
  if (kind === 'goldbach-lab') return renderGoldbachStage(locale);
  return renderClassicArenaHud(locale);
};

export const bindChallengeStage = (
  root: HTMLElement,
  challenge: Challenge,
  locale: Locale,
  hooks: StageBindHooks,
): StageController => {
  const stageEl = root.querySelector<HTMLElement>('[data-role="challenge-stage"]');
  const st = messagesFor(locale).challenges.detail.stage;
  const kind = stageKindForSlug(challenge.slug);

  const updateGoalHp = (remainingGoals: number | null) => {
    const bar = root.querySelector<HTMLElement>('[data-role="goal-hp-bar"]');
    const label = root.querySelector<HTMLElement>('[data-role="goal-hp-text"]');
    if (!bar || !label) return;
    if (remainingGoals === null || remainingGoals <= 0) {
      bar.style.width = '100%';
      bar.className = 'h-full rounded-full bg-ok transition-all duration-300';
      label.textContent = st.classicArena.hpClear;
      label.className = 'text-ok';
      return;
    }
    const pct = Math.max(18, Math.min(100, remainingGoals * 25));
    bar.style.width = `${pct}%`;
    bar.className = 'h-full rounded-full bg-warn transition-all duration-300';
    label.textContent = st.classicArena.hpRemaining(remainingGoals);
    label.className = 'text-warn';
  };

  const updateBountyTiers = (tiers: readonly ChallengeTier[]) => {
    const activeSet = new Set(tiers);
    for (const tierName of ['bronze', 'silver'] as const) {
      const card = root.querySelector<HTMLElement>(`[data-bounty-tier="${tierName}"]`);
      const stateEl = card?.querySelector<HTMLElement>('[data-role="tier-state"]');
      if (!card || !stateEl) continue;
      const unlocked = activeSet.has(tierName);
      card.className = unlocked
        ? 'flex items-center justify-between rounded-lg border border-ok/45 bg-ok/10 px-3 py-2 text-xs text-ok'
        : 'flex items-center justify-between rounded-lg border border-line bg-panel-soft px-3 py-2 text-xs';
      stateEl.className = unlocked ? 'font-[650] text-ok' : 'text-muted';
      stateEl.textContent = unlocked ? st.collatzLab.tierUnlocked : st.collatzLab.tierLocked;
    }
  };

  if (!stageEl) return { updateGoalHp, updateBountyTiers };

  if (kind === 'nat-sub') {
    const inputA = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-a"]');
    const inputB = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-b"]');
    const formulaEl = stageEl.querySelector<HTMLElement>('[data-role="stage-formula"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');
    const submitBtn = stageEl.querySelector<HTMLButtonElement>('[data-role="stage-submit"]');

    const refresh = (notifySound = false) => {
      const res = evaluateNatSub(Number(inputA?.value ?? 5), Number(inputB?.value ?? 3));
      if (formulaEl) {
        formulaEl.textContent = `(${res.a} - ${res.b}) + ${res.b} = ${res.diff} + ${res.b} = ${res.lhs}  vs  a = ${res.rhs}`;
      }
      if (feedbackEl) {
        feedbackEl.textContent = res.breaks
          ? st.natSub.statusBroken(res.a, res.b, res.lhs)
          : st.natSub.statusSafe(res.lhs, res.rhs);
        feedbackEl.className = `mt-2 mb-0 text-xs font-[650] ${res.breaks ? 'text-warn' : 'text-muted'}`;
      }
      if (submitBtn) submitBtn.disabled = !res.breaks;
      if (notifySound && res.breaks) hooks.onSound('gavel');
    };

    inputA?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    inputB?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    stageEl.querySelector('[data-role="stage-swap"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      if (!inputA || !inputB) return;
      const tmp = inputA.value;
      inputA.value = inputB.value;
      inputB.value = tmp;
      hooks.onSound('click');
      refresh(true);
    });
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (inputA && btn.dataset.a) inputA.value = btn.dataset.a;
        if (inputB && btn.dataset.b) inputB.value = btn.dataset.b;
        hooks.onSound('click');
        refresh(true);
      });
    }
    submitBtn?.addEventListener('click', () => {
      hooks.onInteraction();
      const res = evaluateNatSub(Number(inputA?.value ?? 0), Number(inputB?.value ?? 1));
      if (!res.breaks) return;
      hooks.onSound('gavel');
      hooks.onSubmitCode(buildNatSubCounterCode(res.a, res.b, locale), 'false');
    });
    refresh(false);
  } else if (kind === 'even-sum') {
    const inputA = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-a"]');
    const inputB = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-b"]');
    const formulaEl = stageEl.querySelector<HTMLElement>('[data-role="stage-formula"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');
    const submitBtn = stageEl.querySelector<HTMLButtonElement>('[data-role="stage-submit"]');

    const refresh = (notifySound = false) => {
      const res = evaluateEvenSum(Number(inputA?.value ?? 2), Number(inputB?.value ?? 2));
      if (formulaEl) formulaEl.textContent = `${res.a} + ${res.b} = ${res.sum}`;
      if (feedbackEl) {
        feedbackEl.textContent = res.breaks
          ? st.evenSum.statusBroken(res.a, res.b, res.sum)
          : st.evenSum.statusSafe(res.sum);
        feedbackEl.className = `mt-2 mb-0 text-xs font-[650] ${res.breaks ? 'text-warn' : 'text-muted'}`;
      }
      if (submitBtn) submitBtn.disabled = !res.breaks;
      if (notifySound && res.breaks) hooks.onSound('gavel');
    };

    inputA?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    inputB?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    stageEl.querySelector('[data-role="stage-bump"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      if (!inputA || !inputB) return;
      inputA.value = String((Number(inputA.value) || 0) + 1);
      inputB.value = String((Number(inputB.value) || 0) + 1);
      hooks.onSound('click');
      refresh(true);
    });
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (inputA && btn.dataset.a) inputA.value = btn.dataset.a;
        if (inputB && btn.dataset.b) inputB.value = btn.dataset.b;
        hooks.onSound('click');
        refresh(true);
      });
    }
    submitBtn?.addEventListener('click', () => {
      hooks.onInteraction();
      const res = evaluateEvenSum(Number(inputA?.value ?? 1), Number(inputB?.value ?? 1));
      if (!res.breaks) return;
      hooks.onSound('gavel');
      hooks.onSubmitCode(buildEvenSumCounterCode(res.a, res.b, locale), 'false');
    });
    refresh(false);
  } else if (kind === 'double-neg') {
    let pState = true;
    const pEl = stageEl.querySelector<HTMLElement>('[data-role="dn-p"]');
    const notPEl = stageEl.querySelector<HTMLElement>('[data-role="dn-not-p"]');
    const notNotPEl = stageEl.querySelector<HTMLElement>('[data-role="dn-not-not-p"]');
    const paint = () => {
      const ev = evaluateDoubleNeg(pState);
      if (pEl) {
        pEl.textContent = ev.p ? st.doubleNeg.stateTrue : st.doubleNeg.stateFalse;
        pEl.className = `m-0 mt-1 font-mono text-sm font-bold ${ev.p ? 'text-ok' : 'text-err'}`;
      }
      if (notPEl) {
        notPEl.textContent = ev.notP ? st.doubleNeg.stateTrue : st.doubleNeg.stateFalse;
        notPEl.className = `m-0 mt-1 font-mono text-sm font-bold ${ev.notP ? 'text-ok' : 'text-err'}`;
      }
      if (notNotPEl) {
        notNotPEl.textContent = ev.notNotP ? st.doubleNeg.stateTrue : st.doubleNeg.stateFalse;
        notNotPEl.className = `m-0 mt-1 font-mono text-sm font-bold ${ev.notNotP ? 'text-ok' : 'text-err'}`;
      }
    };
    stageEl.querySelector('[data-role="dn-toggle"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      pState = !pState;
      hooks.onSound('click');
      paint();
    });
    stageEl.querySelector('[data-role="dn-select-true"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      hooks.onSound('click');
      hooks.onSelectVerdictTrue();
    });
  } else if (kind === 'budget-atm') {
    const balInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-balance"]');
    const amtInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-amount"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');

    const refresh = (notifySound = false) => {
      const sim = simulateBudgetWithdraw(
        Number(balInput?.value ?? 100),
        Number(amtInput?.value ?? 30),
      );
      if (feedbackEl) {
        if (sim.bugKind === 'free-money') {
          feedbackEl.textContent = st.budgetAtm.statusFreeMoney(
            sim.balance,
            sim.amount,
            sim.buggyBalance,
            sim.roundTrip,
          );
          feedbackEl.className =
            'mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err';
          if (notifySound) hooks.onSound('alert');
        } else if (sim.bugKind === 'overdraft-truncation') {
          feedbackEl.textContent = st.budgetAtm.statusOverdraft(
            sim.balance,
            sim.amount,
            sim.roundTrip,
          );
          feedbackEl.className =
            'mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err';
          if (notifySound) hooks.onSound('alert');
        } else {
          feedbackEl.textContent = st.budgetAtm.statusOk;
          feedbackEl.className =
            'mt-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-xs font-[650] text-muted';
        }
      }
    };

    balInput?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    amtInput?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh(true);
    });
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (balInput && btn.dataset.balance) balInput.value = btn.dataset.balance;
        if (amtInput && btn.dataset.amount) amtInput.value = btn.dataset.amount;
        hooks.onSound('click');
        refresh(true);
      });
    }
    stageEl.querySelector('[data-role="stage-focus-editor"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      hooks.onSound('click');
      hooks.onFocusEditor();
    });
  } else if (kind === 'clamp-sim') {
    const loInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-lo"]');
    const hiInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-hi"]');
    const xInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-x"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');

    const refresh = (notifySound = false) => {
      const sim = simulateClamp(
        Number(loInput?.value ?? 10),
        Number(hiInput?.value ?? 20),
        Number(xInput?.value ?? 5),
      );
      if (feedbackEl) {
        if (sim.bugKind === 'inverted-bounds') {
          feedbackEl.textContent = st.clampSim.statusInverted(sim.lo, sim.hi, sim.buggyOut);
          feedbackEl.className =
            'mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err';
          if (notifySound) hooks.onSound('alert');
        } else if (sim.bugKind === 'swapped-branch') {
          feedbackEl.textContent = st.clampSim.statusSwapped(sim.lo, sim.hi, sim.x, sim.buggyOut);
          feedbackEl.className =
            'mt-3 rounded-xl border border-err/40 bg-err/10 px-3.5 py-2.5 text-xs font-[650] text-err';
          if (notifySound) hooks.onSound('alert');
        } else {
          feedbackEl.textContent = st.clampSim.statusOk(sim.lo, sim.hi, sim.buggyOut);
          feedbackEl.className =
            'mt-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-xs font-[650] text-muted';
        }
      }
    };

    for (const input of [loInput, hiInput, xInput]) {
      input?.addEventListener('input', () => {
        hooks.onInteraction();
        refresh(true);
      });
    }
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (loInput && btn.dataset.lo) loInput.value = btn.dataset.lo;
        if (hiInput && btn.dataset.hi) hiInput.value = btn.dataset.hi;
        if (xInput && btn.dataset.x) xInput.value = btn.dataset.x;
        hooks.onSound('click');
        refresh(true);
      });
    }
    stageEl.querySelector('[data-role="stage-focus-editor"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      hooks.onSound('click');
      hooks.onFocusEditor();
    });
  } else if (kind === 'collatz-lab') {
    const nInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-n"]');
    const lineEl = stageEl.querySelector<SVGPolylineElement>('[data-role="collatz-line"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');

    const refresh = () => {
      const seq = computeCollatzSequence(Number(nInput?.value ?? 27));
      const pts = buildCollatzSparklinePoints(seq.steps, 320, 76);
      lineEl?.setAttribute('points', pts);
      if (feedbackEl) {
        feedbackEl.textContent = st.collatzLab.stats(seq.stepCount, seq.peak, seq.reachedOne);
      }
    };

    stageEl.querySelector('[data-role="stage-run-collatz"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      hooks.onSound('click');
      refresh();
    });
    nInput?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh();
    });
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (nInput && btn.dataset.n) nInput.value = btn.dataset.n;
        hooks.onSound('click');
        refresh();
      });
    }
  } else if (kind === 'goldbach-lab') {
    const nInput = stageEl.querySelector<HTMLInputElement>('[data-role="stage-input-n"]');
    const feedbackEl = stageEl.querySelector<HTMLElement>('[data-role="stage-feedback"]');

    const refresh = () => {
      const res = findGoldbachPairs(Number(nInput?.value ?? 100));
      if (!feedbackEl) return;
      if (!res.validEven || !res.firstPair) {
        feedbackEl.textContent = st.goldbachLab.resultNeedEven;
        feedbackEl.className =
          'mt-3 mb-0 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs font-[650] text-warn';
        return;
      }
      feedbackEl.textContent = st.goldbachLab.resultMatch(
        res.n,
        res.firstPair[0],
        res.firstPair[1],
        res.pairCount,
      );
      feedbackEl.className =
        'mt-3 mb-0 rounded-xl border border-ok/35 bg-ok/10 px-3.5 py-2.5 text-xs font-[650] text-ok';
    };

    stageEl.querySelector('[data-role="stage-run-goldbach"]')?.addEventListener('click', () => {
      hooks.onInteraction();
      hooks.onSound('click');
      refresh();
    });
    nInput?.addEventListener('input', () => {
      hooks.onInteraction();
      refresh();
    });
    for (const btn of stageEl.querySelectorAll<HTMLButtonElement>('[data-role="stage-preset"]')) {
      btn.addEventListener('click', () => {
        hooks.onInteraction();
        if (nInput && btn.dataset.n) nInput.value = btn.dataset.n;
        hooks.onSound('click');
        refresh();
      });
    }
  }

  return { updateGoalHp, updateBountyTiers };
};
