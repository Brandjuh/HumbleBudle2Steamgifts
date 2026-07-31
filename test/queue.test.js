'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../lib/shared.js');
require('../lib/format.js');
const HSG = require('../lib/queue.js');

const { STATUS } = HSG;

const game = (name, gamekey = 'ORDER1') => ({
  machineName: name,
  humanName: name.toUpperCase(),
  gamekey,
  keyindex: 0,
  steamAppId: null,
  disallowedCountries: [],
});

const queueOf = (...names) =>
  HSG.addItems(HSG.emptyQueue(), names.map((name) => game(name))).queue;

test('addItems voegt toe en slaat duplicaten over', () => {
  const first = HSG.addItems(HSG.emptyQueue(), [game('a'), game('b')]);
  assert.equal(first.added, 2);

  const second = HSG.addItems(first.queue, [game('b'), game('c')]);
  assert.equal(second.added, 1);
  assert.deepEqual(
    second.queue.items.map((item) => item.machineName),
    ['a', 'b', 'c']
  );
});

test('addItems onderscheidt dezelfde game uit verschillende orders', () => {
  const result = HSG.addItems(HSG.emptyQueue(), [
    game('celeste', 'ORDER1'),
    game('celeste', 'ORDER2'),
  ]);
  assert.equal(result.added, 2);
});

test('makeItem heeft precies de velden die de wachtrij mag bevatten', () => {
  // De wachtrij gaat naar storage.local, dus die staat onversleuteld op schijf.
  // Er mag hier dus nooit een Steam-key in belanden; die hoort in
  // storage.session. Deze test klapt zodra iemand er een veld bij zet.
  const item = HSG.makeItem(game('a'));
  assert.deepEqual(Object.keys(item).sort(), [
    'candidates',
    'disallowedCountries',
    'error',
    'exclusiveCountries',
    'gamekey', // de order-id bij Humble, geen Steam-key
    'giveawayUrl',
    'humanName',
    'id',
    'keyindex',
    'machineName',
    'sgGameId',
    'sgGameName',
    'status',
    'steamAppId',
  ]);
  assert.equal(item.status, STATUS.PENDING);
});

test('removeItem houdt de cursor op hetzelfde item gericht', () => {
  let queue = queueOf('a', 'b', 'c');
  queue = { ...queue, cursor: 2 }; // staat op 'c'
  queue = HSG.removeItem(queue, 'ORDER1:a');
  assert.deepEqual(
    queue.items.map((item) => item.machineName),
    ['b', 'c']
  );
  assert.equal(HSG.currentItem(queue).machineName, 'c');
});

test('removeItem laat de cursor binnen de lijst', () => {
  let queue = queueOf('a');
  queue = { ...queue, cursor: 0 };
  queue = HSG.removeItem(queue, 'ORDER1:a');
  assert.equal(queue.items.length, 0);
  assert.equal(queue.cursor, 0);
});

test('removeItem doet niets bij een onbekend id', () => {
  const queue = queueOf('a', 'b');
  assert.equal(HSG.removeItem(queue, 'onzin').items.length, 2);
});

test('moveItem verplaatst en laat de cursor het item volgen', () => {
  let queue = queueOf('a', 'b', 'c');
  queue = { ...queue, cursor: 1 }; // staat op 'b'
  queue = HSG.moveItem(queue, 'ORDER1:c', -2); // c naar voren
  assert.deepEqual(
    queue.items.map((item) => item.machineName),
    ['c', 'a', 'b']
  );
  assert.equal(HSG.currentItem(queue).machineName, 'b');
});

test('moveItem weigert een verplaatsing buiten de lijst', () => {
  const queue = queueOf('a', 'b');
  assert.deepEqual(
    HSG.moveItem(queue, 'ORDER1:a', -1).items.map((item) => item.machineName),
    ['a', 'b']
  );
  assert.deepEqual(
    HSG.moveItem(queue, 'ORDER1:b', 1).items.map((item) => item.machineName),
    ['a', 'b']
  );
});

test('advance slaat afgeronde en mislukte items over', () => {
  let queue = queueOf('a', 'b', 'c', 'd');
  queue = HSG.updateItem(queue, 'ORDER1:b', { status: STATUS.DONE });
  queue = HSG.updateItem(queue, 'ORDER1:c', { status: STATUS.ERROR });
  queue = { ...queue, cursor: 0, running: true };

  queue = HSG.advance(queue);
  assert.equal(HSG.currentItem(queue).machineName, 'd');
  assert.equal(queue.running, true);
});

test('advance stopt de wachtrij als er niets meer volgt', () => {
  let queue = queueOf('a');
  queue = { ...queue, cursor: 0, running: true };
  queue = HSG.advance(queue);
  assert.equal(HSG.currentItem(queue), null);
  assert.equal(queue.running, false);
});

test('retryItem zet het item terug op pending en richt de cursor erop', () => {
  let queue = queueOf('a', 'b');
  queue = HSG.updateItem(queue, 'ORDER1:a', {
    status: STATUS.ERROR,
    error: 'kapot',
    candidates: [{ id: '1', name: 'x' }],
  });
  queue = { ...queue, cursor: 1 };

  queue = HSG.retryItem(queue, 'ORDER1:a');
  assert.equal(queue.cursor, 0);
  assert.equal(queue.items[0].status, STATUS.PENDING);
  assert.equal(queue.items[0].error, null);
  assert.equal(queue.items[0].candidates, null);
});

test('summarize telt per status', () => {
  let queue = queueOf('a', 'b', 'c', 'd');
  queue = HSG.updateItem(queue, 'ORDER1:a', { status: STATUS.DONE });
  queue = HSG.updateItem(queue, 'ORDER1:b', { status: STATUS.ERROR });
  queue = HSG.updateItem(queue, 'ORDER1:c', { status: STATUS.NEEDS_CHOICE });

  assert.deepEqual(HSG.summarize(queue), {
    total: 4,
    pending: 1,
    filled: 0,
    done: 1,
    error: 1,
    needsChoice: 1,
  });
});

test('isUsableTpk laat alleen bruikbare Steam-keys door', () => {
  assert.equal(HSG.isUsableTpk({ key_type: 'steam' }), true);
  assert.equal(HSG.isUsableTpk({ key_type: 'Steam' }), true);
  assert.equal(HSG.isUsableTpk({ key_type: 'gog' }), false);
  assert.equal(HSG.isUsableTpk({ key_type: 'steam', is_expired: true }), false);
  assert.equal(HSG.isUsableTpk({ key_type: 'steam', is_gift: true }), false);
  assert.equal(HSG.isUsableTpk(null), false);
});

test('normalizeAppId vangt de wisselende types van Humble af', () => {
  assert.equal(HSG.normalizeAppId(367520), 367520);
  assert.equal(HSG.normalizeAppId('367520'), 367520);
  assert.equal(HSG.normalizeAppId(0), null);
  assert.equal(HSG.normalizeAppId(null), null);
  assert.equal(HSG.normalizeAppId(''), null);
  assert.equal(HSG.normalizeAppId('onzin'), null);
});

test('redact houdt keys uit logregels', () => {
  assert.equal(
    HSG.redact('key is ABCDE-12345-FGHIJ klaar'),
    'key is <key verborgen> klaar'
  );
});
