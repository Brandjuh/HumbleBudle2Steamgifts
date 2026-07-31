# Humble → SteamGifts

Userscript dat van je Humble-keys SteamGifts-giveaways maakt. Vink spellen aan op
je Humble keys-pagina, het script haalt de keys op en vult per spel het formulier
op `steamgifts.com/giveaways/new` volledig in — inclusief de key. Jij drukt alleen
nog op verzenden.

Meerdere spellen tegelijk aanvinken kan: ze worden daarna één voor één afgewerkt,
elk als een eigen giveaway.

## Installeren

1. Installeer [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Open **[dist/humble-to-steamgifts.user.js](https://raw.githubusercontent.com/Brandjuh/HumbleBudle2Steamgifts/refs/heads/claude/humble-steamgifts-chrome-plugin-fqr5w4/dist/humble-to-steamgifts.user.js)** —
   Tampermonkey biedt het installatiescherm vanzelf aan.
3. Klik op **Installeren**.

Bijwerken gaat vanzelf: het script draagt een `@updateURL`, dus Tampermonkey
haalt periodiek een nieuwe versie op. Handmatig forceren kan via het
Tampermonkey-dashboard → tabblad *Geïnstalleerde userscripts* → **Controleren op
updates**.

> De repository moet **openbaar** zijn, anders kan Tampermonkey het script niet
> anoniem ophalen en werkt de auto-update niet.

## Gebruik

1. Log in op zowel `humblebundle.com` als `steamgifts.com`.
2. Haal op je Humble Choice-maandpagina de spellen op die je wilt weggeven, en ga
   daarna naar `humblebundle.com/home/keys` (of de downloadpagina van die bundel).
3. Elke key-rij krijgt een **Giveaway**-vinkje. Rechtsonder staat een knop die het
   paneel opent; daar staat dezelfde lijst, met de bundelnaam erbij en een
   zoekveld. Zoeken op "July 2026" geeft precies die maand.
4. Klik op **Voeg toe aan wachtrij**. De keys worden opgehaald.
5. Tabblad **Wachtrij** → **Start**. Er opent een SteamGifts-tab met het formulier
   al ingevuld.
6. Controleer, klik op **Review Giveaway** en bevestig. Zodra de giveaway bestaat,
   laadt het script het volgende spel in.

Herhaal stap 6 tot de wachtrij leeg is. Zet je *Automatisch verzenden* aan, dan
drukt het script zelf op de knop na een aftelling — elke toetsaanslag annuleert die.

Het script claimt zelf niets bij Humble: welk spel je houdt en welk je weggeeft
bepaal je in Humble's eigen UI. Dat is bewust — claimen is onomkeerbaar en kost bij
sommige abonnementen een keuze.

### Eerste keer: draai de diagnose

Tabblad **Diagnose** controleert of de velden op de site waar je bent nog herkend
worden. Het leest alleen; er wordt niets gewijzigd en geen key onthuld.

Op Humble is de belangrijkste regel **"Rijen met een leesbare naam"** — daar horen
twee gelijke getallen te staan ("15 van 15"). Op SteamGifts is dat **"Landcodes
leesbaar"**, plus de groep-id's die je in de instellingen nodig hebt.

## Instellingen

| Instelling | Toelichting |
|---|---|
| Start over / looptijd | Bepaalt start- en eindtijd. Eronder staat wat dat nú zou worden. |
| Wie mag meedoen | Iedereen, op uitnodiging, of groepen. Bij groepen vul je de id's uit de diagnose in. |
| Contributor level | 0 t/m 10. |
| Regio overnemen van Humble | Standaard aan. Humble geeft per spel door waar de key niet werkt; de giveaway wordt dan beperkt tot de landen waar hij wél werkt. |
| Vaste regio-restrictie | Wordt gebruikt als Humble niets meldt of als het overnemen uit staat. |
| Aantal kopieën | Meestal 1: we geven losse keys weg. |
| Beschrijving | Optionele vaste tekst onder elke giveaway. |
| Automatisch verzenden | Uit by default. |
| Keys vervallen na | Zie hieronder. |

## Hoe het werkt

- **De catalogus** komt van de keys-pagina zelf. Elke rij ziet er zo uit:

  ```html
  <tr>
    <td class="platform"><i class="hb hb-key hb-steam"></i></td>
    <td class="game-name">
      <h4>Dicefolk</h4>
      <p><a href="/download?key=5UpZdUyMHhmZxuqa">July 2026 Humble Choice</a></p>
    </td>
    <td class="js-redeemer-cell">…<div class="js-keyfield keyfield redeemed enabled" title="XXXXX-…">…</div></td>
  </tr>
  ```

  De key staat in het `title`-attribuut van `.js-keyfield`, `redeemed` betekent dat
  hij al onthuld is, en de bundellink levert zowel de bundelnaam als de
  **order-sleutel**. Met die sleutel wordt de order opgehaald voor `steam_app_id`
  en `machine_name` — en dat lost meteen Humble's paginering op: zie je één rij van
  een maand, dan krijg je die maand compleet.

- **Keys ophalen** gaat van goedkoop naar duur: wat al zichtbaar is, dan
  `redeemed_key_val` uit de order, en pas als laatste `/humbler/redeemkey`.

- **Het spel opzoeken** op SteamGifts gaat via hun autocomplete, bij voorkeur op
  Steam appid. Humble levert die niet altijd; dan wordt op titel gezocht. Is de
  match niet eenduidig, dan pauzeert de wachtrij en kies je zelf — liever een klik
  extra dan een key aan het verkeerde spel.

- **De regio** wordt omgekeerd. Op SteamGifts betekent een aangevinkt land "hier
  mag men meedoen" — het formulier vraagt letterlijk waar de key *kan* worden
  geactiveerd. Humble zegt het andersom, met twee velden:
  `disallowed_countries` (hier werkt de key níét) en `exclusive_countries` (de key
  werkt *alleen* hier). Is die tweede gevuld, dan is die leidend.

  Staat Nederland aangevinkt, dan is dat dus goed nieuws — Humble blokkeert de key
  daar niet.

### Over de keys

Tampermonkey bewaart opgeslagen waarden **op schijf**; er is geen tegenhanger van
de geheugen-only opslag die een echte extensie heeft. Daarom:

- elke key wordt gewist zodra zijn giveaway is aangemaakt;
- wat blijft liggen vervalt vanzelf (standaard na 12 uur, instelbaar);
- er is een **Wis opgeslagen keys**-knop onder Diagnose.

De wachtrij zelf bevat nooit een key — alleen namen, appids en statussen.

## Ontwikkelen

```bash
npm test     # 58 tests, geen dependencies
npm run build   # bouwt dist/humble-to-steamgifts.user.js
```

Het userscript wordt samengesteld uit `lib/` (gedeelde, geteste logica) en
`userscript/src/` (de twee sitemodules, het paneel en de opslag). `build.js` plakt
ze aan elkaar — geen bundler, geen dependencies. **`dist/` hoort in de repo**: dat
is het bestand dat Tampermonkey ophaalt.

Alle site-specifieke selectors staan in [`lib/selectors.js`](lib/selectors.js).
Verandert Humble of SteamGifts iets, dan is dat één bestand.

### Een nieuwe versie uitbrengen

1. Verhoog `version` in `package.json`.
2. `npm run build`
3. Commit en push, inclusief `dist/`.

Tampermonkey vergelijkt `@version` en biedt de update aan.

De handmatige testen staan in [`docs/VERIFY.md`](docs/VERIFY.md); de integratie met
beide sites vereist een ingelogde browser.

## De oude extensieversie

`manifest.json`, `background.js`, `content/` en `sidepanel/` zijn de Chrome-extensie
waar dit project mee begon. Die werkt nog, maar wordt niet meer bijgewerkt —
`content/humble.js` en `userscript/src/humble.js` zijn inmiddels bijna-duplicaten,
en dat is precies hoe een fix op één plek belandt en op de andere niet. Zodra het
userscript zich bewezen heeft kunnen die bestanden weg.

## Kanttekeningen

- Een key onthullen bij Humble kan niet ongedaan gemaakt worden. De key zelf blijft
  bruikbaar zolang niemand hem inwisselt, maar je kunt er daarna geen
  Humble-gift-link meer van maken. Het script vraagt nooit om een gift-link.
- SteamGifts blokkeert twee identieke giveaways binnen twee minuten. Verschillende
  spellen achter elkaar raken dat niet.
- SteamGifts heeft een limiet op het aantal gelijktijdige giveaways. Loop je daar
  tegenaan, dan stopt de wachtrij met een foutmelding en blijft de rest staan.
