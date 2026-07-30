# Handmatig testprotocol

Beide sites vereisen een ingelogde sessie, dus de integratie is niet
automatiseerbaar. Dit protocol loopt van "verandert niets" naar "maakt echt een
giveaway aan", zodat je fouten tegenkomt vóórdat ze onomkeerbaar zijn.

De SteamGifts-selectors zijn afgeleid van de broncode van
[ESGST](https://github.com/rafaelgomesxyz/esgst), dat dit formulier al jaren
aanstuurt, maar zijn niet tegen de live site geverifieerd. Van de Humble-kant is
alleen `.js-keyfield` met de key in `title` op de echte pagina bevestigd; de
rij-opbouw eromheen is een heuristiek. **Stap 2 is daarom niet optioneel.**

## 0. Laden

1. `chrome://extensions` → Developer mode → **Load unpacked** → deze map
2. Controleer dat er geen fouten op de extensiekaart staan
3. Klik op het extensie-icoon; het zijpaneel moet openen met "0 in de wachtrij"

Waar de logs staan — het zijn drie losse consoles:

| Onderdeel | Waar |
|---|---|
| Service worker | `chrome://extensions` → kaart → link **service worker** |
| Content script | DevTools op de pagina zelf → Console → contextkiezer bovenaan omzetten naar de extensie |
| Zijpaneel | rechtsklik in het paneel → **Inspect** |

De service worker-link verdwijnt als de worker slaapt. Dat is normaal. Let op:
zolang je zijn DevTools open hebt blijft hij leven, wat precies de
levenscyclus-bugs verbergt die je zoekt — doe minstens één ronde met die
DevTools dicht.

## 1. Voorbereiding

- Ingelogd op `humblebundle.com` en op `steamgifts.com`
- De spellen die je wilt weggeven al opgehaald op de Humble-maandpagina — de
  extensie claimt zelf niets
- Genoeg SteamGifts-punten en een vrije giveaway-slot

## 2. Diagnose — verandert niets

**Humble:** open je keys-pagina — `humblebundle.com/home/keys`, of de
downloadpagina van de bundel (`/downloads?key=…`). Dan in het zijpaneel
**Diagnose → Humble**. Verwacht:

- ✓ Soort pagina — moet je keys-pagina noemen, niet `/membership/…`
- ✓ Keyvelden op de pagina — het aantal moet kloppen met wat je op het scherm
  ziet, inclusief hoeveel er al onthuld zijn
- ✓ Spelnamen uit de rijen gelezen — de eerste paar titels, ter controle
- Order-sleutel — ✓ op `/downloads?key=…`; op `/home/keys` mag dit ✕ zijn, dan
  mist alleen het Steam-appid en wordt er op titel gezocht
- ✓ CSRF-token

Bovenaan staat op welke tab het gedraaid heeft. Klopt dat niet, dan had je
meerdere Humble-tabs open — sluit de andere en probeer opnieuw.

Onderaan staat een voorbeeldrij met de keys eruit gefilterd. Zijn de spelnamen
leeg of onzinnig, dan heeft Humble de opmaak gewijzigd: `humble.keyField`,
`rowContainers` en `rowName` in `lib/selectors.js` bijstellen.

**SteamGifts:** open `steamgifts.com/giveaways/new`, dan **Diagnose →
SteamGifts**. Alle velden moeten ✓ zijn. Een ✕ betekent dat SteamGifts die
selector heeft gewijzigd → aanpassen in `lib/selectors.js`.

Noteer meteen de **groep-id's en landcodes** onderaan het rapport; die heb je
nodig als je de giveaway wilt beperken.

## 3. Catalogus lezen — verandert niets

Op de keys-pagina:

- Onderin verschijnt de balk met "N spellen gevonden"
- Elke rij met een key krijgt een **Giveaway**-vinkje
- Aanvinken telt mee in de balk en in het zijpaneel
- In het zijpaneel filtert het zoekveld de lijst (nuttig op `/home/keys`)

## 4. Eén key ophalen

Kies **eerst een spel waarvan de key al zichtbaar is** — in het zijpaneel staat
daar "key al onthuld" bij. Dan wordt er niets onthuld en test je alleen het
leespad.

1. Aanvinken → **Make giveaway**
2. Het spel verschijnt in de wachtrij met status *wacht*
3. Er staat géén "geen key meer opgeslagen" bij

Werkt dat, doe dan hetzelfde met een spel waarvan de key nog verborgen is. Dit is
de eerste onomkeerbare stap: de key wordt bij Humble definitief onthuld.

## 5. Eén giveaway, handmatig verzenden

Zorg dat *Automatisch verzenden* **uit** staat.

1. **Start** in het zijpaneel
2. Er opent een SteamGifts-tab met het nieuwe-giveaway-formulier
3. Rechtsonder staat "Klaar om te verzenden — <spel> (1 van 1)"
4. Controleer met de hand:
   - het juiste spel in sectie 1
   - type staat op **key** en de key staat in het veld
   - start- en eindtijd kloppen en zijn niet in het verleden
   - regio, doelgroep en level zoals ingesteld
5. **Review Giveaway** → controleren → bevestigen
6. Na de redirect meldt de balk "Giveaway aangemaakt" en gaat het item in het
   zijpaneel op *klaar*

Gaat er iets mis, dan pauzeert de wachtrij en staat de reden bij het item.

## 6. Wachtrij van drie

Voeg drie verschillende spellen toe en herhaal stap 5. Let op:

- na elke bevestiging laadt het volgende formulier vanzelf
- de teller loopt op ("2 van 3")
- na het laatste spel stopt de wachtrij en staat alles op *klaar*
- de opgeslagen keys zijn verdwenen (tabblad Diagnose → **Wis opgeslagen keys**
  moet niets meer te wissen hebben; in de wachtrij staat bij afgeronde items
  geen keywaarschuwing)

Gebruik verschillende spellen: SteamGifts blokkeert twee identieke giveaways
binnen twee minuten.

## 7. Randgevallen

| Geval | Verwacht |
|---|---|
| Maandpagina openen | Alleen een balkje met "naar mijn keys"; verder wordt daar niets gelezen |
| `/home/keys` met honderden spellen | Lijst is doorzoekbaar; **Hele bibliotheek** haalt ook orders op die niet op de pagina staan |
| Spel dat SteamGifts niet kent | Wachtrij pauzeert, status *keuze nodig*, kandidaten in het zijpaneel |
| Meerdere kandidaten (bijv. een spel met edities) | Idem; na het kiezen gaat de wachtrij door |
| SteamGifts-tab tussentijds sluiten | **Start** opent een nieuwe tab op het juiste item |
| Browser herstarten met een halve wachtrij | Wachtrij staat er nog, items melden "geen key meer opgeslagen"; opnieuw toevoegen vanaf Humble haalt ze terug |
| Extensie herladen tijdens een wachtrij | Idem — `storage.session` wordt bij elke herlaad geleegd |
| Automatisch verzenden aan | Aftelling met **Annuleren**; annuleren laat het formulier ingevuld staan |

## 8. Na wijzigingen aan de code

```bash
node --test 'test/*.test.js'
```

Daarna in `chrome://extensions` de extensie herladen **en de open tabs van beide
sites verversen** — content scripts worden niet opnieuw in bestaande tabs
geïnjecteerd, en de oude blijven achter met een ongeldige extensiecontext.
