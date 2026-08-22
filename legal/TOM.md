# Technische und organisatorische Massnahmen (Art. 32 DSGVO)

Nur das, was tatsaechlich umgesetzt ist. Was fehlt, steht unten.

## Vertraulichkeit

- **Zugangskontrolle.** Zwei getrennte Schluessel je App: der oeffentliche darf
  im Client stehen, der geheime autorisiert Disziplinen, Duelle und Vergaben.
  Gespeichert sind ausschliesslich SHA-256-Hashes beider Schluessel.
- **Spieleranmeldung.** Bearer-Token, gespeichert wird nur der SHA-256-Hash.
  Ein Datenbankabzug erlaubt keine Anmeldung.
- **Mandantentrennung.** Disziplinen, Sammlungen und Badges sind an die App
  gebunden; eine fremde Disziplin ist mit dem eigenen Schluessel nicht
  ansprechbar (durch Proben abgesichert).
- **Datensparsamkeit als Bauweise.** Keine E-Mail, keine IP in der Anwendung,
  keine Koordinaten, nichts feiner als ein Bezirk, `meta` auf 4 KB begrenzt.

## Integritaet

- **Anhaengendes Ledger.** Eintraege sind die Wahrheit; Ranglisten, Titel und
  Ratings sind abgeleitet und jederzeit neu berechenbar.
- **Idempotenz.** Eintraege und Matches koennen ohne Doppelwirkung wiederholt
  eingereicht werden.
- **Plausibilitaetsgrenze.** Werte oberhalb der Grenze einer Disziplin gehen in
  `review` statt in die Wertung — geprueft, nicht geloescht.
- **Vertrauensstufen.** Ein Titel reicht nie hoeher als die Stufe der Disziplin.

## Verfuegbarkeit und Belastbarkeit

- Zustandslose Rechenschicht am Rand des Cloudflare-Netzes, keine zu pflegenden
  Server, kein Wartungsfenster.
- Verwaltete Datenbank mit Sicherungen des Anbieters.
- Grenze fuer neue Konten je App und Stunde gegen massenhafte Anlage.

## Nachpruefbarkeit

- Ereignisprotokoll je Spieler und App.
- 92 automatische Proben gegen die echte Datenbank, darunter Zugriffsschutz,
  Mandantentrennung, Loeschung und Aufbewahrungsgrenzen (`npm test`).
- Offener Quelltext: die Verarbeitung ist von aussen pruefbar.

## Was noch fehlt

- Keine Verschluesselung einzelner Felder in der Datenbank (der Anbieter
  verschluesselt im Ruhezustand, die Anwendung nicht zusaetzlich).
- Kein Vier-Augen-Prinzip — der Betrieb liegt bei einer Person.
- Kein Protokoll administrativer Zugriffe ueber die Anbieterprotokolle hinaus.
- Keine regelmaessige externe Pruefung.

Diese Luecken sind fuer einen Dienst dieser Groesse vertretbar, gehoeren aber
in jedes ehrliche Gespraech mit einem Kunden.
