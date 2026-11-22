#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { TextNormalizer } from '../src/normalizer/pipeline.mjs';
import { NormalizationError } from '../src/normalizer/errors.mjs';

const USAGE = `Usage:
  node bin/normalize.mjs --input <file> --output <file> [--report <file>]
  node bin/normalize.mjs --manifest <jobs.json> --output-dir <dir> [--report <file>]

manifest format: [{"input": "/abs/path", "name": "original.txt", "output": "normalized.txt"}]
Exit codes: 0 success, 2 invalid input (encoding error), 1 internal error.
`;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument ${token}`);
    }
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const normalizer = new TextNormalizer();
  const report = { topic: '27', generatedAt: new Date().toISOString(), files: [] };

  let tasks;
  let perFileOutputDir;
  if (args.manifest) {
    if (!args['output-dir']) throw new Error('--manifest requires --output-dir');
    perFileOutputDir = args['output-dir'];
    await mkdir(perFileOutputDir, { recursive: true });
    const entries = JSON.parse(await readFile(args.manifest, 'utf8'));
    tasks = entries.map((entry) => ({
      input: entry.input,
      name: entry.name,
      output: path.join(perFileOutputDir, entry.output),
    }));
  } else if (args.input) {
    if (!args.output) throw new Error('--input requires --output');
    perFileOutputDir = path.dirname(args.output);
    tasks = [{ input: args.input, name: path.basename(args.input), output: args.output }];
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  try {
    for (const task of tasks) {
      const bytes = new Uint8Array(await readFile(task.input));
      const result = normalizer.normalizeBytes(bytes);
      await writeFile(task.output, result.normalizedBytes);
      report.files.push({
        input: task.name,
        output: path.basename(task.output),
        ...result.toReportEntry(),
      });
    }
  } catch (error) {
    if (error instanceof NormalizationError) {
      process.stderr.write(`${JSON.stringify(error.toJSON())}\n`);
      process.exit(2);
    }
    throw error;
  }

  const reportPath = args.report ?? path.join(perFileOutputDir, 'encoding-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: 'internal_error', message: String(error?.message ?? error) })}\n`);
  process.exit(1);
});
