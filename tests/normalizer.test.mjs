import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextNormalizer } from '../src/normalizer/pipeline.mjs';
import { NormalizationError, ErrorCodes } from '../src/normalizer/errors.mjs';

const utf8 = (text) => new TextEncoder().encode(text);
const utf16leBytes = (text) => {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes[index * 2] = unit & 0xff;
    bytes[index * 2 + 1] = unit >> 8;
  }
  return bytes;
};
const withBom = (bom, bytes) => {
  const merged = new Uint8Array(bom.length + bytes.length);
  merged.set(bom, 0);
  merged.set(bytes, bom.length);
  return merged;
};

const normalizer = new TextNormalizer();
const BOM_UTF8 = utf8('\uFEFF');
const BOM_UTF16LE = new Uint8Array([0xff, 0xfe]);
const BOM_UTF16BE = new Uint8Array([0xfe, 0xff]);

function assertThrowsCode(code, fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof NormalizationError, `expected NormalizationError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('control case: UTF-16LE "А\\r\\nБ\\r" normalizes to UTF-8 "А\\nБ\\n"', () => {
  const bytes = withBom(BOM_UTF16LE, utf16leBytes('А\r\nБ\r'));
  const result = normalizer.normalizeBytes(bytes);
  assert.equal(result.encoding, 'UTF-16LE');
  assert.equal(result.bomDetected, true);
  assert.equal(result.normalizedText, 'А\nБ\n');
  assert.deepEqual(
    Buffer.from(result.normalizedBytes).equals(Buffer.from([0xd0, 0x90, 0x0a, 0xd0, 0x91, 0x0a])),
    true,
  );
  assert.equal(result.sourceLineEndings.CRLF, 1);
  assert.equal(result.sourceLineEndings.CR, 1);
  assert.equal(result.sourceLineEndings.LF, 0);
  assert.equal(result.codePoints, 5);
  assert.equal(result.normalizedCodePoints, 4);
  assert.equal(result.normalizedBytes[0], 0xd0);
});

test('re-normalization is idempotent', () => {
  const bytes = withBom(BOM_UTF16LE, utf16leBytes('А\r\nБ\r'));
  const first = normalizer.normalizeBytes(bytes);
  const second = normalizer.normalizeBytes(first.normalizedBytes);
  assert.deepEqual(Buffer.from(second.normalizedBytes), Buffer.from(first.normalizedBytes));
  assert.equal(second.encoding, 'UTF-8');
  assert.equal(second.bomDetected, false);
});

test('UTF-8 BOM is detected and stripped', () => {
  const result = normalizer.normalizeBytes(withBom(BOM_UTF8, utf8('привет\rмире')));
  assert.equal(result.encoding, 'UTF-8');
  assert.equal(result.bomDetected, true);
  assert.equal(result.normalizedText, 'привет\nмире');
  assert.equal(result.sourceLineEndings.CR, 1);
});

test('UTF-16BE decodes correctly', () => {
  const text = 'Aй😀';
  const units = [];
  for (let index = 0; index < text.length; index += 1) {
    units.push(text.charCodeAt(index));
  }
  const bytes = new Uint8Array(units.length * 2);
  units.forEach((unit, index) => {
    bytes[index * 2] = unit >> 8;
    bytes[index * 2 + 1] = unit & 0xff;
  });
  const result = normalizer.normalizeBytes(withBom(BOM_UTF16BE, bytes));
  assert.equal(result.encoding, 'UTF-16BE');
  assert.equal(result.normalizedText, 'Aй😀');
  assert.equal(result.codePoints, 3);
});

test('astral plane characters count as one code point', () => {
  const result = normalizer.normalizeBytes(withBom(BOM_UTF16LE, utf16leBytes('😀')));
  assert.equal(result.codePoints, 1);
  assert.deepEqual(Buffer.from(result.normalizedBytes), Buffer.from(utf8('😀')));
});

test('plain strict UTF-8 without BOM passes through with LF stats', () => {
  const result = normalizer.normalizeBytes(utf8('one\ntwo\r\nthree\r'));
  assert.equal(result.encoding, 'UTF-8');
  assert.equal(result.bomDetected, false);
  assert.equal(result.sourceLineEndings.LF, 1);
  assert.equal(result.sourceLineEndings.CRLF, 1);
  assert.equal(result.sourceLineEndings.CR, 1);
  assert.equal(result.normalizedText, 'one\ntwo\nthree\n');
});

test('empty input is valid', () => {
  const result = normalizer.normalizeBytes(new Uint8Array(0));
  assert.equal(result.normalizedText, '');
  assert.equal(result.codePoints, 0);
});

test('odd UTF-16 length gives odd_utf16_length', () => {
  assertThrowsCode(ErrorCodes.ODD_UTF16_LENGTH, () =>
    normalizer.normalizeBytes(withBom(BOM_UTF16LE, new Uint8Array([0x41, 0x04, 0x00]))));
});

test('lone high surrogate gives invalid_surrogate', () => {
  const bytes = withBom(BOM_UTF16LE, new Uint8Array([0x00, 0xd8]));
  assertThrowsCode(ErrorCodes.INVALID_SURROGATE, () => normalizer.normalizeBytes(bytes));
});

test('lone low surrogate gives invalid_surrogate', () => {
  const bytes = withBom(BOM_UTF16LE, new Uint8Array([0x00, 0xdc]));
  assertThrowsCode(ErrorCodes.INVALID_SURROGATE, () => normalizer.normalizeBytes(bytes));
});

test('high surrogate without following low surrogate gives invalid_surrogate', () => {
  const bytes = withBom(BOM_UTF16LE, new Uint8Array([0x00, 0xd8, 0x41, 0x00]));
  assertThrowsCode(ErrorCodes.INVALID_SURROGATE, () => normalizer.normalizeBytes(bytes));
});

test('broken UTF-8 variants give invalid_utf8', () => {
  const cases = {
    'invalid lead 0x80': new Uint8Array([0x80]),
    'invalid lead 0xf5': new Uint8Array([0xf5, 0x80, 0x80, 0x80]),
    'truncated 2-byte': new Uint8Array([0xd0]),
    'bad continuation': new Uint8Array([0xd0, 0x41]),
    'overlong C0 80': new Uint8Array([0xc0, 0x80]),
    'overlong E0 80 80': new Uint8Array([0xe0, 0x80, 0x80]),
    'encoded surrogate EDA080': new Uint8Array([0xed, 0xa0, 0x80]),
    'above U+10FFFF F4908080': new Uint8Array([0xf4, 0x90, 0x80, 0x80]),
    '5-byte-like F8': new Uint8Array([0xf8, 0x88, 0x80, 0x80, 0x80]),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assertThrowsCode(ErrorCodes.INVALID_UTF8, () => normalizer.normalizeBytes(bytes));
    assert.ok(name);
  }
});

test('valid UTF-8 boundaries decode', () => {
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xc2, 0x80])).sourceText, '\u0080');
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xe0, 0xa0, 0x80])).sourceText, '\u0800');
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xed, 0x9f, 0xbf])).sourceText, '\ud7ff');
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xee, 0x80, 0x80])).sourceText, '\ue000');
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xf0, 0x90, 0x80, 0x80])).sourceText, '\u{10000}');
  assert.equal(normalizer.normalizeBytes(new Uint8Array([0xf4, 0x8f, 0xbf, 0xbf])).sourceText, '\u{10FFFF}');
});
