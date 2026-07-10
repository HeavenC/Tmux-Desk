const fs = require('node:fs/promises');
const path = require('node:path');

const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const rendererSource = path.join(projectRoot, 'src', 'renderer');
const outputDirectory = path.join(projectRoot, 'renderer-dist');

async function copy(source, destination) {
  await fs.copyFile(path.join(rendererSource, source), path.join(outputDirectory, destination));
}

async function buildRenderer() {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(rendererSource, 'app.js')],
    bundle: true,
    outfile: path.join(outputDirectory, 'app.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: true,
  });

  await Promise.all([
    copy('index.html', 'index.html'),
    copy('styles.css', 'styles.css'),
    fs.copyFile(
      path.join(projectRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
      path.join(outputDirectory, 'xterm.css'),
    ),
  ]);
}

buildRenderer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
