export class LineEndingStats {
  constructor(crlf = 0, cr = 0, lf = 0) {
    this.CRLF = crlf;
    this.CR = cr;
    this.LF = lf;
  }
}

export class LineEndingNormalizer {
  static normalize(text) {
    const stats = new LineEndingStats();
    const parts = [];
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '\r') {
        if (text[index + 1] === '\n') {
          stats.CRLF += 1;
          parts.push('\n');
          index += 2;
        } else {
          stats.CR += 1;
          parts.push('\n');
          index += 1;
        }
      } else if (char === '\n') {
        stats.LF += 1;
        parts.push('\n');
        index += 1;
      } else {
        parts.push(char);
        index += 1;
      }
    }
    return { text: parts.join(''), stats };
  }
}

export function countCodePoints(text) {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}
