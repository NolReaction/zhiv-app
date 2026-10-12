import type { WorldHelpTopic } from "./world-help-content";

type SearchWord = { raw: string; stem: string };
export type WorldHelpSearchResult = {
  results: readonly WorldHelpTopic[];
  status: "all" | "matches" | "frequent" | "short" | "empty";
};

const frequentTopicIds = ["start", "resources", "production", "construction", "resident-orders", "saving"];
const stopWords = new Set(["а", "в", "во", "где", "и", "или", "из", "к", "как", "ли", "мне", "могу", "мой", "моя", "мы", "на", "не", "нет", "но", "о", "от", "по", "под", "про", "почему", "получается", "с", "со", "у", "что", "это", "я", "пожалуйста", "хочу", "расскажи", "подскажи", "посмотреть"]);

function normalizeSearch(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

/** Keep the original word too: an unfinished query may resemble a Russian ending. */
function stemWord(word: string): string {
  if (word.length < 4 || /\d/.test(word)) return word;
  return word.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|ией|ий|ый|ой|ей|ая|яя|ое|ее|ые|ие|ов|ев|ах|ях|ам|ям|ом|ем|ую|юю|ию|ия|ья|ться|ть|ешь|ете|ют|ут|ет|ит|ы|и|а|я|у|ю|е|о|ь)$/u, "").replace(/ь$/u, "");
}

const aliases = new Map(Object.entries({
  дерев: "древесин", дерево: "древесин", уху: "уха", досок: "доск", камен: "камн", крафт: "производств", изготов: "производств",
  готовк: "готов", приготов: "готов", приготовлен: "готов", приготовление: "готов",
  вар: "готов", вари: "готов", свар: "готов", свари: "готов", варк: "готов",
  построи: "строи", постро: "строи", стройк: "строи", строительств: "строи",
  бабк: "монет", денеж: "монет", деньг: "монет", заработат: "заработ",
  склад: "кладов", кладовая: "кладов", кладов: "кладов",
  корм: "накорм", кормлен: "накорм", накорм: "накорм", покорм: "накорм",
  кушат: "еда", куш: "еда", поест: "еда", ест: "еда",
  хват: "нехват", хвата: "нехват", хватает: "нехват", нехватк: "нехват", нехват: "нехват",
  удочек: "удочк", крючк: "крючок", рыбк: "рыб", друзей: "друз", друг: "друз",
  завис: "зависл", зависл: "зависл", залагал: "зависл",
}));

function wordTokens(value: string): string[] {
  return normalizeSearch(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function words(tokens: readonly string[]): SearchWord[] {
  return tokens.filter(word => !stopWords.has(word)).map(raw => {
    const stem = stemWord(raw);
    return { raw, stem: aliases.get(stem) ?? stem };
  });
}

/** One missed/extra/wrong letter or adjacent transposition; numbers remain exact. */
function isNearWord(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5 || /\d/.test(a + b) || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function matchWeight(term: SearchWord, candidate: SearchWord): number {
  if (term.raw === candidate.raw) return 4;
  if (term.stem === candidate.stem) return 3;
  if (/\d/.test(term.raw + candidate.raw)) return 0;
  if (term.raw.length >= 2 && candidate.raw.startsWith(term.raw)) return 2;
  if (term.stem.length >= 3 && candidate.stem.startsWith(term.stem)) return 2;
  if (candidate.stem.length >= 5 && term.stem.length - candidate.stem.length <= 3 && term.stem.startsWith(candidate.stem)) return 2;
  return isNearWord(term.raw, candidate.raw) || isNearWord(term.stem, candidate.stem) ? 1 : 0;
}

function frequentTopics(topics: readonly WorldHelpTopic[]): readonly WorldHelpTopic[] {
  const frequent = frequentTopicIds.flatMap(id => topics.filter(topic => topic.id === id));
  return frequent.length ? frequent : topics.slice(0, 6);
}

/** Local search only; unknown meaningful words must not silently turn into unrelated answers. */
export function searchWorldHelpWithStatus(topics: readonly WorldHelpTopic[], query: string): WorldHelpSearchResult {
  if (!query.trim()) return { results: topics, status: "all" };
  const tokens = wordTokens(query.slice(0, 100));
  if (!tokens.length) return { results: [], status: "empty" };
  const terms = [...new Map(words(tokens).map(word => [word.stem, word])).values()];
  if (!terms.length) return { results: frequentTopics(topics), status: "frequent" };
  if (terms.every(term => term.raw.length < 2 && !/\d/.test(term.raw))) return { results: frequentTopics(topics), status: "short" };
  const results = topics.map((topic, index) => {
    const fields = [
      { text: topic.title, weight: 8 },
      { text: topic.keywords, weight: 6 },
      { text: topic.summary, weight: 4 },
      { text: [...(topic.paragraphs ?? []), ...(topic.steps ?? []), topic.note ?? ""].join(" "), weight: 1 },
    ].map(field => ({ tokens: words(wordTokens(field.text)), weight: field.weight }));
    const scores = terms.map(term => Math.max(0, ...fields.map(field =>
      field.weight * Math.max(0, ...field.tokens.map(candidate => matchWeight(term, candidate))))));
    return { topic, index, score: scores.every(Boolean) ? scores.reduce((sum, score) => sum + score, 0) : 0 };
  }).filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(result => result.topic);
  return { results, status: results.length ? "matches" : "empty" };
}

export function searchWorldHelp(topics: readonly WorldHelpTopic[], query: string): readonly WorldHelpTopic[] {
  return searchWorldHelpWithStatus(topics, query).results;
}
