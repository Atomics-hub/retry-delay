import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile, cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, {recursive: true});
const run = (command, args, cwd) => execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
// npm sets its CLI path during npm run. Launch through Node to avoid shell
// quoting and .cmd behavior for Windows paths containing spaces.
const runNpm = (args, cwd) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
  : run('npm', args, cwd);
const [packed] = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--cache', join(artifacts, '.npm-cache'), '--pack-destination', artifacts], root));
assert.deepEqual(packed.files.map(file => file.path).sort(), [
  'LICENSE', 'README.md', 'dist/index.cjs', 'dist/index.d.cts', 'dist/index.d.mts', 'dist/index.mjs', 'package.json',
]);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  assert.equal(Object.keys(manifest[field] ?? {}).length, 0, field);
}
const consumer = await mkdtemp(join(tmpdir(), 'retry-delay-consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(consumer, '.npm-cache'), join(artifacts, packed.filename)], consumer);
await cp(join(root, 'test/checks.mjs'), join(consumer, 'checks.mjs'));
const script = `import assert from 'node:assert/strict';
import * as esm from 'retry-delay';
import {createRequire} from 'node:module';
import {runChecks} from './checks.mjs';
const cjs = createRequire(import.meta.url)('retry-delay');
assert.deepEqual(Object.keys(cjs).sort(), ['MAX_DELAY_MS', 'parseDuration', 'parseRetryAfter', 'retryDelay']);
console.log(JSON.stringify({esm: await runChecks(esm), cjs: await runChecks(cjs), versions: process.versions}));\n`;
await writeFile(join(consumer, 'consumer.mjs'), script);
const checks = JSON.parse(run(process.execPath, ['consumer.mjs'], consumer));
for (const name of ['types.mts', 'types.cts', 'tsconfig.json']) {
  await cp(join(root, 'test', name), join(consumer, name));
}
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
const report = {packed, consumer, checks, types: 'ESM and CommonJS consumers passed', zeroRuntimeDependencies: true};
await writeFile(join(artifacts, 'pack.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({tarball: resolve(artifacts, packed.filename), size: packed.size, unpackedSize: packed.unpackedSize, files: packed.files.length, consumer, types: report.types, checks}));
