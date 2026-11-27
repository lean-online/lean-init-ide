/**
 * 「证明爬塔天梯 · Proof Tower」交互视图：
 * - 首屏极简聚焦：Boss（护盾）+ 当前目标公式（⊢）+ 手里的 Lean 战术牌；
 * - 0 MB 即时出牌游玩；绝不后台静默拉取 102 MB 运行时；
 * - 只有玩家主动点击「用真 Lean 4.36 内核认证」时，才按需导入并启动紧凑版 Lean 面板真编译验算。
 */
import {
  getArcadeNickname,
  getSfxEnabled,
  launchConfettiBurst,
  playArcadeSound,
  setSfxEnabled,
} from '../challenge-fx';
import { renderVictoryPosterDataUrl } from '../challenge-poster';
import { renderLeanMarkup, showEditorLoadFailure } from '../components/lean-markup';
import { buttonClass, ghostButtonClass, toolbarButtonClass } from '../components/ui';
import { isExerciseSolved } from '../exercise';
import { messagesFor, type Locale } from '../i18n';
import {
  applyTowerCard,
  buildTowerLeanCode,
  computeChallengeRank,
  createInitialTowerState,
  formatElapsedMs,
  TOWER_FLOORS,
  towerFloorById,
  towerLadderRank,
  TowerProgressStore,
  undoTowerStep,
  type TowerFloor,
  type TowerFloorId,
  type TowerMonsterId,
  type TowerState,
  type TowerTacticId,
} from '../proof-tower';
import { escapeHtml } from './html';

const MONSTER_COLOR: Record<TowerMonsterId, string> = {
  slime: 'text-ok',
  goblin: 'text-accent',
  golem: 'text-warn',
  sentinel: 'text-accent',
  hydra: 'text-err',
  king: 'text-warn',
};

const renderMonsterSvg = (
  monster: TowerMonsterId,
  shieldCount: number,
  cleared: boolean,
): string => {
  const color = cleared ? 'text-ok opacity-40' : MONSTER_COLOR[monster];
  const crown =
    monster === 'king'
      ? '<path d="M18 18 L24 10 L32 16 L40 10 L46 18 Z" fill="currentColor" opacity="0.9"/>'
      : '';
  const body =
    monster === 'hydra' && shieldCount > 1
      ? `<circle cx="22" cy="34" r="11" fill="currentColor" opacity="0.22" stroke="currentColor" stroke-width="2.5"/>
         <circle cx="42" cy="34" r="11" fill="currentColor" opacity="0.22" stroke="currentColor" stroke-width="2.5"/>
         <circle cx="19" cy="33" r="2.2" fill="currentColor"/>
         <circle cx="45" cy="33" r="2.2" fill="currentColor"/>`
      : `<rect x="14" y="18" width="36" height="30" rx="12" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="2.5"/>
         <circle cx="26" cy="32" r="2.6" fill="currentColor"/>
         <circle cx="38" cy="32" r="2.6" fill="currentColor"/>
         <path d="${cleared ? 'M25 41 L39 39' : 'M26 40 Q32 44 38 40'}" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

  return `<svg viewBox="0 0 64 64" class="size-14 shrink-0 ${color}" aria-hidden="true">${crown}${body}</svg>`;
};

const FLOOR_PILL_BASE =
  'inline-flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center gap-1 rounded-full border px-3 text-xs font-bold transition';

const formatTowerGoalProgress = (
  tw: ReturnType<typeof messagesFor>['challenges']['tower'],
  floor: TowerFloor,
  goalsCount: number,
  playedCount: number,
  cleared: boolean,
): string => {
  if (cleared || goalsCount === 0) return tw.shieldsLeft(0);
  if (goalsCount > 1) return tw.shieldsLeft(goalsCount);
  return tw.stepProgress(Math.max(1, floor.parSteps - playedCount));
};

const renderFloorPills = (locale: Locale, activeId: TowerFloorId): string => {
  const tw = messagesFor(locale).challenges.tower;
  return TOWER_FLOORS.map((floor) => {
    const active = floor.id === activeId;
    return `
      <button
        type="button"
        data-tower-floor="${floor.id}"
        aria-pressed="${String(active)}"
        class="${FLOOR_PILL_BASE} ${
          active
            ? 'border-accent bg-accent text-accent-contrast'
            : 'border-line bg-panel-soft text-muted hover:border-line-strong hover:text-fg'
        }"
      >
        <span>${escapeHtml(tw.floorBadge(floor.level))}</span>
        <span data-role="floor-mark" aria-hidden="true"></span>
      </button>`;
  }).join('');
};

const renderDeckButtons = (floor: TowerFloor, locale: Locale, disabled: boolean): string =>
  floor.deck
    .map(
      (card) => `
      <button
        type="button"
        data-tower-card="${card.id}"
        ${disabled ? 'disabled' : ''}
        class="group flex min-h-11 cursor-pointer flex-col items-start rounded-xl border border-line bg-panel px-3.5 py-2.5 text-left transition hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
      >
        <code class="font-mono text-sm font-bold text-accent group-hover:text-fg">${escapeHtml(card.code)}</code>
        <span class="mt-1 text-xs font-[650] text-fg">${escapeHtml(card.label[locale])}</span>
        <span class="mt-0.5 text-[11px] leading-snug text-muted">${escapeHtml(card.hint[locale])}</span>
      </button>`,
    )
    .join('');

/** SSG 安全：只依赖静态数据与双语字典，不读取浏览器环境。 */
export const renderProofTower = (locale: Locale): string => {
  const tw = messagesFor(locale).challenges.tower;
  const firstFloor = TOWER_FLOORS[0]!;
  const initialRank = towerLadderRank(0, locale);
  const initialCode = buildTowerLeanCode(firstFloor, [], locale, false);

  return `
    <section
      data-role="proof-tower"
      class="mt-5 rounded-2xl border border-accent/45 bg-panel p-[clamp(14px,2.4vw,24px)] shadow-[var(--shadow)]"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div>
          <p class="m-0 text-[11px] font-bold uppercase tracking-[0.12em] text-accent">${escapeHtml(tw.eyebrow)}</p>
          <h2 class="m-0 mt-1 text-[clamp(19px,2.5vw,24px)] font-bold text-fg">${escapeHtml(tw.title)}</h2>
          <p class="m-0 mt-1 text-xs text-muted">${escapeHtml(tw.subtitle)}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span data-role="tower-rank" class="rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-xs font-bold text-warn">${escapeHtml(`${tw.rankPrefix} · ${initialRank.tier}`)}</span>
          <span data-role="tower-combo" class="rounded-full border border-line bg-panel-soft px-2.5 py-1 font-mono text-xs text-muted">${escapeHtml(tw.comboLabel(0))}</span>
          <button type="button" class="${toolbarButtonClass}" data-role="tower-sfx" aria-pressed="true">${escapeHtml(messagesFor(locale).challenges.detail.sfxOn)}</button>
        </div>
      </div>

      <nav data-role="tower-floors" class="mt-3 flex flex-wrap gap-2" aria-label="${escapeHtml(tw.eyebrow)}">
        ${renderFloorPills(locale, firstFloor.id)}
      </nav>

      <div data-role="tower-arena" class="relative mt-4 overflow-hidden rounded-2xl border border-line bg-panel-soft p-4">
        <p data-role="tower-all-cleared-banner" class="m-0 mb-3 rounded-xl border border-ok/45 bg-ok/10 px-3 py-2 text-xs font-bold text-ok" hidden></p>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div data-role="tower-monster-icon">${renderMonsterSvg(firstFloor.monsterId, 1, false)}</div>
            <div>
              <h3 data-role="tower-floor-title" class="m-0 text-[16px] font-bold text-fg">${escapeHtml(firstFloor.title[locale])}</h3>
              <p data-role="tower-premise" class="m-0 mt-1 max-w-[640px] text-xs leading-relaxed text-muted">${escapeHtml(firstFloor.premise[locale])}</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span data-role="tower-shields" class="rounded-full border border-warn/40 bg-warn/10 px-3 py-1 font-mono text-xs font-bold text-warn">${escapeHtml(formatTowerGoalProgress(tw, firstFloor, firstFloor.initialGoals.length, 0, false))}</span>
            <span data-role="tower-verified-badge" class="rounded-full border border-ok/45 bg-ok/15 px-3 py-1 text-xs font-bold text-ok" hidden>${escapeHtml(tw.verifiedSeal)}</span>
          </div>
        </div>

        <div data-role="tower-hypotheses-wrap" class="mt-3" hidden>
          <p class="m-0 mb-1.5 text-[11px] font-[650] uppercase tracking-[0.06em] text-muted">${escapeHtml(tw.hypothesesLabel)}</p>
          <div data-role="tower-hypotheses" class="flex flex-wrap gap-1.5"></div>
        </div>

        <div class="mt-3 rounded-xl border border-accent/40 bg-panel p-3.5">
          <p class="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-accent">${escapeHtml(tw.activeGoalLabel)}</p>
          <p data-role="tower-goal" class="m-0 mt-1 font-mono text-[clamp(16px,2.2vw,22px)] font-extrabold text-fg">⊢ ${escapeHtml(firstFloor.initialGoals[0]!.target)}</p>
          <div data-role="tower-queued-goals" class="mt-2 flex flex-wrap gap-2" hidden></div>
        </div>

        <p data-role="tower-log" aria-live="polite" class="m-0 mt-2.5 text-xs font-[650] text-muted">${escapeHtml(tw.idleLog)}</p>

        <div data-role="tower-victory" class="mt-3 rounded-xl border border-ok/45 bg-ok/10 p-3.5 text-ok" hidden>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p data-role="tower-victory-title" class="m-0 text-[15px] font-bold">${escapeHtml(tw.clearedTitle(firstFloor.monsterName[locale]))}</p>
              <p data-role="tower-victory-drop" class="m-0 mt-1 text-xs">${escapeHtml(tw.unlockedDrop(firstFloor.unlocks[locale]))}</p>
            </div>
            <span class="arcade-stamp rounded-lg border-2 border-ok px-2.5 py-0.5 font-mono text-[11px] font-extrabold">${escapeHtml(tw.clearedStamp)}</span>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" data-role="tower-next" class="${buttonClass}">${escapeHtml(tw.nextFloorCta(2, TOWER_FLOORS[1]!.monsterName[locale]))}</button>
            <button type="button" data-role="tower-poster-btn" class="${ghostButtonClass}">${escapeHtml(tw.posterButton)}</button>
            <button type="button" data-role="tower-copy-text" class="${ghostButtonClass}">${escapeHtml(tw.copyTextButton)}</button>
            <a data-role="tower-poster-dl" class="${ghostButtonClass}" download="lean-proof-tower.png" hidden>${escapeHtml(messagesFor(locale).challenges.detail.poster.downloadButton)}</a>
            <span data-role="tower-copy-status" role="status" aria-live="polite" class="text-xs font-[650]" hidden></span>
          </div>
          <div data-role="tower-poster-wrap" class="mt-3" hidden>
            <img data-role="tower-poster-img" alt="${escapeHtml(messagesFor(locale).challenges.detail.poster.previewAlt)}" class="max-h-[320px] w-auto rounded-xl border border-line" />
          </div>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-1.5 text-xs">
          <span class="text-muted">${escapeHtml(tw.playedLabel)}</span>
          <span data-role="tower-played" class="font-mono text-fg">—</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="${toolbarButtonClass}" data-role="tower-undo" disabled>${escapeHtml(tw.undoButton)}</button>
          <button type="button" class="${toolbarButtonClass}" data-role="tower-reset">${escapeHtml(tw.resetButton)}</button>
        </div>
      </div>

      <div data-role="tower-deck" class="mt-3 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2.5">
        ${renderDeckButtons(firstFloor, locale, false)}
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-panel-soft px-3.5 py-2.5 text-xs">
        <span class="font-[650] text-muted">${escapeHtml(tw.spellbookTitle)}</span>
        <div data-role="tower-spellbook" class="flex flex-wrap gap-1.5 text-muted">
          <span>${escapeHtml(tw.spellbookEmpty)}</span>
        </div>
      </div>

      <div data-role="tower-verifier" class="mt-3 rounded-xl border border-line bg-panel-soft p-3.5">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="${toolbarButtonClass}" data-role="tower-toggle-code" aria-expanded="false">${escapeHtml(tw.toggleCodeButton)}</button>
          <button type="button" class="${ghostButtonClass}" data-role="tower-verify-btn">${escapeHtml(tw.verifyButton)}</button>
          <span data-role="tower-verify-status" aria-live="polite" class="text-xs text-muted"></span>
        </div>
        <p class="m-0 mt-2 text-[11px] leading-relaxed text-muted">${escapeHtml(tw.verifyNote)}</p>
        <pre data-role="tower-code" class="m-0 mt-2.5 overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-[1.6] text-fg" hidden><code>${escapeHtml(initialCode)}</code></pre>
        <div data-role="tower-lean-host" class="mt-3" hidden></div>
      </div>
    </section>
  `;
};

export const mountProofTower = (root: HTMLElement, locale: Locale): void => {
  const host = root.querySelector<HTMLElement>('[data-role="proof-tower"]');
  if (!host) return;

  const t = messagesFor(locale).challenges;
  const tw = t.tower;
  const store = new TowerProgressStore();

  let state: TowerState = createInitialTowerState(store.firstPendingFloor());
  let combo = 0;
  let floorStartedAt = Date.now();
  let sfxEnabled = getSfxEnabled();

  const floorBtns = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-tower-floor]'));
  const rankEl = host.querySelector<HTMLElement>('[data-role="tower-rank"]');
  const comboEl = host.querySelector<HTMLElement>('[data-role="tower-combo"]');
  const sfxBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-sfx"]');
  const arenaEl = host.querySelector<HTMLElement>('[data-role="tower-arena"]');
  const allClearedBannerEl = host.querySelector<HTMLElement>(
    '[data-role="tower-all-cleared-banner"]',
  );
  const iconEl = host.querySelector<HTMLElement>('[data-role="tower-monster-icon"]');
  const titleEl = host.querySelector<HTMLElement>('[data-role="tower-floor-title"]');
  const premiseEl = host.querySelector<HTMLElement>('[data-role="tower-premise"]');
  const shieldsEl = host.querySelector<HTMLElement>('[data-role="tower-shields"]');
  const verifiedBadgeEl = host.querySelector<HTMLElement>('[data-role="tower-verified-badge"]');
  const hypWrapEl = host.querySelector<HTMLElement>('[data-role="tower-hypotheses-wrap"]');
  const hypEl = host.querySelector<HTMLElement>('[data-role="tower-hypotheses"]');
  const goalEl = host.querySelector<HTMLElement>('[data-role="tower-goal"]');
  const queuedEl = host.querySelector<HTMLElement>('[data-role="tower-queued-goals"]');
  const logEl = host.querySelector<HTMLElement>('[data-role="tower-log"]');
  const victoryEl = host.querySelector<HTMLElement>('[data-role="tower-victory"]');
  const victoryTitleEl = host.querySelector<HTMLElement>('[data-role="tower-victory-title"]');
  const victoryDropEl = host.querySelector<HTMLElement>('[data-role="tower-victory-drop"]');
  const nextBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-next"]');
  const posterBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-poster-btn"]');
  const copyTextBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-copy-text"]');
  const copyTextStatusEl = host.querySelector<HTMLElement>('[data-role="tower-copy-status"]');
  const posterDl = host.querySelector<HTMLAnchorElement>('[data-role="tower-poster-dl"]');
  const posterWrap = host.querySelector<HTMLElement>('[data-role="tower-poster-wrap"]');
  const posterImg = host.querySelector<HTMLImageElement>('[data-role="tower-poster-img"]');
  const playedEl = host.querySelector<HTMLElement>('[data-role="tower-played"]');
  const undoBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-undo"]');
  const resetBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-reset"]');
  const deckEl = host.querySelector<HTMLElement>('[data-role="tower-deck"]');
  const spellbookEl = host.querySelector<HTMLElement>('[data-role="tower-spellbook"]');
  const toggleCodeBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-toggle-code"]');
  const codePreEl = host.querySelector<HTMLElement>('[data-role="tower-code"]');
  const verifyBtn = host.querySelector<HTMLButtonElement>('[data-role="tower-verify-btn"]');
  const verifyStatusEl = host.querySelector<HTMLElement>('[data-role="tower-verify-status"]');
  const leanHostEl = host.querySelector<HTMLElement>('[data-role="tower-lean-host"]');

  let leanPanel: ReturnType<typeof import('../components/lean-panel').createLeanPanel> | null =
    null;
  let verifyingFloorId: TowerFloorId | null = null;
  let verifyingCode = '';

  const syncSfx = () => {
    if (!sfxBtn) return;
    sfxBtn.textContent = sfxEnabled ? t.detail.sfxOn : t.detail.sfxOff;
    sfxBtn.setAttribute('aria-pressed', String(sfxEnabled));
  };
  syncSfx();
  sfxBtn?.addEventListener('click', () => {
    sfxEnabled = !sfxEnabled;
    setSfxEnabled(sfxEnabled);
    syncSfx();
    if (sfxEnabled) playArcadeSound('click', true);
  });

  const paintAll = (justHit = false) => {
    const floor = towerFloorById(state.floorId);
    const progress = store.snapshot();
    const clearedSet = new Set(progress.cleared);
    const verifiedSet = new Set(progress.verified);
    const rank = towerLadderRank(progress.cleared.length, locale);

    if (rankEl) rankEl.textContent = `${tw.rankPrefix} · ${rank.tier}`;
    if (comboEl) comboEl.textContent = tw.comboLabel(combo);

    for (const btn of floorBtns) {
      const fId = btn.dataset.towerFloor as TowerFloorId | undefined;
      if (!fId) continue;
      const active = fId === state.floorId;
      const done = clearedSet.has(fId);
      const vDone = verifiedSet.has(fId);
      btn.setAttribute('aria-pressed', String(active));
      btn.className = `${FLOOR_PILL_BASE} ${
        active
          ? 'border-accent bg-accent text-accent-contrast'
          : done
            ? 'border-ok/45 bg-ok/10 text-ok'
            : 'border-line bg-panel-soft text-muted hover:border-line-strong hover:text-fg'
      }`;
      const markEl = btn.querySelector<HTMLElement>('[data-role="floor-mark"]');
      if (markEl) markEl.textContent = vDone ? '✓ Lean' : done ? '★' : '';
    }

    if (iconEl) {
      iconEl.innerHTML = renderMonsterSvg(floor.monsterId, state.goals.length, state.cleared);
      if (justHit) {
        iconEl.classList.remove('tower-boss-hit');
        void iconEl.offsetWidth;
        iconEl.classList.add('tower-boss-hit');
      }
    }
    if (titleEl) titleEl.textContent = floor.title[locale];
    if (premiseEl) premiseEl.textContent = floor.premise[locale];
    if (shieldsEl) {
      shieldsEl.textContent = formatTowerGoalProgress(
        tw,
        floor,
        state.goals.length,
        state.played.length,
        state.cleared,
      );
      shieldsEl.className = state.cleared
        ? 'rounded-full border border-ok/45 bg-ok/10 px-3 py-1 font-mono text-xs font-bold text-ok'
        : 'rounded-full border border-warn/40 bg-warn/10 px-3 py-1 font-mono text-xs font-bold text-warn';
    }
    if (allClearedBannerEl) {
      const allCleared = clearedSet.size >= TOWER_FLOORS.length;
      allClearedBannerEl.hidden = !allCleared;
      if (allCleared) {
        allClearedBannerEl.textContent = tw.allClearedBanner(clearedSet.size, TOWER_FLOORS.length);
      }
    }
    if (verifiedBadgeEl) verifiedBadgeEl.hidden = !verifiedSet.has(floor.id);

    if (hypWrapEl && hypEl) {
      hypWrapEl.hidden = state.hypotheses.length === 0;
      hypEl.innerHTML = state.hypotheses
        .map(
          (h) =>
            `<code class="rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-xs text-fg">${escapeHtml(h)}</code>`,
        )
        .join('');
    }

    if (goalEl) {
      goalEl.textContent = state.cleared
        ? '✓ Q.E.D. (no goals)'
        : `⊢ ${state.goals[0]?.target ?? ''}`;
      goalEl.className = state.cleared
        ? 'm-0 mt-1 font-mono text-[clamp(16px,2.2vw,22px)] font-extrabold text-ok'
        : 'm-0 mt-1 font-mono text-[clamp(16px,2.2vw,22px)] font-extrabold text-fg';
    }

    if (queuedEl) {
      const rest = state.goals.slice(1);
      queuedEl.hidden = rest.length === 0;
      queuedEl.innerHTML = rest
        .map(
          (g) =>
            `<span class="rounded-md border border-warn/35 bg-warn/10 px-2 py-0.5 font-mono text-xs text-warn">${escapeHtml(tw.queuedGoalLabel)}: ⊢ ${escapeHtml(g.target)}</span>`,
        )
        .join('');
    }

    if (logEl) {
      logEl.textContent = state.lastEvent ? state.lastEvent.message[locale] : tw.idleLog;
      logEl.className = state.lastEvent
        ? `m-0 mt-2.5 text-xs font-[650] ${state.lastEvent.ok ? 'text-ok' : 'text-err'}`
        : 'm-0 mt-2.5 text-xs font-[650] text-muted';
    }

    if (playedEl) {
      const cardMap = new Map(floor.deck.map((c) => [c.id, c.code]));
      playedEl.textContent =
        state.played.length > 0 ? state.played.map((id) => cardMap.get(id) ?? id).join(' → ') : '—';
    }
    if (undoBtn) undoBtn.disabled = state.played.length === 0;

    if (deckEl) {
      deckEl.innerHTML = renderDeckButtons(floor, locale, state.cleared);
      for (const btn of deckEl.querySelectorAll<HTMLButtonElement>('[data-tower-card]')) {
        const cardId = btn.dataset.towerCard as TowerTacticId | undefined;
        if (!cardId) continue;
        btn.addEventListener('click', () => onPlayCard(cardId));
      }
    }

    if (spellbookEl) {
      const unlocked = store.unlockedCodes();
      spellbookEl.innerHTML =
        unlocked.length > 0
          ? unlocked
              .map(
                (code) =>
                  `<code class="rounded-md border border-ok/35 bg-ok/10 px-2 py-0.5 font-mono text-[11px] font-bold text-ok">${escapeHtml(code)}</code>`,
              )
              .join('')
          : `<span>${escapeHtml(tw.spellbookEmpty)}</span>`;
    }

    const codeText = buildTowerLeanCode(floor, state.played, locale, state.cleared);
    if (codePreEl) {
      const codeEl = codePreEl.querySelector('code');
      if (codeEl) codeEl.textContent = codeText;
    }

    if (victoryEl) {
      victoryEl.hidden = !state.cleared;
      if (state.cleared) {
        const nextFloor = TOWER_FLOORS[floor.level];
        if (victoryTitleEl) {
          victoryTitleEl.textContent = nextFloor
            ? tw.clearedTitle(floor.monsterName[locale])
            : tw.allClearedTitle;
        }
        if (victoryDropEl) {
          victoryDropEl.textContent = nextFloor
            ? tw.unlockedDrop(floor.unlocks[locale])
            : tw.allClearedBody;
        }
        if (nextBtn) {
          nextBtn.hidden = !nextFloor;
          if (nextFloor) {
            nextBtn.textContent = tw.nextFloorCta(nextFloor.level, nextFloor.monsterName[locale]);
          }
        }
      }
    }
  };

  const switchFloor = (floorId: TowerFloorId) => {
    state = createInitialTowerState(floorId);
    floorStartedAt = Date.now();
    if (posterWrap) posterWrap.hidden = true;
    if (posterDl) posterDl.hidden = true;
    if (copyTextStatusEl) copyTextStatusEl.hidden = true;
    if (verifyStatusEl) verifyStatusEl.textContent = '';
    paintAll(false);
  };

  const onPlayCard = (cardId: TowerTacticId) => {
    const wasCleared = state.cleared;
    const prevSteps = state.played.length;
    const next = applyTowerCard(state, cardId);
    state = next;

    if (next.lastEvent?.ok) {
      combo += 1;
      if (next.cleared && !wasCleared) {
        store.markCleared(next.floorId, next.played.length);
        playArcadeSound('victory', sfxEnabled);
        if (arenaEl) launchConfettiBurst(arenaEl);
      } else if (next.played.length > prevSteps) {
        playArcadeSound('gavel', sfxEnabled);
      }
      paintAll(true);
    } else {
      combo = 0;
      playArcadeSound('alert', sfxEnabled);
      paintAll(false);
    }
  };

  for (const btn of floorBtns) {
    const fId = btn.dataset.towerFloor as TowerFloorId | undefined;
    if (!fId) continue;
    btn.addEventListener('click', () => {
      playArcadeSound('click', sfxEnabled);
      switchFloor(fId);
    });
  }

  undoBtn?.addEventListener('click', () => {
    playArcadeSound('click', sfxEnabled);
    state = undoTowerStep(state);
    paintAll(false);
  });

  resetBtn?.addEventListener('click', () => {
    playArcadeSound('click', sfxEnabled);
    combo = 0;
    switchFloor(state.floorId);
  });

  nextBtn?.addEventListener('click', () => {
    const floor = towerFloorById(state.floorId);
    const nextFloor = TOWER_FLOORS[floor.level];
    if (!nextFloor) return;
    playArcadeSound('click', sfxEnabled);
    switchFloor(nextFloor.id);
  });

  toggleCodeBtn?.addEventListener('click', () => {
    if (!codePreEl) return;
    const willOpen = codePreEl.hidden;
    codePreEl.hidden = !willOpen;
    toggleCodeBtn.setAttribute('aria-expanded', String(willOpen));
  });

  posterBtn?.addEventListener('click', () => {
    const floor = towerFloorById(state.floorId);
    const snap = store.snapshot();
    const dataUrl = renderVictoryPosterDataUrl({
      locale,
      mode: 'classic',
      title: `${floor.title[locale]} · ${floor.monsterName[locale]}`,
      rank: computeChallengeRank(state.played.length, floor.parSteps),
      badgesText: `${snap.cleared.length} / ${TOWER_FLOORS.length}F · ${towerLadderRank(snap.cleared.length, locale).tier}`,
      tiersText: snap.verified.includes(floor.id) ? tw.verifiedSeal : '',
      bestChars: buildTowerLeanCode(floor, state.played, locale, state.cleared).length,
      elapsedLabel: formatElapsedMs(Date.now() - floorStartedAt),
      nickname: getArcadeNickname(),
      siteUrl: `${location.origin}/${locale}/challenges`,
    });
    if (!dataUrl) return;
    if (posterImg) posterImg.src = dataUrl;
    if (posterWrap) posterWrap.hidden = false;
    if (posterDl) {
      posterDl.href = dataUrl;
      posterDl.download = `lean-tower-${floor.id}.png`;
      posterDl.hidden = false;
    }
  });

  // 按需显式触发真实 Lean 4.36 编译验证（绝不在页面初始化时后台下载 102 MB）。
  verifyBtn?.addEventListener('click', async () => {
    const floor = towerFloorById(state.floorId);
    if (!state.cleared) {
      if (verifyStatusEl) {
        verifyStatusEl.textContent = tw.verifyErrorStatus;
        verifyStatusEl.className = 'text-xs font-[650] text-warn';
      }
      playArcadeSound('alert', sfxEnabled);
      return;
    }

    const code = buildTowerLeanCode(floor, state.played, locale, true);
    verifyingFloorId = floor.id;
    verifyingCode = code;

    if (verifyStatusEl) {
      verifyStatusEl.textContent = tw.verifyingStatus;
      verifyStatusEl.className = 'text-xs font-[650] text-warn';
    }
    if (leanHostEl) leanHostEl.hidden = false;

    if (leanPanel) {
      leanPanel.setCode(code, { focus: false });
      return;
    }

    const panelMessages = {
      ...messagesFor(locale).playground,
      title: floor.title[locale],
      hint: tw.verifyNote,
    };
    if (leanHostEl) {
      leanHostEl.innerHTML = renderLeanMarkup(locale, 'compact', panelMessages, undefined, {
        heading: false,
      });
    }

    try {
      const { createLeanPanel } = await import('../components/lean-panel');
      if (!leanHostEl) return;
      leanPanel = createLeanPanel(leanHostEl, {
        variant: 'compact',
        code,
        locale,
        autoStart: false,
        startImmediately: true,
        onDiagnostics: (diagnostics) => {
          if (!verifyingFloorId) return;
          const targetFloor = towerFloorById(verifyingFloorId);
          if (!isExerciseSolved(targetFloor.starterCode, verifyingCode, diagnostics)) return;
          store.markVerified(targetFloor.id);
          if (verifyStatusEl) {
            verifyStatusEl.textContent = tw.verifiedSeal;
            verifyStatusEl.className = 'text-xs font-[650] text-ok';
          }
          playArcadeSound('victory', sfxEnabled);
          paintAll(false);
        },
      });
    } catch {
      if (leanHostEl) {
        showEditorLoadFailure(leanHostEl, panelMessages, () => {
          leanPanel = null;
          verifyBtn.click();
        });
      }
    }
  });

  copyTextBtn?.addEventListener('click', async () => {
    const snap = store.snapshot();
    const rank = towerLadderRank(snap.cleared.length, locale);
    const elapsed = formatElapsedMs(Date.now() - floorStartedAt);
    const url = `${location.origin}/${locale}/challenges`;
    const summary = `${tw.shareTextSummary(snap.cleared.length, TOWER_FLOORS.length, rank.tier, elapsed)} ${url}`;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(summary);
      if (copyTextStatusEl) {
        copyTextStatusEl.textContent = tw.copyTextDone;
        copyTextStatusEl.className = 'text-xs font-[650] text-ok';
        copyTextStatusEl.hidden = false;
      }
    } catch {
      if (copyTextStatusEl) {
        copyTextStatusEl.textContent = tw.copyTextFailed;
        copyTextStatusEl.className = 'text-xs font-[650] text-err';
        copyTextStatusEl.hidden = false;
      }
    }
  });

  // 浏览器后退命中 bfcache 时重新对齐顶部楼层按钮高亮与默认未通关层。
  window.addEventListener('pageshow', () => {
    if (state.played.length === 0) {
      state = createInitialTowerState(store.firstPendingFloor());
    }
    paintAll(false);
  });

  paintAll(false);
};
