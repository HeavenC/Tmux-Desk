const fs = require('node:fs/promises');
const path = require('node:path');

const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const webappSource = path.join(projectRoot, 'src', 'webapp');
const outputDirectory = path.join(projectRoot, 'webapp-dist');
const assetsDirectory = path.join(outputDirectory, 'assets');

async function buildWebapp() {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(assetsDirectory, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(webappSource, 'app.js')],
    bundle: true,
    outfile: path.join(assetsDirectory, 'app.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    sourcemap: true,
  });

  await Promise.all([
    fs.copyFile(path.join(webappSource, 'index.html'), path.join(outputDirectory, 'index.html')),
    fs.copyFile(path.join(webappSource, 'styles.css'), path.join(assetsDirectory, 'styles.css')),
    fs.copyFile(
      path.join(projectRoot, 'src', 'shared', 'apple-tokens.css'),
      path.join(assetsDirectory, 'apple-tokens.css'),
    ),
    fs.copyFile(
      path.join(projectRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
      path.join(assetsDirectory, 'xterm.css'),
    ),
  ]);
}

buildWebapp().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
