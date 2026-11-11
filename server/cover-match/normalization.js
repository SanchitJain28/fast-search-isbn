import Sanscript from '@indic-transliteration/sanscript';

const indicRuns = /\p{Script=Devanagari}+|\p{Script=Bengali}+|\p{Script=Tamil}+|\p{Script=Malayalam}+/gu;
const scripts = [
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
];
const phonetics = {
  aa: 'a', ee: 'i', ii: 'i', oo: 'u', uu: 'u', ou: 'u', au: 'u', w: 'v',
  shh: 's', sh: 's', ss: 's', chh: 'c', ch: 'c', ck: 'k', kh: 'k', gh: 'g',
  th: 't', dh: 'd', ph: 'f', bh: 'b', z: 'j', y: 'i',
};
const variants = new RegExp(Object.keys(phonetics).join('|'), 'g');

export function unicodeKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u200c\u200d]/gu, '').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

function latinKey(key) {
  const romanized = key.replace(indicRuns, run => {
    const [script] = scripts.find(([, pattern]) => pattern.test(run));
    return Sanscript.t(run, script, 'iast');
  }).normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '');
  if (/\p{L}/u.test(romanized.replace(/\p{Script=Latin}/gu, ''))) return '';
  return romanized.replace(/[^a-z0-9]+/g, ' ').trim();
}

export function titleKeys(value) {
  const unicode = unicodeKey(value);
  const phonetic = latinKey(unicode).replace(variants, variant => phonetics[variant]).replace(/([a-z])\1+/g, '$1');
  return { unicode, phonetic };
}

export function authorKeys(value) {
  const unicode = unicodeKey(value);
  return [unicode.replaceAll(' ', ''), latinKey(unicode).replaceAll(' ', '')];
}

export function checkAuthor(coverAuthor, masterAuthor) {
  if (!coverAuthor[0] || !masterAuthor) return 'unknown';
  const [unicode, latin] = authorKeys(masterAuthor);
  return coverAuthor[0] === unicode || (latin && coverAuthor[1] === latin) ? 'match' : 'different';
}
