// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Split the text into sentences.
 */
export const splitSentences = (text: string, minLength = 20): [string, number, number][] => {
  const alphabets = /([A-Za-z])/g;
  const prefixes = /(Mr|St|Mrs|Ms|Dr)[.]/g;
  const suffixes = /(Inc|Ltd|Jr|Sr|Co)/g;
  const starters =
    /(Mr|Mrs|Ms|Dr|Prof|Capt|Cpt|Lt|He\s|She\s|It\s|They\s|Their\s|Our\s|We\s|But\s|However\s|That\s|This\s|Wherever)/g;
  const acronyms = /([A-Z][.][A-Z][.](?:[A-Z][.])?)/g;
  const websites = /[.](com|net|org|io|gov|edu|me)/g;
  const digits = /([0-9])/g;
  const dots = /\.{2,}/g;

  text = text.replaceAll('\n', ' ');
  text = text.replaceAll(prefixes, '$1<prd>');
  text = text.replaceAll(websites, '<prd>$2');
  text = text.replaceAll(new RegExp(`${digits.source}[.]${digits.source}`, 'g'), '$1<prd>$2');
  text = text.replaceAll(dots, (match) => '<prd>'.repeat(match.length));
  text = text.replaceAll('Ph.D.', 'Ph<prd>D<prd>');
  text = text.replaceAll(new RegExp(`\\s${alphabets.source}[.] `, 'g'), ' $1<prd> ');
  text = text.replaceAll(new RegExp(`${acronyms.source} ${starters.source}`, 'g'), '$1<stop> $2');
  text = text.replaceAll(
    new RegExp(`${alphabets.source}[.]${alphabets.source}[.]${alphabets.source}[.]`, 'g'),
    '$1<prd>$2<prd>$3<prd>',
  );
  text = text.replaceAll(
    new RegExp(`${alphabets.source}[.]${alphabets.source}[.]`, 'g'),
    '$1<prd>$2<prd>',
  );
  text = text.replaceAll(
    new RegExp(` ${suffixes.source}[.] ${starters.source}`, 'g'),
    '$1<stop> $2',
  );
  text = text.replaceAll(new RegExp(` ${suffixes.source}[.]`, 'g'), '$1<prd>');
  text = text.replaceAll(new RegExp(` ${alphabets.source}[.]`, 'g'), '$1<prd>');
  text = text.replaceAll('.”', '”.');
  text = text.replaceAll('."', '".');
  text = text.replaceAll('!"', '"!');
  text = text.replaceAll('?"', '"?');
  text = text.replaceAll('.', '.<stop>');
  text = text.replaceAll('?', '?<stop>');
  text = text.replaceAll('!', '!<stop>');
  text = text.replaceAll('<prd>', '.');

  const split = text.split('<stop>');
  text = text.replaceAll('<stop>', '');

  const sentences: [string, number, number][] = [];
  let buf = '';
  let start = 0;
  let end = 0;
  for (const match of split) {
    const sentence = match.trim();
    if (!sentence) continue;

    buf += ' ' + sentence;
    end += match.length;
    if (buf.length > minLength) {
      sentences.push([buf.slice(1), start, end]);
      start = end;
      buf = '';
    }
  }

  if (buf) {
    sentences.push([buf.slice(1), start, text.length - 1]);
  }

  return sentences;
};
