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

test('parseCountryCode haalt de landcode uit data-name', () => {
  // SteamGifts identificeert landen met een eigen nummer; de ISO-code staat
  // alleen in data-name, als laatste woord.
  assert.equal(HSG.parseCountryCode('Netherlands NL'), 'NL');
  assert.equal(HSG.parseCountryCode('Brazil BR'), 'BR');
  assert.equal(HSG.parseCountryCode('Bosnia and Herzegovina BA'), 'BA');
});

test('parseCountryCode overleeft accenten, punten en haken in de naam', () => {
  assert.equal(HSG.parseCountryCode('Åland Islands AX'), 'AX');
  assert.equal(HSG.parseCountryCode('Côte d’Ivoire CI'), 'CI');
  assert.equal(HSG.parseCountryCode('Cocos [Keeling] Islands CC'), 'CC');
  assert.equal(HSG.parseCountryCode('U.S. Minor Outlying Islands UM'), 'UM');
  assert.equal(HSG.parseCountryCode('São Tomé and Príncipe ST'), 'ST');
});

test('parseCountryCode geeft null als er geen code op het eind staat', () => {
  // De groepenlijst gebruikt hetzelfde attribuut voor Steam-groepsnamen.
  assert.equal(HSG.parseCountryCode('Traders Guild'), null);
  assert.equal(HSG.parseCountryCode('My Whitelist'), null);
  assert.equal(HSG.parseCountryCode(''), null);
  assert.equal(HSG.parseCountryCode(null), null);
});

// Zoals SteamGifts ze op /giveaways/new aanbiedt: nummer als id, code in de naam.
const sgCountries = [
  { id: '160', code: 'NL' },
  { id: '21', code: 'BE' },
  { id: '86', code: 'DE' },
  { id: '30', code: 'BR' },
  { id: '114', code: 'JP' },
];

test('allowedCountries keert Humbles verbodslijst om naar SteamGifts-ids', () => {
  const result = HSG.allowedCountries(sgCountries, ['BR', 'JP']);
  assert.deepEqual(result.allowedIds, ['160', '21', '86']);
  assert.deepEqual(result.blockedCodes, ['BR', 'JP']);
  assert.deepEqual(result.unknownCodes, []);
});

test('allowedCountries meldt codes die SteamGifts niet kent', () => {
  const result = HSG.allowedCountries(sgCountries, ['BR', 'XX']);
  assert.deepEqual(result.allowedIds, ['160', '21', '86', '114']);
  assert.deepEqual(result.unknownCodes, ['XX']);
});

test('allowedCountries trekt zich niets aan van hoofdletters en spaties', () => {
  const result = HSG.allowedCountries([{ id: '30', code: ' br ' }], ['Br']);
  assert.deepEqual(result.allowedIds, []);
  assert.deepEqual(result.blockedCodes, ['BR']);
});

test('allowedCountries laat alles toe als Humble niets verbiedt', () => {
  const result = HSG.allowedCountries(sgCountries, []);
  assert.equal(result.allowedIds.length, 5);
  assert.deepEqual(result.blockedCodes, []);
});

test('allowedCountries staat een land zonder leesbare code toe, maar meldt het', () => {
  const result = HSG.allowedCountries([{ id: '999', code: null }], ['BR']);
  assert.deepEqual(result.allowedIds, ['999']);
  assert.deepEqual(result.unmapped, ['999']);
});

test('allowedCountries: exclusive_countries is leidend en sluit de rest uit', () => {
  // Humbles tweede veld: de key werkt ALLEEN in deze landen. Wie er niet naar
  // kijkt zet zo'n key open voor de hele wereld.
  const result = HSG.allowedCountries(sgCountries, [], ['NL', 'BE']);
  assert.deepEqual(result.allowedIds, ['160', '21']);
  assert.deepEqual(result.blockedCodes.sort(), ['BR', 'DE', 'JP']);
});

test('allowedCountries telt disallowed bovenop exclusive', () => {
  const result = HSG.allowedCountries(sgCountries, ['BE'], ['NL', 'BE', 'DE']);
  assert.deepEqual(result.allowedIds, ['160', '86']);
  assert.ok(result.blockedCodes.includes('BE'));
});

test('allowedCountries laat een land zonder code vallen bij een exclusieve key', () => {
  // Zonder leesbare code kunnen we niet vaststellen dát het bij de exclusieve
  // lijst hoort, dus dan valt hij af in plaats van er stilletjes bij te komen.
  const items = [{ id: '999', code: null }, { id: '160', code: 'NL' }];
  assert.deepEqual(HSG.allowedCountries(items, [], ['NL']).allowedIds, ['160']);
  assert.deepEqual(HSG.allowedCountries(items, ['BR']).allowedIds, ['999', '160']);
});

test('allowedCountries op een echte Humble-lijst houdt Europa en de VS over', () => {
  const humble = ['BR', 'CN', 'JP', 'KR', 'IN', 'ZA', 'AU', 'NZ', 'MX', 'RU'];
  const steamgifts = [
    { id: '160', code: 'NL' },
    { id: '86', code: 'DE' },
    { id: '249', code: 'GB' },
    { id: '250', code: 'US' },
    { id: '30', code: 'BR' },
    { id: '47', code: 'CN' },
    { id: '114', code: 'JP' },
    { id: '13', code: 'AU' },
  ];
  const result = HSG.allowedCountries(steamgifts, humble);
  assert.deepEqual(result.allowedIds, ['160', '86', '249', '250']);
  assert.deepEqual(result.blockedCodes, ['BR', 'CN', 'JP', 'AU']);
  // KR, IN, ZA, NZ, MX en RU zitten niet in deze (ingekorte) SteamGifts-lijst.
  assert.deepEqual(result.unknownCodes.sort(), ['IN', 'KR', 'MX', 'NZ', 'RU', 'ZA']);
});

// --- uiterste inwisseldatum ---------------------------------------------------

test('parseExpiry leest een kale datum als UTC-middernacht', () => {
  // Het hoofdgeval: Humble levert meestal "YYYY-MM-DD" zonder tijd.
  const parsed = HSG.parseExpiry('2026-08-15');
  assert.equal(parsed.dateOnly, true);
  assert.equal(parsed.date.toISOString(), '2026-08-15T00:00:00.000Z');
});

test('parseExpiry leest een datetime zonder offset als UTC, niet als lokale tijd', () => {
  // Kaal new Date('2026-08-15T18:30:00') zou lokale tijd geven — een dag verschil
  // is dan zomaar mogelijk.
  const parsed = HSG.parseExpiry('2026-08-15T18:30:00');
  assert.equal(parsed.dateOnly, false);
  assert.equal(parsed.date.toISOString(), '2026-08-15T18:30:00.000Z');
});

test('parseExpiry vertrouwt een expliciete offset', () => {
  assert.equal(HSG.parseExpiry('2026-08-15T18:30:00Z').date.toISOString(), '2026-08-15T18:30:00.000Z');
  assert.equal(HSG.parseExpiry('2026-08-15T20:30:00+02:00').date.toISOString(), '2026-08-15T18:30:00.000Z');
});

test('parseExpiry geeft null bij onbruikbare invoer — liever geen deadline dan een verkeerde', () => {
  assert.equal(HSG.parseExpiry('binnenkort'), null);
  assert.equal(HSG.parseExpiry(''), null);
  assert.equal(HSG.parseExpiry(null), null);
  assert.equal(HSG.parseExpiry(undefined), null);
});

test('safeDeadline rekent naar Pacific-middernacht, ook over de zomertijdgrens', () => {
  // Humble zet keys op wisselende momenten gedurende de expiratiedag uit, in
  // Pacific-tijd; veilig is het begin van die dag daar.
  assert.equal(
    HSG.safeDeadline(HSG.parseExpiry('2026-08-15')).toISOString(),
    '2026-08-15T07:00:00.000Z' // PDT, UTC-7
  );
  assert.equal(
    HSG.safeDeadline(HSG.parseExpiry('2026-01-15')).toISOString(),
    '2026-01-15T08:00:00.000Z' // PST, UTC-8
  );
});

test('safeDeadline laat een exact moment ongemoeid', () => {
  const parsed = HSG.parseExpiry('2026-08-15T18:30:00Z');
  assert.equal(HSG.safeDeadline(parsed).toISOString(), '2026-08-15T18:30:00.000Z');
  assert.equal(HSG.safeDeadline(null), null);
});

const NOW = new Date('2026-08-01T12:00:00Z');
const schedule = (days, deadline) =>
  HSG.computeSchedule({ startOffsetMinutes: 5, durationDays: days }, NOW, deadline);

test('computeSchedule laat de looptijd met rust als er geen deadline is', () => {
  const result = schedule(7, undefined);
  assert.equal(result.cappedBy, null);
  assert.equal(result.impossible, false);
  assert.equal(result.end.toISOString(), '2026-08-08T12:05:00.000Z');
});

test('computeSchedule grijpt niet in bij een ruime deadline', () => {
  const result = schedule(7, new Date('2026-12-01T00:00:00Z'));
  assert.equal(result.cappedBy, null);
  assert.equal(result.end.toISOString(), '2026-08-08T12:05:00.000Z');
});

test('computeSchedule eindigt een week voor de deadline', () => {
  const result = schedule(7, new Date('2026-08-11T00:00:00Z'));
  assert.equal(result.cappedBy, 'deadline');
  assert.equal(result.impossible, false);
  assert.equal(result.end.toISOString(), '2026-08-04T00:00:00.000Z');
});

test('computeSchedule valt terug op één uur als die week niet past', () => {
  const result = schedule(7, new Date('2026-08-04T00:00:00Z'));
  assert.equal(result.cappedBy, 'minimum');
  assert.equal(result.impossible, false);
  assert.equal(result.end.getTime() - result.start.getTime(), 3600000);
});

test('computeSchedule meldt onmogelijk als zelfs dat uur niet meer past', () => {
  assert.equal(schedule(7, new Date('2026-08-01T12:30:00Z')).impossible, true);
  assert.equal(schedule(7, new Date('2026-07-01T00:00:00Z')).impossible, true);
});

test('computeSchedule respecteert de 30-dagengrens van SteamGifts', () => {
  const result = schedule(60, undefined);
  assert.equal(result.cappedBy, 'maxRange');
  assert.equal(result.end.toISOString(), '2026-08-31T12:00:00.000Z');
});

test('deadlineFromTpk gebruikt expiry_date als die er is', () => {
  const result = HSG.deadlineFromTpk({ expiry_date: '2026-08-15' });
  assert.equal(result.source, 'field');
  assert.equal(result.date.toISOString(), '2026-08-15T00:00:00.000Z');
});

test('deadlineFromTpk vist een datum uit de instructietekst als expiry_date ontbreekt', () => {
  const result = HSG.deadlineFromTpk({
    custom_instructions_html: '<p>This key <strong>must be redeemed by August 15, 2026</strong>.</p>',
  });
  assert.equal(result.source, 'derived');
  assert.equal(result.date.toISOString(), '2026-08-15T00:00:00.000Z');
});

test('deadlineFromTpk pikt géén losse datum op die niets met inwisselen te maken heeft', () => {
  // Zonder signaalwoord zou een release- of aanbiedingsdatum als deadline gelden,
  // en een verzonnen deadline is erger dan geen.
  assert.equal(
    HSG.deadlineFromTpk({ custom_instructions_html: '<p>Available since June 1, 2026.</p>' }),
    null
  );
  assert.equal(HSG.deadlineFromTpk({}), null);
  assert.equal(HSG.deadlineFromTpk(null), null);
});

test('deadlineFromTpk kijkt ook naar instructions_html', () => {
  const result = HSG.deadlineFromTpk({
    instructions_html: 'Key expires on March 3, 2027.',
  });
  assert.equal(result.date.toISOString(), '2027-03-03T00:00:00.000Z');
});

test('describeDeadline levert een Engelse regel, met slag om de arm bij een afgeleide datum', () => {
  const hard = HSG.describeDeadline({ date: new Date(Date.UTC(2026, 7, 15)), dateOnly: true, source: 'field' });
  assert.match(hard, /expires 15 August 2026 \(Pacific time\)/);

  const soft = HSG.describeDeadline({ date: new Date(Date.UTC(2026, 7, 15)), dateOnly: true, source: 'derived' });
  assert.match(soft, /appears to expire around/);

  assert.equal(HSG.describeDeadline(null), '');
});

test('storeExpiry en readExpiry overleven de reis door JSON', () => {
  const parsed = HSG.deadlineFromTpk({ expiry_date: '2026-08-15' });
  const stored = JSON.parse(JSON.stringify(HSG.storeExpiry(parsed)));
  const back = HSG.readExpiry(stored);
  assert.equal(back.date.toISOString(), parsed.date.toISOString());
  assert.equal(back.dateOnly, true);
  assert.equal(back.source, 'field');
  assert.equal(HSG.readExpiry(null), null);
});
