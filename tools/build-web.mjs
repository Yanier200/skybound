// Builds the GitHub Pages site in docs/: the same game the desktop build runs,
// minus the soundtrack.
//
// The music is 12 PCM tracks of 126 MB each, which is past GitHub's per-file
// limit and the Pages site limit, so the hosted build has no audio and the
// player falls silent. Packaged builds are unaffected — they ship the WAVs.
import { copyFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'docs');

for (const file of ['index.html', 'styles.css']) copyFileSync(join(ROOT, file), join(SITE, file));
for (const dir of ['js', 'vendor']) {
  rmSync(join(SITE, dir), { recursive: true, force: true });
  cpSync(join(ROOT, dir), join(SITE, dir), { recursive: true });
}

console.log('docs/ updated — open https://yanier200.github.io/skybound/');
