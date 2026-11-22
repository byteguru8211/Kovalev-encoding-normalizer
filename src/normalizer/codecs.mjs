import { NormalizationError, ErrorCodes } from './errors.mjs';

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function startsWith(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

export function codePointsToString(codePoints) {
  const chunkSize = 8192;
  let result = '';
  for (let start = 0; start < codePoints.length; start += chunkSize) {
    result += String.fromCodePoint(...codePoints.slice(start, start + chunkSize));
  }
  return result;
}

export class Encoding {
  static UTF8 = 'UTF-8';
  static UTF16LE = 'UTF-16LE';
  static UTF16BE = 'UTF-16BE';

  constructor(name, bomDetected, bodyOffset) {
    this.name = name;
    this.bomDetected = bomDetected;
    this.bodyOffset = bodyOffset;
  }
}

export class EncodingDetector {
  static detect(bytes) {
    if (startsWith(bytes, BOM_UTF8)) {
      return new Encoding(Encoding.UTF8, true, BOM_UTF8.length);
    }
    if (startsWith(bytes, BOM_UTF16LE)) {
      return new Encoding(Encoding.UTF16LE, true, BOM_UTF16LE.length);
    }
    if (startsWith(bytes, BOM_UTF16BE)) {
      return new Encoding(Encoding.UTF16BE, true, BOM_UTF16BE.length);
    }
    return new Encoding(Encoding.UTF8, false, 0);
  }
}

export class Utf16Decoder {
  static decode(bytes, offset, littleEndian) {
    const length = bytes.length - offset;
    if (length % 2 !== 0) {
      throw new NormalizationError(
        ErrorCodes.ODD_UTF16_LENGTH,
        `UTF-16 body has odd byte length ${length}; code units must be 2 bytes`,
      );
    }
    const units = [];
    for (let position = offset; position < bytes.length; position += 2) {
      const low = littleEndian ? bytes[position] : bytes[position + 1];
      const high = littleEndian ? bytes[position + 1] : bytes[position];
      units.push((high << 8) | low);
    }
    return Utf16Decoder.#fromCodeUnits(units, offset);
  }

  static #fromCodeUnits(units, byteOffset) {
    const codePoints = [];
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = units[index + 1];
        if (next === undefined || next < 0xdc00 || next > 0xdfff) {
          throw new NormalizationError(
            ErrorCodes.INVALID_SURROGATE,
            `Lone high surrogate U+${unit.toString(16).padStart(4, '0').toUpperCase()} at byte ${byteOffset + index * 2}`,
          );
        }
        codePoints.push(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new NormalizationError(
          ErrorCodes.INVALID_SURROGATE,
          `Lone low surrogate U+${unit.toString(16).padStart(4, '0').toUpperCase()} at byte ${byteOffset + index * 2}`,
        );
      } else {
        codePoints.push(unit);
      }
    }
    return codePointsToString(codePoints);
  }
}

export class StrictUtf8Decoder {
  static decode(bytes, offset) {
    const codePoints = [];
    let position = offset;
    while (position < bytes.length) {
      const lead = bytes[position];
      let needed;
      let codePoint;
      let minimum;

      if (lead <= 0x7f) {
        codePoints.push(lead);
        position += 1;
        continue;
      } else if (lead >= 0xc2 && lead <= 0xdf) {
        needed = 1;
        codePoint = lead & 0x1f;
        minimum = 0x80;
      } else if (lead >= 0xe0 && lead <= 0xef) {
        needed = 2;
        codePoint = lead & 0x0f;
        minimum = 0x800;
      } else if (lead >= 0xf0 && lead <= 0xf4) {
        needed = 3;
        codePoint = lead & 0x07;
        minimum = 0x10000;
      } else {
        throw StrictUtf8Decoder.#error(position, lead, 'invalid lead byte');
      }

      for (let step = 1; step <= needed; step += 1) {
        const continuation = bytes[position + step];
        if (continuation === undefined) {
          throw new NormalizationError(
            ErrorCodes.INVALID_UTF8,
            `Truncated UTF-8 sequence at byte ${position}: expected ${needed + 1} bytes, file ends`,
          );
        }
        if (continuation < 0x80 || continuation > 0xbf) {
          throw StrictUtf8Decoder.#error(position + step, continuation, 'invalid continuation byte');
        }
        codePoint = (codePoint << 6) | (continuation & 0x3f);
      }

      if (codePoint < minimum) {
        throw StrictUtf8Decoder.#error(position, lead, 'overlong encoding');
      }
      if (codePoint > 0x10ffff) {
        throw StrictUtf8Decoder.#error(position, lead, 'code point above U+10FFFF');
      }
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        throw StrictUtf8Decoder.#error(position, lead, 'encoded surrogate');
      }
      codePoints.push(codePoint);
      position += needed + 1;
    }
    return codePointsToString(codePoints);
  }

  static #error(position, byte, reason) {
    return new NormalizationError(
      ErrorCodes.INVALID_UTF8,
      `Invalid UTF-8 at byte ${position} (0x${byte.toString(16).padStart(2, '0').toUpperCase()}): ${reason}`,
    );
  }
}
