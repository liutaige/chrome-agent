// ============================================================================
// Chrome Agent — Build Script (esbuild)
//
// Bundles each entry point into a self-contained file.
// Content script, Background Worker, and Side Panel are all independent bundles.
// ============================================================================

import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const isWatch = process.argv.includes('--watch');

/** Shared config for all extension bundles. */
const baseConfig = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  // Chrome extension sandbox — no node builtins
  external: [],
};

/** Entry points — each produces a single .js file at the output path. */
const entries = [
  { entry: 'src/content/content.ts', out: 'content/content.js' },
  { entry: 'src/background/worker.ts', out: 'background/worker.js' },
  { entry: 'src/sidepanel/sidepanel.ts', out: 'sidepanel/sidepanel.js' },
];

async function build() {
  const start = performance.now();

  for (const { entry, out } of entries) {
    await esbuild.build({
      ...baseConfig,
      entryPoints: [entry],
      outfile: out,
    });
  }

  console.log(`Build done in ${(performance.now() - start).toFixed(0)}ms`);
}

async function watch() {
  const contexts = [];

  for (const { entry, out } of entries) {
    const ctx = await esbuild.context({
      ...baseConfig,
      entryPoints: [entry],
      outfile: out,
    });
    contexts.push(ctx);
  }

  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching for changes...');
}

if (isWatch) {
  watch();
} else {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
