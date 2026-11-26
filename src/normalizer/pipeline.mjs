import { Encoding, EncodingDetector, Utf16Decoder, StrictUtf8Decoder } from './codecs.mjs';
import { LineEndingNormalizer, countCodePoints } from './line-endings.mjs';

const ZWNBSP = String.fromCharCode(0xfeff);

export class NormalizationResult {
  constructor(fields) {
    Object.assign(this, fields);
  }

  toReportEntry() {
    return {
      encoding: this.encoding,
      bom: this.bomDetected,
      sourceLineEndings: {
        CRLF: this.sourceLineEndings.CRLF,
        CR: this.sourceLineEndings.CR,
        LF: this.sourceLineEndings.LF,
      },
      codePoints: this.codePoints,
      normalizedCodePoints: this.normalizedCodePoints,
      outputEncoding: Encoding.UTF8,
      outputBom: false,
    };
  }
}

export class TextNormalizer {
  normalizeBytes(bytes) {
    const detected = EncodingDetector.detect(bytes);
    let text = this.#decode(bytes, detected);
    // A leading U+FEFF is a BOM/ZWNBSP artifact, not intended content. Strip all of
    // them so the UTF-8 output never begins with EF BB BF; otherwise re-reading the
    // output would detect a BOM again and normalization would not be idempotent.
    let bomCount = 0;
    while (bomCount < text.length && text[bomCount] === ZWNBSP) {
      bomCount += 1;
    }
    if (bomCount > 0) {
      text = text.slice(bomCount);
    }
    const { text: normalizedText, stats } = LineEndingNormalizer.normalize(text);
    const normalizedBytes = new TextEncoder().encode(normalizedText);
    return new NormalizationResult({
      encoding: detected.name,
      bomDetected: detected.bomDetected,
      sourceText: text,
      sourceLineEndings: stats,
      codePoints: countCodePoints(text),
      normalizedText,
      normalizedBytes,
      normalizedCodePoints: countCodePoints(normalizedText),
    });
  }

  #decode(bytes, encoding) {
    switch (encoding.name) {
      case Encoding.UTF8:
        return StrictUtf8Decoder.decode(bytes, encoding.bodyOffset);
      case Encoding.UTF16LE:
        return Utf16Decoder.decode(bytes, encoding.bodyOffset, true);
      case Encoding.UTF16BE:
        return Utf16Decoder.decode(bytes, encoding.bodyOffset, false);
      default:
        throw new Error(`Unsupported encoding ${encoding.name}`);
    }
  }
}
