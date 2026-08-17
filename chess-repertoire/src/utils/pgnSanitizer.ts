/**
 * Normalizes PGN text before handing it to stricter parsers.
 *
 * Generated repertoire exports can contain dense engine comments after almost
 * every move. Older exports may also contain a stray one-letter token glued to
 * a comment, for example `Rb8 a{SF: ...}`. That token is not legal SAN, so we
 * remove it after stripping comments.
 */
export function sanitizePgnForParser(pgnText: string): string {
  const withoutComments = stripPgnComments(
    pgnText
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
  );

  return withoutComments
    .replace(/^\s*%.*$/gm, '')
    .replace(/\$\d+\b/g, ' ')
    .replace(/(^|[\s(])[a-h](?=\s*(?:\)|\(|\d+\.{1,3}|1-0|0-1|1\/2-1\/2|\*|$))/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripPgnComments(text: string): string {
  let result = '';
  let inBraceComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inBraceComment) {
      if (char === '}') {
        inBraceComment = false;
        result += ' ';
      }
      continue;
    }

    if (char === '{') {
      inBraceComment = true;
      result += ' ';
      continue;
    }

    if (char === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
      continue;
    }

    result += char;
  }

  return result;
}
