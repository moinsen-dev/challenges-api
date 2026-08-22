# Was dieser Dienst tatsaechlich speichert

Grundlage fuer Datenschutzerklaerung, AVV und jede ehrliche Auskunft. Stand
2026-08-22, abgeleitet aus `migrations/0001_core.sql`.

## Personenbezogene und pseudonyme Daten

| Feld | Inhalt | Warum |
|---|---|---|
| `players.handle` | selbstgewaehlter Name | Anzeige in Ranglisten, Gegnersuche |
| `sessions.token_hash` | SHA-256 des Bearer-Tokens | Anmeldung; das Token selbst wird nie gespeichert |
| `sessions.last_seen` | Zeitstempel | Aufbewahrungsgrenze |
| `player_regions.region_id` | **Bezirk**, saisonal gesperrt | geografische Titel |
| `entries` | Wert, Tag, Zeitpunkt, Disziplin | der Wettbewerb selbst |
| `entries.meta` | freies JSON der App, max. 4 KB | Kontext des Eintrags |
| `qualifications`, `titles`, `player_badges`, `player_items`, `ratings` | abgeleitete Staende | Anzeige |
| `events` | was wem wann passiert ist | Benachrichtigung der App |
| `link_codes.code_hash` | SHA-256 eines Sechsstelligen | Geraetewechsel |

## Was ausdruecklich NICHT gespeichert wird

- keine E-Mail-Adresse, kein Klarname, keine Telefonnummer
- keine IP-Adresse in der Anwendungsdatenbank
- keine Koordinaten, keine Adresse, nichts feiner als ein Bezirk
- kein Geraete-Fingerprint, keine Werbekennung, keine Cookies

Ein Konto entsteht ohne jede Angabe. Das ist der Normalfall, nicht die Ausnahme.

## Die zwei ehrlichen Einschraenkungen

1. **`entries.meta` und `players.handle` sind Freitext.** Wenn eine App dort
   Klarnamen ablegt oder ein Nutzer seinen echten Namen als Handle waehlt,
   liegen personenbezogene Daten vor. Das zu verhindern ist Sache der App als
   Verantwortlicher; der Dienst begrenzt `meta` auf 4 KB und weist darauf hin.
2. **Cloudflare sieht IP-Adressen.** Jeder Aufruf laeuft ueber das
   Cloudflare-Netz; dort fallen kurzlebige Verbindungsdaten inklusive IP an.
   Der Dienst selbst schreibt sie nirgends hin.

## Aufbewahrung

| Daten | Grenze | durchgesetzt von |
|---|---|---|
| Verknuepfungscodes | 1 Tag nach Benutzung oder Ablauf | `POST /v1/admin/maintenance` |
| Ereignisse | 180 Tage | dito |
| Sitzungen | 730 Tage ohne Benutzung | dito |
| Eintraege, Titel, Badges | bis das Konto geloescht wird | `DELETE /v1/me` |

Die Grenzen sind Code, kein Vorsatz — der Aufraeumlauf ist Teil der Proben.

## Betroffenenrechte, technisch

| Recht | Endpunkt |
|---|---|
| Auskunft (Art. 15), Datenuebertragbarkeit (Art. 20) | `GET /v1/me/export` liefert alles als JSON |
| Loeschung (Art. 17) | `DELETE /v1/me`, sofort und vollstaendig |
| Berichtigung (Art. 16) | Handle und Region ueber die App |

Es gibt keinen Papierkorb und keine Anonymisierung mit Restbestand: geloescht
ist geloescht, inklusive Titel und Ranglisteneintraegen.
