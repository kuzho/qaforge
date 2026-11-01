import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'msnodesqlv8', 'msnodesqlv8/*'],
  sourcemap: true,
};

const cli = {
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['msnodesqlv8', 'msnodesqlv8/*'],
};

const webview = {
  entryPoints: ['webview/index.tsx'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.css': 'css' },
};

if (watch) {
  for (const cfg of [extension, cli, webview]) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(cli), esbuild.build(webview)]);
  console.log('built');
}
