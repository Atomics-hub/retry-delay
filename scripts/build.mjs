import {mkdir, readFile, writeFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/index.js', root), 'utf8');
const declarations = await readFile(new URL('src/index.d.ts', root), 'utf8');

const pattern = /^export (?:class |const |(?:async )?function\*? )(\w+)/gm;
const exported = [...source.matchAll(pattern)].map((match) => match[1]);
const expected = ['MAX_DELAY_MS', 'parseDuration', 'parseRetryAfter', 'retryDelay'];
if (exported.slice().sort().join(',') !== expected.slice().sort().join(',')) {
  throw new Error('Review build exports: ' + exported.join(','));
}

// The CommonJS build rewrites the builtin imports and nothing else, so only `node:` specifiers are
// allowed — a third-party import would silently become a broken require.
const imports = [...source.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)';$/gm)];
for (const [, , specifier] of imports) {
  if (!specifier.startsWith('node:')) throw new Error('only node: imports are supported, found ' + specifier);
}
if (/^export \{|^export default/m.test(source)) throw new Error('re-exports are not supported by this build');

await mkdir(new URL('dist/', root), {recursive: true});
await writeFile(new URL('dist/index.mjs', root), source);

const commonjs = source
  .replace(/^import\s+(.+?)\s+from\s+'(node:[^']+)';$/gm, (whole, binding, specifier) => {
    // `import {a, b as c}` destructures as `{a, b: c}`; a default import has no braces at all.
    const named = binding.startsWith('{')
      ? binding.replace(/\bas\b/g, ':')
      : binding;
    return `const ${named} = require('${specifier}');`;
  })
  .replace(/^export /gm, '');
await writeFile(new URL('dist/index.cjs', root),
  "'use strict';\n" + commonjs + '\nmodule.exports = {' + exported.join(', ') + '};\n');

for (const extension of ['mts', 'cts']) {
  await writeFile(new URL('dist/index.d.' + extension, root), declarations);
}
