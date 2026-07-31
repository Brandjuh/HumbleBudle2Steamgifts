#!/usr/bin/env node
/**
 * Plakt het userscript aan elkaar tot één installeerbaar bestand.
 *
 * Geen bundler, geen dependencies: de bronbestanden zijn al losse IIFE's die op
 * `globalThis.HSG` schrijven, dus achter elkaar zetten is genoeg. Dat betekent
 * ook dat `lib/` gedeeld blijft met de tests — één bron van waarheid.
 *
 *   node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist', 'humble-to-steamgifts.user.js');

const BRANCH = 'claude/humble-steamgifts-chrome-plugin-fqr5w4';
// `refs/heads/` is niet optioneel: deze tak heeft een schuine streep in de naam,
// en zonder dat voorvoegsel kan raw.githubusercontent.com de tak niet van het
// pad onderscheiden.
const RAW_URL =
  'https://raw.githubusercontent.com/Brandjuh/HumbleBudle2Steamgifts/' +
  `refs/heads/${BRANCH}/dist/humble-to-steamgifts.user.js`;

/** Volgorde is betekenisvol: elk bestand mag alleen op eerdere leunen. */
const SOURCES = [
  'lib/shared.js',
  'lib/selectors.js',
  'lib/format.js',
  'lib/dom.js',
  'lib/queue.js',
  'userscript/src/store.js',
  'userscript/src/styles.js',
  'userscript/src/panel.js',
  'userscript/src/humble.js',
  'userscript/src/steamgifts.js',
  'userscript/src/boot.js',
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function build() {
  const version = JSON.parse(read('package.json')).version;

  const header = read('userscript/meta.js')
    .replace('{{VERSION}}', version)
    .replace(/\{\{RAW_URL\}\}/g, RAW_URL);

  const body = SOURCES.map((file) => {
    const source = read(file)
      // De Node-export achteraan is alleen voor `node --test`; in een userscript
      // is `module` toch niet gedefinieerd, maar weglaten scheelt ruis.
      .replace(
        /\n\s*if \(typeof module === 'object' && module\.exports\) \{[\s\S]*?\n\s*\}\n/g,
        '\n'
      )
      .trim();
    return `// ${'='.repeat(74)}\n// ${file}\n// ${'='.repeat(74)}\n\n${source}\n`;
  }).join('\n');

  const output = `${header}
/*
 * Gegenereerd door \`node build.js\` — niet met de hand bijwerken.
 * De bron staat in lib/ en userscript/src/.
 */
(function () {
  'use strict';

${body}
})();
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output);

  const lines = output.split('\n').length;
  console.log(`${path.relative(ROOT, OUT)} — v${version}, ${lines} regels`);
}

build();
