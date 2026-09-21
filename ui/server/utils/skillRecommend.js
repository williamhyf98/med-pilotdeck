/**
 * Query → skill recommendation, scored locally with zero extra model calls.
 *
 * Two things make this harder than a keyword `includes()`:
 *
 * 1. Chinese has no word boundaries. We index CJK text as adjacent-character
 *    bigrams ("战创伤" → "战创", "创伤") and Latin text as whole lowercased
 *    runs. Bigrams buy substring-level recall without shipping a segmentation
 *    dictionary, and a two-character department name ("骨科") lands as a
 *    single high-signal token.
 *
 * 2. Our SKILL.md descriptions share a lot of boilerplate ("当用户……时使用",
 *    "医生视角", "不适用"). Rather than hand-maintaining a Chinese stopword
 *    list that drifts out of date, weights come from IDF computed over the
 *    candidate pool itself: a token present in every skill collapses toward
 *    zero, so the discriminating term in a query is what decides the ranking.
 */

const CJK_RUN = /\p{Script=Han}+/gu;
const LATIN_RUN = /[a-z0-9]+/g;

/** Queries are chat messages; only the opening sentences carry the intent. */
const MAX_QUERY_CHARS = 400;

/**
 * Saturation constant for the score curve. Tuned so one description-level hit
 * on a rare term lands around 0.34 and a query that names the format outright
 * ("导出成PPT") lands around 0.65.
 */
const SATURATION = 5;

const FIELD_WEIGHTS = {
  name: 3,
  department: 2.5,
  slug: 2,
  description: 1,
};

const LATIN_TOKEN = /^[a-z0-9]+$/;

/**
 * Doctors type "PPT", the skill is called "pptx"; "DICOM" vs "dicom" is free
 * but abbreviation-vs-full-name is not. A query token that is a strict prefix
 * of an indexed token counts as a discounted match.
 */
const PREFIX_MIN_LENGTH = 3;
const PREFIX_DISCOUNT = 0.85;

/**
 * IDF alone can't identify function words in a pool this small: "怎么" shows
 * up in 2 of ~16 descriptions, which reads as "rare" and is enough to make
 * "今天天气怎么样" recommend the burn skill. So we drop a short list of
 * bigrams that carry no topical signal. Clinical terms never belong here —
 * "结果", "报告", "方案" stay, because they really do discriminate.
 */
const STOPWORDS = new Set([
  // interrogatives / fillers
  '怎么', '什么', '为什', '么样', '如何', '是否', '要不', '不要', '可以', '需要',
  '这个', '那个', '这份', '那份', '这些', '那些', '请问', '麻烦', '的话', '时候',
  '帮我', '我要', '我想', '给我', '看看', '一个', '一下', '一份', '现在', '目前',
  '以及', '或者', '如果', '但是', '因为', '所以', '我们', '你们', '他们', '还是',
  // SKILL.md frontmatter boilerplate
  '使用', '用户', '当用', '时使', '适用', '不适', '本技', '技能', '不解', '不出',
  // Clinical framing. Every query here is about a patient, so these carry no
  // topical signal — but in a pool this small each lands in exactly one
  // description and IDF reads it as rare. That is what scored "患者胸痛怎么处理"
  // at an identical 0.439 for both 重症 (matched 患者) and 急诊 (matched 胸痛),
  // leaving the winner to an alphabetical tie-break on the skill name.
  '患者', '病人', '病患',
  // English fillers
  'the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'can', 'you',
  'please', 'help', 'need', 'want', 'about', 'into', 'from',
]);

/**
 * Each additional matching term counts for less than the one before it. Ten
 * incidental prose hits shouldn't outrank one hit on a skill's actual name —
 * that is what made "导出成PPT" rank `pdf` above `pptx`.
 */
const MATCH_DECAY = 0.65;

/** Chips below this fraction of the best score are dropped, however many fit. */
const RELATIVE_CUTOFF = 0.7;

/**
 * Default cutoff. Deliberately low: the noise cases ("今天天气怎么样", "帮我一下")
 * don't score 0.2, they score 0 — stopword removal and bigram tokenization
 * already keep small talk out, so a high threshold only ever blocked real
 * queries. A single description-level hit on a rare term lands at ~0.34, and
 * that is a genuine signal worth one chip.
 */
const DEFAULT_MIN_SCORE = 0.25;

/**
 * Pure tie-break, never a score bonus. "写一份病例报告" scores `docx`, `pdf`
 * and `med-case-report` identically — in a clinical product the clinical skill
 * should be the one the doctor sees first.
 */
const SCOPE_RANK = { medical: 0, project: 1, user: 2, builtin: 3 };

function scopeRank(scope) {
  return SCOPE_RANK[scope] ?? SCOPE_RANK.builtin;
}

export function tokenize(text) {
  const tokens = new Set();
  if (typeof text !== 'string' || text.length === 0) return tokens;
  const lowered = text.toLowerCase();

  for (const match of lowered.matchAll(LATIN_RUN)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }

  for (const match of lowered.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * A skill is offered in a project when it is global or explicitly scoped to
 * that project's type. `projectType` stays an opaque string so this keeps
 * working when the two-value enum becomes a registry — nothing here enumerates
 * the known types.
 */
export function isAvailableIn(skill, projectType) {
  if (!projectType) return true;
  const availability = skill?.availability;
  if (!Array.isArray(availability) || availability.length === 0) return true;
  return availability.includes('global') || availability.includes(projectType);
}

function indexSkill(skill) {
  const weights = new Map();
  const fields = [
    [FIELD_WEIGHTS.name, skill?.name],
    [FIELD_WEIGHTS.department, skill?.department],
    [FIELD_WEIGHTS.slug, skill?.slug],
    [FIELD_WEIGHTS.description, skill?.description],
  ];
  for (const [weight, text] of fields) {
    for (const token of tokenize(text)) {
      const previous = weights.get(token);
      if (previous === undefined || previous < weight) weights.set(token, weight);
    }
  }
  const latin = [];
  for (const token of weights.keys()) {
    if (LATIN_TOKEN.test(token)) latin.push(token);
  }
  return { weights, latin };
}

/** Weight this skill gives a query token; 0 when the token doesn't match. */
function weightFor(index, token) {
  const exact = index.weights.get(token);
  if (exact !== undefined) return exact;
  if (token.length < PREFIX_MIN_LENGTH || !LATIN_TOKEN.test(token)) return 0;
  let best = 0;
  for (const candidate of index.latin) {
    if (candidate.length > token.length && candidate.startsWith(token)) {
      const weight = index.weights.get(candidate);
      if (weight > best) best = weight;
    }
  }
  return best * PREFIX_DISCOUNT;
}

/**
 * @param {string} query            raw composer text
 * @param {Array<object>} skills    skill summaries as returned by `skillsList`
 * @param {object} [options]
 * @param {string|null} [options.projectType]  filter to skills offered here
 * @param {number} [options.limit]             max chips to return (default 3)
 * @param {number} [options.minScore]          0..1 cutoff (default 0.25)
 * @returns {Array<{slug,name,description,scope,department,category,score,matchedTerms}>}
 */
export function recommendSkills(query, skills, options = {}) {
  const { projectType = null, limit = 3, minScore = DEFAULT_MIN_SCORE } = options;

  const queryTokens = [...tokenize(String(query ?? '').slice(0, MAX_QUERY_CHARS))]
    .filter((token) => !STOPWORDS.has(token));
  if (queryTokens.length === 0) return [];

  const candidates = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && typeof skill.slug === 'string' && skill.slug.length > 0)
    // A builtin shadowed by a user/project copy would otherwise show up twice.
    .filter((skill) => !skill.overriddenBy)
    .filter((skill) => isAvailableIn(skill, projectType))
    .map((skill) => ({ skill, index: indexSkill(skill) }));
  if (candidates.length === 0) return [];

  const idf = new Map();
  for (const token of queryTokens) {
    let documentFrequency = 0;
    for (const candidate of candidates) {
      if (weightFor(candidate.index, token) > 0) documentFrequency += 1;
    }
    idf.set(
      token,
      documentFrequency === 0 ? 0 : Math.log(1 + candidates.length / documentFrequency),
    );
  }

  const scored = [];
  for (const { skill, index } of candidates) {
    const matched = [];
    for (const token of queryTokens) {
      const weight = weightFor(index, token);
      if (weight <= 0) continue;
      const contribution = weight * (idf.get(token) ?? 0);
      if (contribution <= 0) continue;
      matched.push({ token, contribution });
    }
    if (matched.length === 0) continue;

    matched.sort((left, right) => right.contribution - left.contribution);
    let raw = 0;
    for (let i = 0; i < matched.length; i += 1) {
      raw += matched[i].contribution * MATCH_DECAY ** i;
    }

    // Bounded, monotone in evidence, and independent of query length: a long
    // clinical description shouldn't be penalised for the many words that
    // match nothing, it should just accumulate whatever evidence it carries.
    const score = 1 - Math.exp(-raw / SATURATION);
    if (score < minScore) continue;

    scored.push({
      slug: skill.slug,
      name: skill.name || skill.slug,
      description: skill.description || '',
      scope: skill.scope ?? null,
      department: skill.department ?? null,
      category: skill.category ?? null,
      score: Math.round(score * 1000) / 1000,
      matchedTerms: matched.slice(0, 3).map((entry) => entry.token),
    });
  }
  if (scored.length === 0) return [];

  scored.sort((left, right) => (
    right.score - left.score
    || scopeRank(left.scope) - scopeRank(right.scope)
    || left.name.localeCompare(right.name)
  ));

  // Don't sit a lukewarm third chip next to a confident first one — a wrong
  // suggestion costs more attention than a missing one.
  const cutoff = scored[0].score * RELATIVE_CUTOFF;
  return scored.filter((entry) => entry.score >= cutoff).slice(0, Math.max(1, limit));
}
