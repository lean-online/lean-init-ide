/**
 * 挑战区的纯渲染与浏览器挂载。
 *
 * 渲染函数不读 location、不写 localStorage，SSG 与运行时回退共用；
 * 只有 mountChallenge / mountChallenges 里才绑定编辑器、本地战绩与剪贴板，符合 views 层的边界约定。
 */
import { applyChallengeTactic } from '../challenge-action';
import {
  getArcadeNickname,
  getSfxEnabled,
  launchConfettiBurst,
  playArcadeSound,
  setArcadeNickname,
  setSfxEnabled,
} from '../challenge-fx';
import { countGoalTargets } from '../challenge-goal';
import { renderVictoryPosterDataUrl } from '../challenge-poster';
import { ChallengeProgressStore, type ChallengeRecord } from '../challenge-progress';
import {
  challengeBySlug,
  challengePath,
  challengesPath,
  CHALLENGES,
  type Challenge,
} from '../challenges';
import { renderLeanMarkup, showEditorLoadFailure } from '../components/lean-markup';
import { buttonClass, ghostButtonClass, toolbarButtonClass } from '../components/ui';
import { currentMemoryTier, shouldAutoStart } from '../device';
import { draftKeyFor } from '../draft';
import {
  analyzeProofStyle,
  isChallengeSolved,
  solvedChallengeTiers,
  type ChallengeMode,
  type ChallengeSpec,
} from '../exercise';
import { issueUrl } from '../feedback';
import { messagesFor, type Locale } from '../i18n';
import { renderNotFound } from '../page-meta';
import { computeChallengeRank, formatElapsedMs } from '../proof-tower';
import { getAutoStart } from '../settings';
import {
  badgeLabel,
  bindProgressBackup,
  formatCardBadges,
  formatRecordSummary,
  renderProgressBackup,
} from './challenge-progress-ui';
import { escapeHtml } from './html';
import { mountProofTower, renderProofTower } from './proof-tower-ui';

/** 把判题需要的最小结构拼出来，视图不需要知道数据表的其余字段。 */
const challengeSpec = (challenge: Challenge, locale: Locale): ChallengeSpec => ({
  mode: challenge.mode,
  starter: challenge.starter[locale],
  verdict: challenge.verdict,
  requiredConclusion: challenge.requiredConclusion,
  bounty: challenge.bounty,
});

/** 每道题一份独立草稿，避免不同题目的骨架互相覆盖。 */
export const challengeDraftKey = (slug: string): string => draftKeyFor(`challenge-${slug}`);

const playgroundLink = (locale: Locale, slug: string): string =>
  `/${locale}/playground?challenge=${encodeURIComponent(slug)}`;

/** 四大主题游乐区固定顺序，先把最具传播感与 0 MB 互动实验台的展区放前面。 */
const MODE_ORDER: readonly ChallengeMode[] = ['verdict', 'bugfix', 'bounty', 'classic'];

/** 每个展区一套静态 Tailwind 类，保证 JIT 能扫描到。 */
const SECTION_STYLE: Record<ChallengeMode, { frame: string; accent: string; chip: string }> = {
  classic: {
    frame: 'border-accent/40',
    accent: 'text-accent',
    chip: 'border-accent/30 bg-accent-soft text-accent',
  },
  verdict: {
    frame: 'border-warn/40',
    accent: 'text-warn',
    chip: 'border-warn/40 bg-warn/10 text-warn',
  },
  bugfix: {
    frame: 'border-err/35',
    accent: 'text-err',
    chip: 'border-err/35 bg-err/10 text-err',
  },
  bounty: {
    frame: 'border-ok/40',
    accent: 'text-ok',
    chip: 'border-ok/40 bg-ok/10 text-ok',
  },
};

const ACTIVE_VERDICT_CLASS = `${ghostButtonClass} border-warn bg-warn/15 text-fg`;
const SOLVED_CARD_CLASS = 'flex flex-col rounded-xl border border-ok/40 bg-panel-soft p-4';
const DEFAULT_CARD_CLASS = 'flex flex-col rounded-xl border border-line bg-panel-soft p-4';

/**
 * 零基础导览：先说明 Lean 在做什么，再给出「读题 → 看 Goal → 补证明」三步。
 * 列表页默认展开；详情页默认折叠，把首屏让给题面与真实编辑器。
 */
const renderIntro = (locale: Locale, open = true): string => {
  const t = messagesFor(locale).challenges.intro;
  const steps = t.steps
    .map(
      (step) => `
        <li class="rounded-lg border border-line bg-panel-soft p-3">
          <p class="m-0 text-[13px] font-[650]">${escapeHtml(step.title)}</p>
          <p class="mt-1 mb-0 text-xs leading-relaxed text-muted">${escapeHtml(step.text)}</p>
        </li>`,
    )
    .join('');
  return `
    <details data-role="challenge-intro"${open ? ' open' : ''} class="rounded-2xl border border-line bg-panel p-5">
      <summary class="flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center text-sm font-[650]">${escapeHtml(t.title)}</summary>
      <p class="mt-2 mb-0 max-w-[720px] text-sm leading-relaxed text-muted">${escapeHtml(t.body)}</p>
      <ol class="m-0 mt-3 grid list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2 p-0">${steps}</ol>
      <p class="mt-3 mb-0 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-xs leading-relaxed text-fg">${escapeHtml(t.codeNote)}</p>
    </details>`;
};

const challengeCard = (locale: Locale, challenge: Challenge, index: number): string => {
  const t = messagesFor(locale).challenges;
  const style = SECTION_STYLE[challenge.mode];
  return `
    <article data-challenge-slug="${escapeHtml(challenge.slug)}" class="${DEFAULT_CARD_CLASS}">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-1.5">
        <p class="m-0 text-xs uppercase tracking-[0.08em] text-muted">${String(index + 1).padStart(2, '0')}</p>
        <span class="rounded-full border px-2 py-0.5 text-[11px] font-[650] ${style.chip}">${escapeHtml(t.modes[challenge.mode])}</span>
      </div>
      <h3 class="m-0 mb-2 text-[16px] font-bold">${escapeHtml(challenge.title[locale])}</h3>
      <p class="m-0 mb-3 flex-1 text-sm leading-relaxed text-muted">${escapeHtml(challenge.summary[locale])}</p>
      <p data-role="card-badges" class="m-0 mb-1.5 text-xs leading-relaxed text-ok"></p>
      <p data-role="card-best" class="m-0 mb-3 text-xs text-muted" hidden></p>
      <div class="flex flex-wrap gap-2">
        <a class="${buttonClass}" href="${challengePath(locale, challenge.slug)}">${t.cardCta}</a>
        <a class="${ghostButtonClass}" href="${playgroundLink(locale, challenge.slug)}">${t.detail.openInPlayground}</a>
      </div>
    </article>`;
};

export const renderChallenges = (locale: Locale): string => {
  const t = messagesFor(locale).challenges;
  const sections = MODE_ORDER.map((mode) => {
    const items = CHALLENGES.filter((challenge) => challenge.mode === mode);
    if (items.length === 0) return '';
    const style = SECTION_STYLE[mode];
    return `
      <section
        data-challenge-section="${mode}"
        class="rounded-2xl border ${style.frame} bg-panel p-[clamp(14px,2vw,22px)]"
      >
        <header class="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div class="min-w-0">
            <h2 class="m-0 text-[clamp(20px,2.4vw,26px)] tracking-[-0.01em] ${style.accent}">${escapeHtml(t.modes[mode])}</h2>
            <p class="mt-1.5 mb-0 max-w-[680px] text-sm leading-relaxed text-muted">${escapeHtml(t.modeLeads[mode])}</p>
          </div>
          <span class="rounded-full border px-2.5 py-1 text-xs font-[650] ${style.chip}">${escapeHtml(t.modeCount(items.length))}</span>
        </header>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">${items
          .map((challenge, index) => challengeCard(locale, challenge, index))
          .join('')}</div>
      </section>`;
  }).join('');

  return `
    <section class="max-w-[760px]">
      <p class="mt-0 mb-2 text-xs uppercase tracking-[0.12em] text-accent">${t.eyebrow}</p>
      <h1 class="mt-0 mb-4 text-[clamp(28px,4.4vw,42px)] tracking-[-0.02em]">${t.title}</h1>
      <p class="mt-0 mb-0 max-w-[640px] text-[clamp(15px,1.6vw,18px)] leading-relaxed text-muted">${t.lead}</p>
    </section>

    ${renderProofTower(locale)}

    <section class="mt-[clamp(32px,5vw,52px)]">
      <div class="max-w-[760px]">
        <h2 class="m-0 text-[clamp(20px,2.6vw,28px)] tracking-[-0.01em]">${escapeHtml(t.archiveTitle)}</h2>
        <p class="mt-1.5 mb-0 text-sm leading-relaxed text-muted">${escapeHtml(t.archiveLead)}</p>
      </div>
      <section
        data-role="challenge-summary"
        class="mt-4 rounded-xl border border-line bg-panel px-4 py-3 text-[13px] font-[650]"
      >
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span data-role="summary-solved">${escapeHtml(t.summary.solved(0, CHALLENGES.length))}</span>
          <span data-role="summary-badges" class="text-muted">${escapeHtml(t.summary.badges(0, 0, 0))}</span>
          <span data-role="summary-pct" class="font-mono text-xs text-accent">${escapeHtml(t.summary.progressPct(0))}</span>
          ${renderProgressBackup(t)}
        </div>
        <div class="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-panel-soft">
          <div data-role="summary-progress-bar" class="h-full rounded-full bg-ok transition-all duration-300" style="width: 0%"></div>
        </div>
      </section>
      <div class="mt-4 max-w-[760px]">${renderIntro(locale, false)}</div>
      <section
        data-role="challenge-list"
        class="mt-5 flex flex-col gap-4"
      >${sections}</section>
    </section>
  `;
};

/** 浏览器挂载列表页：先激活 6 层爬塔天梯，再读取 11 道经典挑战战绩与备份绑定。 */
export const mountChallenges = (root: HTMLElement, locale: Locale): void => {
  mountProofTower(root, locale);

  const t = messagesFor(locale).challenges;
  const store = new ChallengeProgressStore();
  const slugs = CHALLENGES.map((challenge) => challenge.slug);

  const refreshProgress = () => {
    const summary = store.summary(slugs);
    const pct = slugs.length > 0 ? Math.round((summary.solved / slugs.length) * 100) : 0;
    const solvedEl = root.querySelector<HTMLElement>('[data-role="summary-solved"]');
    if (solvedEl) solvedEl.textContent = t.summary.solved(summary.solved, CHALLENGES.length);
    const badgesEl = root.querySelector<HTMLElement>('[data-role="summary-badges"]');
    if (badgesEl) {
      badgesEl.textContent = t.summary.badges(
        summary.badges.automation,
        summary.badges.handcrafted,
        summary.badges['term-mode'],
      );
    }
    const pctEl = root.querySelector<HTMLElement>('[data-role="summary-pct"]');
    if (pctEl) pctEl.textContent = t.summary.progressPct(pct);
    const barEl = root.querySelector<HTMLElement>('[data-role="summary-progress-bar"]');
    if (barEl) barEl.style.width = `${pct}%`;

    for (const card of root.querySelectorAll<HTMLElement>('[data-challenge-slug]')) {
      const slug = card.dataset.challengeSlug;
      const slot = card.querySelector<HTMLElement>('[data-role="card-badges"]');
      const bestEl = card.querySelector<HTMLElement>('[data-role="card-best"]');
      if (!slug || !slot) continue;
      const record = store.get(slug);
      card.className = record.solved ? SOLVED_CARD_CLASS : DEFAULT_CARD_CLASS;
      slot.textContent = formatCardBadges(t, record);
      if (bestEl) {
        const showBest = record.solved && record.bestChars !== null;
        bestEl.hidden = !showBest;
        bestEl.textContent =
          showBest && record.bestChars !== null ? t.cardBestChars(record.bestChars) : '';
      }
    }
  };

  refreshProgress();
  bindProgressBackup(root, t, store, refreshProgress);
};

export const renderChallenge = (locale: Locale, slug: string | undefined): string => {
  const challenge = challengeBySlug(slug);
  if (!challenge) return renderNotFound(locale);

  const index = CHALLENGES.findIndex((item) => item.slug === challenge.slug);
  const prevChallenge = index > 0 ? CHALLENGES[index - 1] : undefined;
  const nextChallenge =
    index >= 0 && index + 1 < CHALLENGES.length ? CHALLENGES[index + 1] : undefined;

  const messages = messagesFor(locale);
  const t = messages.challenges;
  const detail = t.detail;
  const panelMessages = {
    ...messages.playground,
    title: t.editorTitle,
    hint: detail.starterNote,
  };
  const tactics = challenge.tactics
    .map(
      (tactic, tacticIndex) => `
        <div class="rounded-lg border border-line bg-panel-soft p-2.5">
          <button type="button" class="${toolbarButtonClass}" data-tactic-index="${tacticIndex}">${escapeHtml(tactic.label[locale])}</button>
          <p class="mt-1.5 mb-0 text-xs leading-relaxed text-muted">${escapeHtml(tactic.description[locale])}</p>
        </div>`,
    )
    .join('');

  const tacticsBody = `
    <p class="mt-1.5 mb-0 text-xs leading-relaxed text-muted">${detail.tacticsHint}</p>
    <div class="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2">${tactics}</div>
  `;
  const tacticsSectionContent =
    challenge.mode === 'verdict'
      ? `<details data-role="verdict-tactics-disclosure" class="mt-2">
          <summary class="flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center text-xs font-[650] text-muted hover:text-fg">${escapeHtml(detail.verdictTacticsDisclosure)}</summary>
          ${tacticsBody}
        </details>`
      : `<details data-role="tactics-disclosure" class="mt-2">
          <summary class="flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center text-xs font-[650] text-muted hover:text-fg">${escapeHtml(detail.tacticsDisclosure)}</summary>
          ${tacticsBody}
        </details>`;

  const verdictSwitch =
    challenge.mode === 'verdict' && challenge.verdictBranches
      ? `
      <section data-role="verdict-switch" class="mt-4 max-w-[760px] rounded-2xl border border-warn/40 bg-panel-soft p-4">
        <p class="m-0 text-[15px] font-bold text-warn">${escapeHtml(detail.verdictTitle)}</p>
        <p class="mt-1.5 mb-0 text-sm leading-relaxed text-muted">${escapeHtml(detail.verdictHint)}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="${ghostButtonClass}" data-role="verdict-branch" data-branch="true" aria-pressed="false">${escapeHtml(detail.verdictTrue)}</button>
          <button type="button" class="${ghostButtonClass}" data-role="verdict-branch" data-branch="false" aria-pressed="false">${escapeHtml(detail.verdictFalse)}</button>
        </div>
        <p class="mt-2 mb-0 text-xs leading-relaxed text-muted">${escapeHtml(detail.verdictNoSpoiler)}</p>
      </section>`
      : '';

  const modeStyle = SECTION_STYLE[challenge.mode];
  const stampLabel = detail.stampLabels[challenge.mode];
  const nextHref = nextChallenge
    ? challengePath(locale, nextChallenge.slug)
    : challengesPath(locale);
  const nextLabel = nextChallenge
    ? detail.nextChallengeCta(nextChallenge.title[locale])
    : detail.allClearedCta;

  return `
    <section data-role="challenge" class="pb-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <a class="inline-flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 items-center text-[13px] text-muted no-underline hover:text-accent" href="${challengesPath(locale)}">${detail.back}</a>
        <div data-role="arcade-hud" class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border px-2.5 py-1 text-xs font-[650] ${modeStyle.chip}">${escapeHtml(t.modes[challenge.mode])}</span>
          <span data-role="challenge-timer" class="rounded-full border border-line bg-panel px-2.5 py-1 font-mono text-xs text-muted">${escapeHtml(detail.timerLabel('00:00'))}</span>
          <button type="button" class="${toolbarButtonClass}" data-role="toggle-sfx" aria-pressed="true">${escapeHtml(detail.sfxOn)}</button>
        </div>
      </div>
      <div class="mt-3 max-w-[760px]">
        <p class="m-0 mb-2 text-xs uppercase tracking-[0.12em] text-accent">${t.eyebrow}</p>
        <h1 class="mt-0 mb-3 text-[clamp(26px,4vw,38px)] tracking-[-0.02em]">${escapeHtml(challenge.title[locale])}</h1>
        <p class="m-0 text-[15px] leading-relaxed text-muted">${escapeHtml(challenge.body[locale])}</p>
        <p data-role="challenge-record" class="mt-2 mb-0 text-xs font-[650] text-ok" hidden></p>
      </div>

      <p data-role="runtime-notice" class="mt-4 mb-0 max-w-[760px] rounded-xl border border-line bg-panel px-3.5 py-2 text-xs leading-relaxed text-muted">${escapeHtml(detail.runtimeNotice)}</p>

      ${verdictSwitch}

      <div class="mt-4 max-w-[760px]">${renderIntro(locale, false)}</div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <a class="${ghostButtonClass}" href="${playgroundLink(locale, challenge.slug)}">${detail.openInPlayground}</a>
        <button class="${ghostButtonClass}" type="button" data-role="copy-link">${detail.copyLink}</button>
        <span data-role="copy-status" role="status" aria-live="polite" class="min-w-0 text-xs text-muted" hidden></span>
      </div>

      <section data-role="challenge-tactics" class="mt-6 rounded-xl border border-line bg-panel p-3.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span data-role="goal-progress" class="text-[13px] font-[650] text-fg">${detail.goalsNone}</span>
          <span class="text-xs uppercase tracking-[0.08em] text-muted">${detail.tacticsTitle}</span>
        </div>
        ${tacticsSectionContent}
      </section>

      <div data-role="challenge-panel" class="mt-3">${renderLeanMarkup(locale, 'full', panelMessages, undefined, { heading: false })}</div>

      <section data-role="challenge-result" class="relative mt-4 overflow-hidden rounded-2xl border border-ok/45 bg-ok/10 p-5 text-ok" aria-live="polite" hidden>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p data-role="result-title" class="m-0 text-[18px] font-bold"></p>
            <p data-role="result-badges" class="m-0 mt-1.5 text-sm"></p>
            <p data-role="result-tiers" class="m-0 mt-1 text-sm" hidden></p>
            <p data-role="result-chars" class="m-0 mt-1 text-sm"></p>
          </div>
          <div class="flex flex-col items-end gap-1.5">
            <span data-role="result-stamp" class="arcade-stamp rounded-lg border-2 border-ok px-3 py-1 font-mono text-xs font-extrabold tracking-wider">${escapeHtml(stampLabel)}</span>
            <span data-role="result-rank" class="rounded-full border border-warn/45 bg-warn/15 px-2.5 py-0.5 font-mono text-xs font-bold text-warn"></span>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <a class="${buttonClass}" data-role="next-challenge-cta" href="${nextHref}">${escapeHtml(nextLabel)}</a>
          <button class="${ghostButtonClass}" type="button" data-role="copy-card">${detail.copyCard}</button>
          <span data-role="result-copy-status" role="status" aria-live="polite" class="min-w-0 text-xs" hidden></span>
        </div>
        <div class="mt-4 rounded-xl border border-ok/30 bg-panel p-3.5 text-fg">
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex min-w-[180px] flex-1 flex-col gap-1 text-xs font-[650] text-muted">
              <span>${escapeHtml(detail.poster.nicknameLabel)}</span>
              <input data-role="poster-nickname" type="text" maxlength="24" placeholder="${escapeHtml(detail.poster.nicknamePlaceholder)}" class="w-full rounded-lg border border-line bg-panel-soft px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none" />
            </label>
            <button type="button" class="${buttonClass}" data-role="generate-poster">${escapeHtml(detail.poster.generateButton)}</button>
            <a class="${ghostButtonClass}" data-role="download-poster" download="lean-proof-card.png" hidden>${escapeHtml(detail.poster.downloadButton)}</a>
          </div>
          <p data-role="poster-status" role="status" aria-live="polite" class="m-0 mt-2 text-xs text-muted" hidden></p>
          <div data-role="poster-preview" class="mt-3" hidden>
            <img data-role="poster-image" alt="${escapeHtml(detail.poster.previewAlt)}" class="max-h-[360px] w-auto rounded-xl border border-line shadow-[var(--shadow)]" />
          </div>
        </div>
      </section>

      <div class="mt-6 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
        <details data-role="hint" class="rounded-xl border border-line bg-panel p-4">
          <summary class="flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center text-[13px] font-[650]">${detail.hintLabel}</summary>
          <p class="mt-2 mb-0 text-sm leading-relaxed text-muted">${escapeHtml(challenge.hint[locale])}</p>
        </details>
        <details data-role="solution" class="rounded-xl border border-line bg-panel p-4">
          <summary class="flex min-h-9 max-[1024px]:min-h-11 touch:min-h-11 cursor-pointer items-center text-[13px] font-[650]">${detail.solutionTitle}</summary>
          <p class="mt-2 mb-2 text-sm leading-relaxed text-muted">${detail.solutionHint}</p>
          <button class="${ghostButtonClass}" type="button" data-role="load-solution">${detail.loadSolution}</button>
          <pre class="mt-3 mb-0 overflow-auto rounded-lg border border-line bg-panel-soft p-3 font-mono text-xs leading-[1.65] text-fg"><code>${escapeHtml(challenge.solution[locale])}</code></pre>
        </details>
      </div>

      <nav data-role="challenge-nav" class="mt-6 flex flex-wrap items-center justify-between gap-2">
        ${prevChallenge ? `<a class="${ghostButtonClass}" data-role="prev-challenge" href="${challengePath(locale, prevChallenge.slug)}">${escapeHtml(detail.prevChallenge)} · ${escapeHtml(prevChallenge.title[locale])}</a>` : '<span></span>'}
        ${nextChallenge ? `<a class="${ghostButtonClass}" data-role="next-challenge" href="${challengePath(locale, nextChallenge.slug)}">${escapeHtml(nextChallenge.title[locale])} ${escapeHtml(detail.nextChallenge)}</a>` : ''}
      </nav>

      <div class="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <span class="mr-1 text-xs text-muted">${escapeHtml(detail.feedbackHint)}</span>
        <a class="${ghostButtonClass}" target="_blank" rel="noopener noreferrer" href="${escapeHtml(
          issueUrl('lesson-bug.yml', {
            title: detail.feedbackIssueTitle(challenge.title[locale]),
            body: `Challenge: ${challenge.slug}\nPath: /${locale}/challenges/${challenge.slug}\n\n`,
          }),
        )}">${escapeHtml(detail.feedbackBug)}</a>
      </div>
    </section>
  `;
};

const setCopyStatus = (el: HTMLElement | null, text: string, ok: boolean) => {
  if (!el) return;
  el.textContent = text;
  el.className = `min-w-0 text-xs ${ok ? 'text-ok' : 'text-err'}`;
  el.hidden = false;
};

export const mountChallenge = async (
  root: HTMLElement,
  locale: Locale,
  slug: string | undefined,
): Promise<void> => {
  const challenge = challengeBySlug(slug);
  const panelHost = root.querySelector<HTMLElement>('[data-role="challenge-panel"]');
  if (!challenge || !panelHost) return;

  const t = messagesFor(locale).challenges;
  const progressEl = root.querySelector<HTMLElement>('[data-role="goal-progress"]');
  const timerEl = root.querySelector<HTMLElement>('[data-role="challenge-timer"]');
  const sfxBtn = root.querySelector<HTMLButtonElement>('[data-role="toggle-sfx"]');

  let sfxEnabled = getSfxEnabled();
  const syncSfxButton = () => {
    if (!sfxBtn) return;
    sfxBtn.textContent = sfxEnabled ? t.detail.sfxOn : t.detail.sfxOff;
    sfxBtn.setAttribute('aria-pressed', String(sfxEnabled));
  };
  syncSfxButton();
  sfxBtn?.addEventListener('click', () => {
    sfxEnabled = !sfxEnabled;
    setSfxEnabled(sfxEnabled);
    syncSfxButton();
    if (sfxEnabled) playArcadeSound('click', true);
  });

  const startedAt = Date.now();
  let solvedOnce = false;
  const refreshTimer = () => {
    if (!timerEl) return;
    timerEl.textContent = t.detail.timerLabel(formatElapsedMs(Date.now() - startedAt));
  };
  refreshTimer();

  const branchButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-role="verdict-branch"]'),
  );
  const syncVerdictButtons = (active: 'true' | 'false' | null) => {
    for (const button of branchButtons) {
      const pressed = active !== null && button.dataset.branch === active;
      button.setAttribute('aria-pressed', String(pressed));
      button.className = pressed ? ACTIVE_VERDICT_CLASS : ghostButtonClass;
    }
  };

  const earlyStartEl = panelHost.querySelector<HTMLButtonElement>('[data-role="start"]');
  const earlyStatusEl = panelHost.querySelector<HTMLElement>('[data-role="status"]');
  let startRequested = false;

  const paintGoals = (text: string) => {
    const count = countGoalTargets(text);
    if (progressEl) {
      progressEl.textContent = count > 0 ? t.detail.goalsRemaining(count) : t.detail.goalsNone;
    }
  };
  paintGoals('');

  // Monaco 主包异步加载期间先记下「启动 Lean」点击：低内存设备不会自动启动，
  // 用户看到按钮就点是很自然的动作，不能因为装配还没完成把这次点击吞掉。
  const onEarlyStart = () => {
    startRequested = true;
    if (earlyStartEl) earlyStartEl.disabled = true;
    if (earlyStatusEl) {
      earlyStatusEl.textContent = messagesFor(locale).playground.statusLoading;
      earlyStatusEl.dataset.state = 'loading';
    }
  };
  earlyStartEl?.addEventListener('click', onEarlyStart, { once: true });

  let createLeanPanel: typeof import('../components/lean-panel').createLeanPanel;
  try {
    ({ createLeanPanel } = await import('../components/lean-panel'));
  } catch {
    earlyStartEl?.removeEventListener('click', onEarlyStart);
    if (earlyStartEl) earlyStartEl.disabled = false;
    const panelMessages = {
      ...messagesFor(locale).playground,
      title: t.editorTitle,
      hint: t.detail.starterNote,
    };
    showEditorLoadFailure(panelHost, panelMessages, () => {
      panelHost.innerHTML = renderLeanMarkup(locale, 'full', panelMessages, undefined, {
        heading: false,
      });
      void mountChallenge(root, locale, slug);
    });
    return;
  }
  earlyStartEl?.removeEventListener('click', onEarlyStart);
  if (earlyStartEl) earlyStartEl.disabled = false;

  const store = new ChallengeProgressStore();
  const spec = challengeSpec(challenge, locale);
  const solutionChars = analyzeProofStyle(challenge.solution[locale]).codeChars;
  const existingRecordEl = root.querySelector<HTMLElement>('[data-role="challenge-record"]');
  const resultEl = root.querySelector<HTMLElement>('[data-role="challenge-result"]');
  const resultTitleEl = root.querySelector<HTMLElement>('[data-role="result-title"]');
  const resultBadgesEl = root.querySelector<HTMLElement>('[data-role="result-badges"]');
  const resultTiersEl = root.querySelector<HTMLElement>('[data-role="result-tiers"]');
  const resultCharsEl = root.querySelector<HTMLElement>('[data-role="result-chars"]');
  const resultRankEl = root.querySelector<HTMLElement>('[data-role="result-rank"]');
  const copyCardStatus = root.querySelector<HTMLElement>('[data-role="result-copy-status"]');
  const nicknameInput = root.querySelector<HTMLInputElement>('[data-role="poster-nickname"]');
  const generatePosterBtn = root.querySelector<HTMLButtonElement>('[data-role="generate-poster"]');
  const downloadPosterLink = root.querySelector<HTMLAnchorElement>('[data-role="download-poster"]');
  const posterStatusEl = root.querySelector<HTMLElement>('[data-role="poster-status"]');
  const posterPreviewEl = root.querySelector<HTMLElement>('[data-role="poster-preview"]');
  const posterImageEl = root.querySelector<HTMLImageElement>('[data-role="poster-image"]');

  if (nicknameInput) {
    nicknameInput.value = getArcadeNickname();
    nicknameInput.addEventListener('input', () => setArcadeNickname(nicknameInput.value));
  }

  let shareText = '';
  let latestBadgesText = '';
  let latestTiersText = '';
  let latestBestChars = 0;
  let latestRank = computeChallengeRank(solutionChars, solutionChars);
  let latestElapsed = '00:00';
  let readCode = () => challenge.starter[locale];

  const paintExistingRecord = (record: ChallengeRecord) => {
    if (!existingRecordEl) return;
    const summary = formatRecordSummary(t, record);
    existingRecordEl.hidden = !summary;
    existingRecordEl.textContent = summary ? t.detail.existingRecord(summary) : '';
  };

  const paintResult = (diagnostics: Parameters<typeof isChallengeSolved>[2]) => {
    if (!resultEl) return;
    const code = readCode();
    if (!isChallengeSolved(spec, code, diagnostics)) {
      resultEl.hidden = true;
      shareText = '';
      return;
    }

    const wasHidden = resultEl.hidden;
    const style = analyzeProofStyle(code);
    const tiers = challenge.mode === 'bounty' ? solvedChallengeTiers(spec, code, diagnostics) : [];
    const record = store.recordRun(challenge.slug, {
      badges: style.badges,
      tiers,
      codeChars: style.codeChars,
    });
    paintExistingRecord(record);
    const labels = style.badges.map((badge) => badgeLabel(t, badge));
    const badgeText = labels.length > 0 ? labels.join(' · ') : '—';
    const tierText = record.tiers.map((tier) => t.detail.tierLabels[tier]).join(' · ');
    const best = record.bestChars ?? style.codeChars;
    const rank = computeChallengeRank(style.codeChars, solutionChars);
    latestElapsed = formatElapsedMs(Date.now() - startedAt);
    latestBadgesText = badgeText;
    latestTiersText = tierText;
    latestBestChars = best;
    latestRank = rank;
    refreshTimer();

    if (resultTitleEl) resultTitleEl.textContent = t.detail.solvedTitle;
    if (resultBadgesEl) resultBadgesEl.textContent = t.detail.solvedBadges(badgeText);
    if (resultTiersEl) {
      resultTiersEl.hidden = tierText.length === 0;
      resultTiersEl.textContent = tierText.length > 0 ? t.detail.solvedTiers(tierText) : '';
    }
    if (resultCharsEl) resultCharsEl.textContent = t.detail.bestChars(best);
    if (resultRankEl) resultRankEl.textContent = t.detail.rankLabel(rank);
    shareText = t.detail.shareText(challenge.title[locale], badgeText, best);
    resultEl.hidden = false;

    if (wasHidden && !solvedOnce) {
      solvedOnce = true;
      playArcadeSound('victory', sfxEnabled);
      launchConfettiBurst(resultEl);
    }
  };

  const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
  const panel = createLeanPanel(panelHost, {
    variant: 'full',
    code: challenge.starter[locale],
    locale,
    draftKey: challengeDraftKey(challenge.slug),
    // 不在后台偷偷拉取 102MB：遵循全局自动启动设置 + 内存/省流档位守门。
    autoStart: getAutoStart() && shouldAutoStart(currentMemoryTier(), saveData === true),
    startImmediately: startRequested,
    onGoal: paintGoals,
    onDiagnostics: paintResult,
  });
  readCode = panel.getCode;
  paintExistingRecord(store.get(challenge.slug));

  generatePosterBtn?.addEventListener('click', () => {
    playArcadeSound('click', sfxEnabled);
    const dataUrl = renderVictoryPosterDataUrl({
      locale,
      mode: challenge.mode,
      title: challenge.title[locale],
      rank: latestRank,
      badgesText: latestBadgesText,
      tiersText: latestTiersText,
      bestChars: latestBestChars,
      elapsedLabel: latestElapsed,
      nickname: nicknameInput?.value ?? getArcadeNickname(),
      siteUrl: `${location.origin}${challengePath(locale, challenge.slug)}`,
    });
    if (!dataUrl) {
      setCopyStatus(posterStatusEl, t.detail.poster.unavailable, false);
      return;
    }
    if (posterImageEl) posterImageEl.src = dataUrl;
    if (posterPreviewEl) posterPreviewEl.hidden = false;
    if (downloadPosterLink) {
      downloadPosterLink.href = dataUrl;
      downloadPosterLink.download = `lean-${challenge.slug}.png`;
      downloadPosterLink.hidden = false;
    }
    setCopyStatus(posterStatusEl, t.detail.poster.generated, true);
  });

  const copyCardButton = root.querySelector<HTMLButtonElement>('[data-role="copy-card"]');
  copyCardButton?.addEventListener('click', async () => {
    const url = `${location.origin}${challengePath(locale, challenge.slug)}`;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(`${shareText}\n${url}`);
      setCopyStatus(copyCardStatus, t.detail.copyCardDone, true);
    } catch {
      setCopyStatus(copyCardStatus, t.detail.copyCardFailed, false);
    }
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tactic-index]')) {
    const tactic = challenge.tactics[Number(button.dataset.tacticIndex)];
    if (!tactic) continue;
    button.addEventListener('click', () => {
      refreshTimer();
      // 点击出招卡后读出当前代码，按声明的 action 整段载入或替换 sorry。
      const next = applyChallengeTactic(readCode(), tactic, locale);
      panel.setCode(next, { focus: true });
      if (panelHost.dataset.mode === 'solution') delete panelHost.dataset.mode;
    });
  }

  const initialCode = readCode();
  if (/\btheorem\s+verdict_true\b/.test(initialCode)) syncVerdictButtons('true');
  else if (/\btheorem\s+verdict_false\b/.test(initialCode)) syncVerdictButtons('false');

  for (const button of branchButtons) {
    const branchKey = button.dataset.branch === 'false' ? 'false' : 'true';
    const branch = branchKey === 'false' ? 'falseStarter' : 'trueStarter';
    button.addEventListener('click', () => {
      const starter = challenge.verdictBranches?.[branch];
      if (!starter) return;
      panel.setCode(starter[locale], { focus: true });
      panelHost.dataset.mode = 'starter';
      syncVerdictButtons(branchKey);
    });
  }

  const copyButton = root.querySelector<HTMLButtonElement>('[data-role="copy-link"]');
  const copyStatus = root.querySelector<HTMLElement>('[data-role="copy-status"]');
  copyButton?.addEventListener('click', async () => {
    const url = `${location.origin}${challengePath(locale, challenge.slug)}`;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopyStatus(copyStatus, t.detail.copyLinkDone, true);
    } catch {
      setCopyStatus(copyStatus, t.detail.copyLinkFailed, false);
    }
  });

  root
    .querySelector<HTMLButtonElement>('[data-role="load-solution"]')
    ?.addEventListener('click', () => {
      panel.setCode(challenge.solution[locale], { focus: true });
      // 供 E2E 区分「骨架诊断」与「参考解法诊断」。
      panelHost.dataset.mode = 'solution';
    });
};
