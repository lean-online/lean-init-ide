/**
 * 练习草稿：按课时把编辑器内容存进 localStorage，刷新后恢复。
 *
 * 只存代码，不做账号同步；写入失败（隐私模式、配额满）时静默忽略。
 */
const PREFIX = 'lean:draft:';

export type Draft = {
  code: string;
  /** 毫秒时间戳，便于以后做「最近练习」入口。 */
  updatedAt: number;
  /** 写入草稿时的模板哈希；课程或挑战改版换题后自动失效，防止旧草稿串题。 */
  starterHash?: string;
};

/** 计算模板代码的轻量 FNV-1a 32 位哈希，用于识别草稿是否仍属于当前版本模板。 */
export const hashStarter = (code: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** 草稿跟代码走，不跟界面语言走：切中英文后应继续看到同一份编辑内容。 */
export const draftKeyFor = (lessonSlug?: string): string =>
  `${PREFIX}${lessonSlug && lessonSlug.length > 0 ? lessonSlug : 'playground'}`;

export const readDraft = (key: string, expectedStarterHash?: string): Draft | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { code, updatedAt, starterHash } = parsed as Partial<Draft>;
    if (typeof code !== 'string' || !Number.isFinite(updatedAt)) return null;
    if (
      expectedStarterHash &&
      typeof starterHash === 'string' &&
      starterHash.length > 0 &&
      starterHash !== expectedStarterHash
    ) {
      return null;
    }
    return {
      code,
      updatedAt: updatedAt as number,
      ...(typeof starterHash === 'string' && starterHash.length > 0 ? { starterHash } : {}),
    };
  } catch {
    return null;
  }
};

export const saveDraft = (key: string, code: string, starterHash?: string): void => {
  try {
    const payload: Draft = {
      code,
      updatedAt: Date.now(),
      ...(starterHash ? { starterHash } : {}),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // 隐私模式下写不了，忽略即可。
  }
};

export const clearDraft = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上。
  }
};
