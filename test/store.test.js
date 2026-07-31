'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../lib/shared.js');
require('../lib/format.js');
require('../lib/queue.js');

// Tampermonkey's opslag nabootsen. GM_getValue/GM_setValue zijn synchroon, dus
// een simpele Map volstaat en de tests hebben geen browser nodig.
const memory = new Map();
globalThis.GM_getValue = (name, fallback) =>
  memory.has(name) ? memory.get(name) : fallback;
globalThis.GM_setValue = (name, value) => memory.set(name, value);

const HSG = require('../userscript/src/store.js');
const { store } = HSG;

const reset = () => memory.clear();

const game = (name, gamekey = 'ORDER1') => ({
  machineName: name,
  humanName: name.toUpperCase(),
  gamekey,
  keyindex: 0,
  steamAppId: null,
  disallowedCountries: [],
  exclusiveCountries: [],
});

test('instellingen vallen terug op de standaarden en laten zich deels overschrijven', () => {
  reset();
  assert.equal(store.getSettings().durationDays, HSG.DEFAULT_SETTINGS.durationDays);

  store.setSettings({ durationDays: 3 });
  assert.equal(store.getSettings().durationDays, 3);
  // Niet-genoemde velden blijven staan.
  assert.equal(store.getSettings().copies, HSG.DEFAULT_SETTINGS.copies);
});

test('storeRevealResults zet keys apart en metadata in de wachtrij', () => {
  reset();
  const outcome = HSG.storeRevealResults([
    { ...game('celeste'), key: 'AAAAA-BBBBB-CCCCC' },
    { ...game('braid'), key: 'DDDDD-EEEEE-FFFFF' },
  ]);

  assert.equal(outcome.added, 2);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.queue.items.length, 2);
  assert.equal(store.getKey('ORDER1:celeste'), 'AAAAA-BBBBB-CCCCC');

  // De wachtrij zelf mag nooit een key bevatten: die gaat naar schijf.
  assert.equal(JSON.stringify(outcome.queue).includes('AAAAA-BBBBB-CCCCC'), false);
});

test('storeRevealResults zet een mislukt spel op fout in plaats van het te laten vallen', () => {
  reset();
  const outcome = HSG.storeRevealResults([
    { ...game('celeste'), key: 'AAAAA-BBBBB-CCCCC' },
    { ...game('kapot'), error: 'Onthullen mislukt' },
  ]);

  assert.equal(outcome.added, 1);
  assert.equal(outcome.failed, 1);
  const broken = outcome.queue.items.find((item) => item.id === 'ORDER1:kapot');
  assert.equal(broken.status, HSG.STATUS.ERROR);
  assert.equal(broken.error, 'Onthullen mislukt');
  assert.equal(store.getKey('ORDER1:kapot'), null);
});

test('een spel dat eerder mislukte gaat bij een geslaagde poging terug op pending', () => {
  reset();
  HSG.storeRevealResults([{ ...game('celeste'), error: 'Onthullen mislukt' }]);
  assert.equal(store.getQueue().items[0].status, HSG.STATUS.ERROR);

  HSG.storeRevealResults([{ ...game('celeste'), key: 'AAAAA-BBBBB-CCCCC' }]);
  const item = store.getQueue().items[0];
  assert.equal(item.status, HSG.STATUS.PENDING);
  assert.equal(item.error, null);
  assert.equal(store.getKey('ORDER1:celeste'), 'AAAAA-BBBBB-CCCCC');
});

test('keys vervallen na de ingestelde tijd', () => {
  reset();
  store.setSettings({ keyTtlHours: 1 });
  store.putKeys({ 'ORDER1:celeste': 'AAAAA-BBBBB-CCCCC' });
  assert.equal(store.getKey('ORDER1:celeste'), 'AAAAA-BBBBB-CCCCC');

  // Tijdstempel handmatig terugzetten; Tampermonkey bewaart op schijf, dus
  // oude keys moeten vanzelf verdwijnen.
  const secrets = JSON.parse(memory.get('secrets'));
  secrets['ORDER1:celeste'].at = Date.now() - 2 * 3600 * 1000;
  memory.set('secrets', JSON.stringify(secrets));

  assert.equal(store.getKey('ORDER1:celeste'), null);
  assert.deepEqual(store.keyIds(), []);
});

test('forgetKey en clearKeys ruimen alleen de keys op, niet de wachtrij', () => {
  reset();
  HSG.storeRevealResults([
    { ...game('celeste'), key: 'AAAAA-BBBBB-CCCCC' },
    { ...game('braid'), key: 'DDDDD-EEEEE-FFFFF' },
  ]);

  store.forgetKey('ORDER1:celeste');
  assert.equal(store.getKey('ORDER1:celeste'), null);
  assert.equal(store.getKey('ORDER1:braid'), 'DDDDD-EEEEE-FFFFF');
  assert.equal(store.getQueue().items.length, 2);

  store.clearKeys();
  assert.deepEqual(store.keyIds(), []);
  assert.equal(store.getQueue().items.length, 2);
});

test('withQueue accepteert zowel een wachtrij als {queue}', () => {
  reset();
  HSG.storeRevealResults([{ ...game('celeste'), key: 'AAAAA-BBBBB-CCCCC' }]);

  store.withQueue((queue) => ({ ...queue, running: true }));
  assert.equal(store.getQueue().running, true);

  store.withQueue((queue) => ({ queue: { ...queue, running: false } }));
  assert.equal(store.getQueue().running, false);
});

test('een lege of kapotte opslag levert bruikbare standaarden op', () => {
  reset();
  memory.set('queue', 'geen json');
  assert.deepEqual(store.getQueue(), HSG.emptyQueue());
  assert.equal(store.getCatalog(), null);
  assert.deepEqual(store.keyIds(), []);
});
