import { readFile } from 'node:fs/promises';

// Loads a module from web/ the way the browser would, without the browser's import map: the bare `three` import points
// at the vendored copy, and the two modules with no imports of their own (the preset-free leaves that other modules
// pull in) are mapped to their files. `imports` maps any other './name.js' import to a URL, for tests that chain
// modules together. Shared by the tests; the file name keeps it out of `node --test tests/*.test.mjs`.
const WEB = new URL('../web/', import.meta.url);
const LEAVES = ['object-protocol', 'gait'];

export async function load(name, imports = {}) {
  let source = (await readFile(new URL(`${name}.js`, WEB), 'utf8'))
    .replaceAll("from 'three'", `from '${new URL('vendor/three.module.js', WEB).href}'`);
  for (const file of LEAVES) source = source.replaceAll(`from './${file}.js'`, `from '${new URL(`${file}.js`, WEB).href}'`);
  for (const [file, url] of Object.entries(imports)) source = source.replaceAll(`from './${file}.js'`, `from '${url}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
