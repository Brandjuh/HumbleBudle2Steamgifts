'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../lib/shared.js');
const HSG = require('../lib/format.js');

test('formatSteamGiftsDate levert het formaat dat SteamGifts verwacht', () => {
  // MMM d, yyyy h:mm a — een afwijkend formaat wordt stil genegeerd door SG.
  assert.equal(
    HSG.formatSteamGiftsDate(new Date(2026, 6, 30, 20, 0)),
    'Jul 30, 2026 8:00 PM'
  );
  assert.equal(
    HSG.formatSteamGiftsDate(new Date(2026, 0, 5, 9, 5)),
    'Jan 5, 2026 9:05 AM'
  );
});

test('formatSteamGiftsDate zet middernacht en middag om naar 12', () => {
  assert.equal(
    HSG.formatSteamGiftsDate(new Date(2026, 0, 5, 0, 7)),
    'Jan 5, 2026 12:07 AM'
  );
  assert.equal(
    HSG.formatSteamGiftsDate(new Date(2026, 11, 1, 12, 30)),
    'Dec 1, 2026 12:30 PM'
  );
});

test('computeSchedule telt offset en looptijd bij elkaar op', () => {
  const now = new Date(2026, 6, 30, 12, 0);
  const schedule = HSG.computeSchedule(
    { startOffsetMinutes: 30, durationDays: 3 },
    now
  );
  assert.equal(schedule.startText, 'Jul 30, 2026 12:30 PM');
  assert.equal(schedule.endText, 'Aug 2, 2026 12:30 PM');
});

test('normalizeTitle haalt trademark-tekens weg zonder ze aan het woord te plakken', () => {
  // NFKD zou van ™ een "tm" maken; die moet er eerder uit.
  assert.equal(HSG.normalizeTitle('BioShock™ Infinite'), 'bioshock infinite');
  assert.equal(HSG.normalizeTitle('Sid Meier’s Civilization® VI'), 'sid meier s civilization vi');
});

test('normalizeTitle negeert accenten, hoofdletters en leestekens', () => {
  assert.equal(HSG.normalizeTitle('Pokémon: Déjà-Vu'), HSG.normalizeTitle('pokemon deja vu'));
  assert.equal(HSG.normalizeTitle('  Hollow   Knight  '), 'hollow knight');
});

test('pickGameMatch kiest de exacte titel uit meerdere treffers', () => {
  const rows = [
    { id: '1', name: 'Hollow Knight: Silksong' },
    { id: '2', name: 'Hollow Knight' },
  ];
  const result = HSG.pickGameMatch(rows, 'Hollow Knight');
  assert.equal(result.reason, 'exact');
  assert.equal(result.match.id, '2');
});

test('pickGameMatch neemt het enige resultaat als er geen exacte titel is', () => {
  const rows = [{ id: '7', name: 'Chorus' }];
  const result = HSG.pickGameMatch(rows, 'Chorus: Deluxe Edition');
  assert.equal(result.reason, 'only-result');
  assert.equal(result.match.id, '7');
});

test('pickGameMatch weigert te gokken bij meerdere kandidaten', () => {
  const rows = [
    { id: '1', name: 'Doom' },
    { id: '2', name: 'Doom Eternal' },
  ];
  const result = HSG.pickGameMatch(rows, 'Doom 64');
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 2);
});

test('pickGameMatch meldt netjes dat er niets gevonden is', () => {
  const result = HSG.pickGameMatch([], 'Onbekend Spel');
  assert.equal(result.reason, 'none');
  assert.equal(result.match, null);
});

test('pickGameMatch negeert rijen zonder id of naam', () => {
  const rows = [{ id: null, name: 'Kapot' }, { id: '3', name: 'Celeste' }];
  const result = HSG.pickGameMatch(rows, 'Celeste');
  assert.equal(result.match.id, '3');
});

// --- keys-pagina: naam uit een rij vissen -----------------------------------

test('pickRowName kiest de titel en negeert knoplabels en platform', () => {
  assert.equal(
    HSG.pickRowName(['Steam', 'Hollow Knight', 'Reveal your key', '']),
    'Hollow Knight'
  );
});

test('pickRowName laat een Steam-key nooit als titel doorgaan', () => {
  assert.equal(HSG.pickRowName(['ABCDE-12345-FGHIJ', 'Celeste']), 'Celeste');
  assert.equal(HSG.pickRowName(['ABCDE-12345-FGHIJ-KLMNO']), null);
});

test('pickRowName negeert datums, bedragen en losse getallen', () => {
  assert.equal(HSG.pickRowName(['12/03/2026', '$9.99', '3', 'Dead Cells']), 'Dead Cells');
});

test('pickRowName normaliseert witruimte uit de opmaak', () => {
  assert.equal(HSG.pickRowName(['\n  Slay the   Spire \t']), 'Slay the Spire');
});

test('pickRowName geeft null als er niets bruikbaars in de rij staat', () => {
  assert.equal(HSG.pickRowName([]), null);
  assert.equal(HSG.pickRowName(['Steam', 'redeem', '  ', 'a']), null);
});

test('pickRowName weert absurd lange teksten (beschrijvingen, disclaimers)', () => {
  const lang = 'x'.repeat(200);
  assert.equal(HSG.pickRowName([lang, 'Braid']), 'Braid');
});

test('detectPlatform leest het platform uit een icoon-klassenaam', () => {
  assert.equal(HSG.detectPlatform('hb hb-steam'), 'steam');
  assert.equal(HSG.detectPlatform('icon icon-gog large'), 'gog');
  assert.equal(HSG.detectPlatform('platform-epic'), 'epic');
});

test('detectPlatform geeft null bij onbekend — dat is iets anders dan "geen Steam"', () => {
  assert.equal(HSG.detectPlatform('hb hb-chevron-left'), null);
  assert.equal(HSG.detectPlatform(''), null);
  assert.equal(HSG.detectPlatform(null), null);
});

test('detectPlatform herkent het icoon zoals Humble het schrijft', () => {
  // <td class="platform"><i class="hb hb-key hb-steam"></i></td>
  assert.equal(HSG.detectPlatform('hb hb-key hb-steam'), 'steam');
});

test('pickRowName kiest de disclaimer niet die in elke key-rij staat', () => {
  // Deze zin staat in élke rij op /home/keys. Omdat hij langer is dan de meeste
  // speltitels won hij van de titel, waarna alle rijen dezelfde naam kregen en
  // de hele lijst tot één regel samenklapte.
  const disclaimer =
    'Steam will not provide extra giftable copies of games you already own.';
  assert.equal(HSG.pickRowName([disclaimer, 'Dicefolk']), 'Dicefolk');
  assert.equal(HSG.pickRowName([disclaimer]), null);
});

test('looksLikeProse scheidt volzinnen van speltitels', () => {
  assert.equal(HSG.looksLikeProse('Steam will not provide extra copies.'), true);
  assert.equal(HSG.looksLikeProse('S.T.A.L.K.E.R.'), false);
  assert.equal(HSG.looksLikeProse('Mr. Prepper'), false);
  assert.equal(HSG.looksLikeProse('Hollow Knight'), false);
});

test('parseOrderKey haalt de order-sleutel uit een bundellink', () => {
  assert.equal(
    HSG.parseOrderKey('/download?key=5UpZdUyMHhmZxuqa'),
    '5UpZdUyMHhmZxuqa'
  );
  assert.equal(
    HSG.parseOrderKey('https://www.humblebundle.com/downloads?key=AbC123&foo=1'),
    'AbC123'
  );
});

test('parseOrderKey geeft null als er geen sleutel in staat', () => {
  assert.equal(HSG.parseOrderKey('/home/keys'), null);
  assert.equal(HSG.parseOrderKey(''), null);
  assert.equal(HSG.parseOrderKey(null), null);
});

// --- regio: Humble verbiedt, SteamGifts staat toe -----------------------------

test('allowedCountries keert Humbles verbodslijst om', () => {
  const result = HSG.allowedCountries(['NL', 'BE', 'DE', 'BR', 'JP'], ['BR', 'JP']);
  assert.deepEqual(result.allowed, ['NL', 'BE', 'DE']);
  assert.deepEqual(result.blocked, ['BR', 'JP']);
  assert.deepEqual(result.unknown, []);
});

test('allowedCountries meldt codes die SteamGifts niet kent', () => {
  const result = HSG.allowedCountries(['NL', 'BE'], ['BR', 'XX']);
  assert.deepEqual(result.allowed, ['NL', 'BE']);
  assert.deepEqual(result.unknown.sort(), ['BR', 'XX']);
});

test('allowedCountries trekt zich niets aan van hoofdletters en spaties', () => {
  const result = HSG.allowedCountries(['nl', ' BE '], ['be']);
  assert.deepEqual(result.allowed, ['nl']);
  assert.deepEqual(result.blocked, ['BE']);
});

test('allowedCountries laat alles toe als Humble niets verbiedt', () => {
  const result = HSG.allowedCountries(['NL', 'BE'], []);
  assert.deepEqual(result.allowed, ['NL', 'BE']);
  assert.deepEqual(result.blocked, []);
});

test('allowedCountries op een echte Humble-lijst houdt Europa over', () => {
  // Fragment van wat Humble voor zo'n key doorgeeft.
  const humble = ['BR', 'CN', 'JP', 'KR', 'IN', 'ZA', 'AU', 'NZ', 'MX', 'RU'];
  const steamgifts = ['NL', 'BE', 'DE', 'FR', 'GB', 'US', 'BR', 'CN', 'JP', 'AU'];
  const result = HSG.allowedCountries(steamgifts, humble);
  assert.deepEqual(result.allowed, ['NL', 'BE', 'DE', 'FR', 'GB', 'US']);
  assert.deepEqual(result.blocked, ['BR', 'CN', 'JP', 'AU']);
  // KR, IN, ZA, NZ, MX en RU staan niet in de SteamGifts-lijst van deze test.
  assert.deepEqual(result.unknown.sort(), ['IN', 'KR', 'MX', 'NZ', 'RU', 'ZA']);
});
