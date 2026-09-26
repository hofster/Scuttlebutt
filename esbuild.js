const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const context = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  external: ['obsidian', 'child_process', 'os'],
  format: 'cjs',
  target: 'es2018',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(context).then((ctx) => ctx.watch());
} else {
  esbuild.build(context).catch(() => process.exit(1));
}
