const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const HAN = /\p{Script=Han}/u;
const STOPWORDS = new Set([
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "的",
  "了",
  "是",
  "在",
  "和",
  "也",
  "就",
  "都",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嗯",
  "哦",
  "么",
  "什么",
  "怎么",
  "怎么样",
  "谁",
  "现在",
  "最近",
  "目前",
  "如今",
  "一般",
  "平时",
  "通常",
  "还是",
  "是不是",
  "帮我",
  "告诉",
  "一下",
  "哪",
  "哪里",
  "哪个",
  "多少",
  "几",
  "有",
  "没有",
  "这",
  "那",
  "这个",
  "那个",
  "一个",
  "还",
  "又",
  "要",
  "会",
  "能",
  "对",
  "把",
  "被",
  "给",
  "跟",
  "让",
  "说",
  "过",
  "着",
  "主人",
  "himawari",
  "the",
  "a",
  "an",
  "is",
  "are",
  "of",
  "to",
  "and",
  "my",
  "i",
]);
const MAXIMUM_TERM_LENGTH = 64;

export function segmentWords(text: string): string[] {
  const words: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text.normalize("NFKC"))) {
    if (!isWordLike) continue;
    const word = segment.toLowerCase().trim();
    if (word.length > 0 && word.length <= MAXIMUM_TERM_LENGTH) words.push(word);
  }
  return words;
}

function hanBigrams(word: string): string[] {
  const characters = [...word];
  if (characters.length < 3 || !characters.every((character) => HAN.test(character))) return [];
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < characters.length; index += 1)
    bigrams.push(`${characters[index]}${characters[index + 1]}`);
  return bigrams;
}

export function indexTerms(text: string): string[] {
  const terms: string[] = [];
  for (const word of segmentWords(text)) {
    terms.push(word);
    terms.push(...hanBigrams(word));
  }
  return terms.slice(0, 512);
}

export function queryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const word of segmentWords(text)) {
    if (STOPWORDS.has(word) || (word.length === 1 && HAN.test(word))) continue;
    terms.add(word);
    for (const bigram of hanBigrams(word)) terms.add(bigram);
  }
  return [...terms];
}
