# Auftragsverarbeitung — Entwurf

> **Entwurf, nicht rechtlich geprueft.** Vor der ersten Nutzung durch einen
> fremden Entwickler von einer Anwaltin oder einem Anwalt pruefen lassen.

## Wer ist was

- **Fuer eigene Apps** (die Apps des Betreibers selbst) ist der Betreiber
  **Verantwortlicher** im Sinne von Art. 4 Nr. 7 DSGVO. Ein AVV ist dann nicht
  noetig, wohl aber eine Datenschutzerklaerung.
- **Fuer fremde Apps** ist der Entwickler der App **Verantwortlicher** und der
  Betreiber dieses Dienstes **Auftragsverarbeiter** (Art. 4 Nr. 8, Art. 28
  DSGVO). Dann ist ein Vertrag nach Art. 28 Abs. 3 DSGVO Pflicht, bevor der
  erste Eintrag eingeht.

## Pflichtinhalte nach Art. 28 Abs. 3 DSGVO

**Gegenstand und Dauer.** Betrieb einer Wettbewerbsschicht (Identitaet,
Ranglisten, Qualifikationen, Challenges, Badges, Sammlungen, Ratings, Titel)
fuer die Dauer des Nutzungsverhaeltnisses.

**Art und Zweck.** Speichern, Ordnen, Auswerten und Anzeigen von
Wettbewerbsdaten. Keine Profilbildung zu Werbezwecken, keine Weitergabe an
Dritte zu eigenen Zwecken, kein Training von Modellen mit Kundendaten.

**Art der Daten.** Siehe `DATENVERZEICHNIS.md` — im Kern ein selbstgewaehlter
Name, ein Bezirk, Zeitstempel und Messwerte. Keine besonderen Kategorien nach
Art. 9 DSGVO; der Verantwortliche darf solche auch nicht einreichen.

**Kategorien betroffener Personen.** Nutzerinnen und Nutzer der App des
Verantwortlichen. Darunter koennen Minderjaehrige sein.

**Weisungsbindung.** Verarbeitung ausschliesslich auf dokumentierte Weisung.
Als Weisung gilt die bestimmungsgemaesse Nutzung der API. Der
Auftragsverarbeiter weist auf offensichtlich rechtswidrige Weisungen hin.

**Vertraulichkeit.** Auf Vertraulichkeit verpflichtete Personen; der Betrieb
liegt derzeit bei einer einzelnen Person.

**Sicherheit.** Massnahmen nach Art. 32 DSGVO, siehe `TOM.md`.

**Unterauftragsverarbeiter.** Cloudflare, Inc. (Rechenleistung, Datenbank,
Auslieferung). Weitere nur nach vorheriger Information mit Widerspruchsrecht.
Die Datenbank wird in der EU angelegt; fuer Datenfluesse in die USA gelten die
Standardvertragsklauseln und das EU-US Data Privacy Framework.

**Unterstuetzung des Verantwortlichen.** Auskunft, Uebertragbarkeit und
Loeschung sind als Endpunkte umgesetzt (`GET /v1/me/export`, `DELETE /v1/me`)
und koennen vom Verantwortlichen selbst ausgeloest werden. Der
Auftragsverarbeiter meldet ihm eine Verletzung des Schutzes personenbezogener
Daten unverzueglich nach Kenntnis, spaetestens innerhalb von 24 Stunden.

**Loeschung nach Ende.** Nach Ende des Vertrags werden die Daten des
Verantwortlichen innerhalb von 30 Tagen geloescht, auf Wunsch vorher als
Ausfuhr uebergeben.

**Nachweis.** Der Verantwortliche kann Nachweise verlangen; da der Quelltext
offenliegt (CC0), ist die Verarbeitung im Wesentlichen selbst pruefbar.

## Der einfachere Weg

Ein Entwickler, dem das zu viel ist, kann den Dienst **selbst hosten** — der
Quelltext steht unter CC0. Dann gibt es keinen Auftragsverarbeiter und keinen
Vertrag. Das ist kein Notausgang, sondern ein ernst gemeinter Teil des Modells.
