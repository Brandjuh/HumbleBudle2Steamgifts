# Humble → SteamGifts

Privé Chrome-extensie (Manifest V3) die van Humble Choice-keys SteamGifts-giveaways
maakt. Vink spellen aan op je Humble-maandpagina, de extensie haalt de keys op en
vult per spel het formulier op `steamgifts.com/giveaways/new` volledig in —
inclusief de key. Jij drukt alleen nog op verzenden.

Meerdere spellen tegelijk aanvinken kan: de extensie werkt ze daarna één voor één
af, elk als een eigen giveaway.

Niet bedoeld voor de Chrome Web Store. Laden gaat via *Load unpacked*.

## Installeren

1. `chrome://extensions` openen
2. **Developer mode** aanzetten (rechtsboven)
3. **Load unpacked** → deze map kiezen
4. Zet de extensie vast in de werkbalk; klikken op het icoon opent het zijpaneel

Verplaats de projectmap daarna niet meer: de extensie-id van een unpacked
extensie is afgeleid van het pad, en bij een nieuw pad ben je je instellingen en
wachtrij kwijt. Wil je hem vastzetten, gebruik dan *Pack extension* en zet de
resulterende publieke sleutel als `"key"` in `manifest.json`.

## Gebruik

1. Log in op zowel `humblebundle.com` als `steamgifts.com`.
2. Open je Humble Choice-maandpagina (`humblebundle.com/membership/…`).
   Onderin verschijnt een balk met het aantal gevonden Steam-keys.
3. Vink de spellen aan die je wilt weggeven — op de tegels zelf of in het
   tabblad **Humble** van het zijpaneel.
4. Klik op **Make giveaway**. De keys worden opgehaald en de spellen komen in de
   wachtrij.
5. Ga naar het tabblad **Wachtrij** en klik op **Start**. Er opent een
   SteamGifts-tab met het formulier al ingevuld.
6. Controleer, klik op **Review Giveaway** en bevestig. Zodra de giveaway
   bestaat, laadt de extensie het volgende spel in.

Herhaal stap 6 tot de wachtrij leeg is. Zet je in de instellingen *Automatisch
verzenden* aan, dan drukt de extensie zelf op de knop na een aftelling die je
elke keer kunt annuleren.

### Eerste keer: draai de diagnose

Tabblad **Diagnose** controleert of de extensie de velden op beide sites nog
herkent. Het leest alleen; er wordt niets gewijzigd en geen key onthuld. Doe dit
vóór je eerste echte giveaway — en opnieuw als er iets niet meer lukt, want dan
zie je meteen of een van de twee sites zijn opmaak heeft gewijzigd.

De diagnose van SteamGifts toont ook de beschikbare **groep-id's en landcodes**,
die je in de instellingen nodig hebt.

## Instellingen

| Instelling | Toelichting |
|---|---|
| Start over / looptijd | Bepaalt de start- en eindtijd. Onder het veld staat wat dat nú zou worden. |
| Wie mag meedoen | Iedereen, op uitnodiging, of groepen. Bij groepen vul je de id's uit de diagnose in. |
| Contributor level | 0 t/m 10. |
| Regio-restrictie | Aan/uit plus de toegestane landcodes. |
| Aantal kopieën | Meestal 1: we geven losse keys weg. |
| Beschrijving | Optionele vaste tekst onder elke giveaway. |
| Automatisch verzenden | Uit by default. |

## Hoe het werkt

- **Keys ophalen** gebeurt in het content script op humblebundle.com, via
  Humble's eigen JSON-API (`/api/v1/order/…` en `/humbler/redeemkey`). Dat moet
  vanaf de pagina zelf: same-origin, met je eigen sessiecookie. Vanuit de service
  worker zou het een cross-origin request worden, en die zijn in MV3
  CORS-geblokkeerd.
- **Het spel opzoeken** op SteamGifts gaat via hun autocomplete-endpoint, bij
  voorkeur op Steam appid. Humble levert die niet altijd; dan wordt op titel
  gezocht. Is de match niet eenduidig, dan pauzeert de wachtrij en kies je zelf
  in het zijpaneel — liever één klik extra dan een key aan het verkeerde spel.
- **De wachtrij** staat in `chrome.storage.local` en overleeft een
  browserherstart.
- **De keys** staan uitsluitend in `chrome.storage.session`: alleen in het
  geheugen, weg zodra je de browser afsluit, en elke key wordt gewist zodra zijn
  giveaway is aangemaakt. `storage.local` staat onversleuteld op schijf en
  `storage.sync` zou ze naar Google sturen — daar horen ze dus niet.

Ben je na een browserherstart de keys kwijt terwijl de wachtrij er nog staat: de
keys zijn bij Humble al onthuld, dus opnieuw scannen en toevoegen haalt ze
gewoon weer op zonder dat er iets verloren gaat.

## Ontwikkelen

Geen buildstap, geen dependencies. Alle site-specifieke selectors staan in
[`lib/selectors.js`](lib/selectors.js) — verandert Humble of SteamGifts iets, dan
is dat één bestand.

```bash
npm test    # of: node --test 'test/*.test.js'
```

De tests dekken de pure logica: datumopmaak, titelvergelijking en de
wachtrij-reducer. De integratie met beide sites vereist een ingelogde browser en
wordt handmatig getest — zie [`docs/VERIFY.md`](docs/VERIFY.md).

## Kanttekeningen

- Een key onthullen bij Humble kan niet ongedaan gemaakt worden. De key zelf
  blijft bruikbaar zolang niemand hem inwisselt, maar je kunt er daarna geen
  Humble-gift-link meer van maken. De extensie vraagt nooit om een gift-link.
- SteamGifts blokkeert twee identieke giveaways binnen twee minuten. Verschillende
  spellen achter elkaar raken dat niet.
- SteamGifts heeft een limiet op het aantal gelijktijdige giveaways. Loop je daar
  tegenaan, dan stopt de wachtrij met een foutmelding en blijft de rest staan.
