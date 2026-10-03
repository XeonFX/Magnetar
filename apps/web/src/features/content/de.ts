import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Funktionen von Magnetar',
    description: 'Sechs Torrent-Quellen in einer Suche, Downloads auf dem eigenen Computer, Ende-zu-Ende-verschlüsselt von Browser und Handy aus. Kostenlos für macOS, Windows und Linux.',
  },
  header: { language: 'Sprache', signIn: 'Anmelden', devices: 'Deine Geräte', home: 'Magnetar-Startseite' },
  hero: {
    badge: 'Kostenlos für macOS, Windows und Linux',
    title: 'Deine Downloads – ',
    accent: 'von überall',
    lead: 'Magnetar durchsucht sechs Torrent-Quellen gleichzeitig, lädt auf deinem eigenen Computer herunter und verfolgt deine Serien. Öffne es in jedem Browser oder auf dem Handy: Alles dazwischen ist Ende-zu-Ende-verschlüsselt. Jeder Screenshot auf dieser Seite zeigt die echte App.',
    primary: 'Zu den Funktionen',
    secondary: 'App herunterladen',
  },
  stats: { features: n => plural('de', n, { one: 'Funktion', other: 'Funktionen' }), screenshots: n => plural('de', n, { one: 'Screenshot der App', other: 'Screenshots der App' }), sources: n => plural('de', n, { one: 'Torrent-Quelle in einer Suche', other: 'Torrent-Quellen in einer Suche' }), languages: n => plural('de', n, { one: 'Sprache', other: 'Sprachen' }) },
  copy: {
    skipToFeatures: 'Zu den Funktionen springen',
    sectionsLabel: 'Abschnitte der Seite',
    overview: { label: 'Überblick', title: 'Alles, was es kann, auf einen Blick', lead: 'Wähle eine Funktion, um ihre Screenshots und Details zu sehen.', count: n => `${n} ${n === 1 ? 'Funktion' : 'Funktionen'}` },
    contents: 'Inhalt',
    whatItGives: 'Das bringt es: ',
    moreDetails: n => `Mehr Details (${n})`,
    fewerDetails: 'Weniger Details',
    featureLink: 'Link zu dieser Funktion',
    shots: {
      group: title => `Screenshots: ${title}`,
      enlarge: alt => `Vergrößern: ${alt}`,
      previous: 'Vorherige Screenshots',
      next: 'Nächste Screenshots',
      previousOne: 'Vorheriger Screenshot',
      nextOne: 'Nächster Screenshot',
      of: (index, count) => `${index} von ${count}`,
      close: 'Schließen',
    },
  },
  groups: {
    find: {
      title: 'Finden',
      label: 'Suche',
      lead: 'Eine Suche über sechs Quellen, lesbare Adressen für jede Ergebnisliste und Serien, die sich selbst herunterladen.',
      features: {
        sources: {
          title: 'Sechs Quellen, eine Suche',
          gain: 'Ein Suchfeld statt sechs Websites: Die Ergebnisse kommen, sobald jede Quelle antwortet, ohne Werbung.',
          text: 'Magnetar fragt EZTV, 1337x, Nyaa, The Pirate Bay, RARBG und Torrents-CSV gleichzeitig an und fasst Kopien desselben Torrents in einer Zeile zusammen. Jedes Ergebnis zeigt Größe, Seeder und die aus dem Titel gelesenen Release-Details.',
          points: [
            'Release-Tags aus dem Titel: Auflösung (480p bis 4K), HDR oder Dolby Vision, Codec (H.264, HEVC, AV1) und Quelle (BluRay, WEB, HDTV, DVD)',
            'Nach Auflösung und Quelle eingrenzen; nach Seedern sortieren oder die neuesten, größten oder kleinsten zuerst zeigen',
            'Eine langsame oder ausgefallene Quelle hält die anderen nie auf: Antwortet sie nicht binnen 15 Sekunden, wird sie ausgelassen, und „Quellen anzeigen“ zeigt, was jede gefunden hat',
            'Spiegelserver wechseln sich ab: Antwortet einer nicht innerhalb von anderthalb Sekunden, wird der nächste gefragt, und Magnetar merkt sich den schnellsten',
            'Nur Titel, die jedes eingegebene Wort enthalten, in jedem Schriftsystem; verstümmelte Titel werden repariert',
            'Ein Ergebnis für die Details öffnen, seinen Magnet-Link kopieren oder es in einen beliebigen Ordner schicken',
            'Quellen unter Einstellungen → Quellen abschalten',
          ],
        },
        addresses: {
          title: 'Adressen zum Lesen und Teilen',
          gain: 'Eine Suche ist ein Link: Setz ein Lesezeichen, lade sie neu oder schick sie weiter, und sie öffnet dieselben Ergebnisse.',
          text: 'Die Suchwörter stehen im Pfad, in der Query nur die Optionen, die du geändert hast: /search/big+buck+bunny?res=1080p&sort=new. Auch der Downloads-Filter und jeder Einstellungsbereich haben eine eigene Adresse.',
          points: [
            'Zurück und Vor wechseln zwischen Suchen wie zwischen Seiten; ein geänderter Filter fügt keinen Schritt hinzu',
            'Ältere Links werden direkt in die aktuelle Form umgeschrieben, damit gespeicherte weiter funktionieren',
            'Angezeigte IDs sind base58: Buchstaben und Ziffern ohne die verwechselbaren 0, O, I und l, damit sie Vorlesen, Abtippen und Doppelklicken überstehen',
          ],
        },
        add: {
          title: 'Magnet-Links und .torrent-Dateien, egal in welcher Form',
          gain: 'Füge eine Seite voller Links ein oder leg eine Datei irgendwo ab: Jeder Torrent startet für sich, und ein fehlerhafter Link hält den Rest nicht auf.',
          text: 'Der Hinzufügen-Dialog findet jeden Magnet-Link in dem, was du einfügst. Füge einen irgendwo auf der Seite ein oder zieh eine .torrent-Datei darauf, und der Dialog öffnet sich bereits ausgefüllt, mit einem Ordner, den du ändern kannst.',
          points: [
            `.torrent-Dateien bis ${torrentMb} MB`,
            'Auf deinem Computer kann Magnetar Magnet-Links und .torrent-Dateien übernehmen, sodass ein Klick im Browser oder im Dateimanager sie hinzufügt',
            'Auf der Website kann der Browser Magnet-Links direkt an deinen Computer schicken („Magnet-Links hier öffnen“ auf der Geräteseite)',
            'Im Dialog einen anderen Ordner wählen, über eine Ordnerauswahl',
          ],
        },
        series: {
          title: 'Serien, die sich selbst herunterladen',
          gain: 'Neue Folgen kommen von selbst, in der Qualität, die du willst, ohne dass du jede Woche nachsehen musst.',
          text: 'Füge eine Serie hinzu, und Magnetar sucht so oft nach neuen Folgen, wie du willst, nimmt das beste Release, das deine Regeln erlauben, und weicht auf das nächstbeste aus, wenn eines keine Peers findet. Poster, Sender und Sendetermine kommen von TVmaze.',
          points: [
            'Regeln pro Serie: Auflösung, Mindestzahl an Seedern, maximale Größe, bevorzugte und zu meidende Wörter',
            'Beginnen mit einer Folge deiner Wahl, mit der neuesten oder nur mit neuen Folgen',
            'Prüft alle 15 Minuten bis einmal täglich (standardmäßig stündlich), höchstens 25 Folgen auf einmal',
            'Jede Karte zeigt den nächsten Sendetermin und den Fortschritt der Serie',
          ],
        },
        watches: {
          title: 'Beobachtungen für Filme und alles andere',
          gain: 'Sag einmal, worauf du wartest: Sobald es erscheint, erfährst du davon oder der Download startet.',
          text: 'Eine Beobachtung sucht nach Zeitplan nach einem Release. Findet sie eines, benachrichtigt sie dich oder startet den Download, wie du es gewählt hast, und ruht dann, bis du sie wieder aktivierst.',
          points: [
            '„Darauf warten“ auf der Suchseite macht aus der aktuellen Suche eine Beobachtung',
            'Prüft stündlich bis einmal pro Woche (standardmäßig alle sechs Stunden)',
            'Dieselben Qualitätsregeln wie bei Serien',
          ],
        },
      },
    },
    download: {
      title: 'Herunterladen',
      label: 'Download',
      lead: 'Eine eingebaute BitTorrent-Engine: Fortschritt live, nur die Dateien, die du wählst, Wiedergabe während des Downloads und Limits, die sich nach deinem Tag richten.',
      features: {
        engine: {
          title: 'Eine eingebaute Download-Engine',
          gain: 'Fortschritt, Tempo, Peers und Restzeit jedes Downloads live, ohne dass du noch etwas installieren musst.',
          text: 'Downloads laufen in Magnetar auf librqbit, mit DHT und Trackern, und das Dashboard aktualisiert sich jede Sekunde. Nach einer Pause, einem Neustart oder einem Update werden fertige Teile nie neu eingelesen.',
          points: [
            'Nach Aktiv, Pausiert, Fertig oder Fehlgeschlagen filtern; jeden Download pausieren, fortsetzen, erneut versuchen oder löschen',
            'Beim Löschen fragt Magnetar, ob die Dateien bleiben sollen',
            'Gesamttempo für Download und Upload sowie der freie Speicherplatz, der unter 5 GB zur Warnung wird',
            'Den Port am Router öffnet UPnP, und ein Torrent, der in drei Minuten keine Peers findet, meldet das, statt ewig zu warten',
            'Ein Torrent mit mehreren Dateien bekommt einen eigenen Ordner',
          ],
        },
        files: {
          title: 'Nur die Dateien, die du willst',
          gain: 'Lade eine einzelne Folge aus einer Staffel oder lass die Extras weg, und verfolge jede Datei für sich.',
          text: 'Die Details eines Downloads listen seine Dateien mit je einem Kontrollkästchen und ihrem Fortschritt, während des Downloads alle zwei Sekunden aktualisiert, dazu Größe, Ratio, Datumsangaben, Quelle und Ordner.',
          points: [
            'Die Auswahl jederzeit ändern und mit einem Knopf speichern',
            '„Im Ordner zeigen“ öffnet auf deinem Computer Finder oder Explorer bei der Datei',
          ],
        },
        play: {
          title: 'Schauen, während es lädt',
          gain: 'Schau ein Video im Browser, bevor es fertig ist, mit den Untertiteln, die dabei waren.',
          text: 'Der Player fordert den Teil der Datei an, den er braucht, und Magnetar lädt genau diese Teile zuerst. Über die Website läuft das Video durch denselben verschlüsselten Kanal wie alles andere.',
          points: [
            'Bis zu acht Untertitelspuren aus dem Torrent; SRT-Dateien werden direkt umgewandelt',
            'Auf deinem Computer: einen Link für VLC kopieren oder die fertige Datei im eigenen Player öffnen',
            'Vom Handy oder einem anderen Browser aus bis zu vier Videos gleichzeitig',
          ],
        },
        browse: {
          title: 'Deine Downloads, Ordner für Ordner',
          gain: 'Sieh, was wo gelandet ist, spiel es ab oder wähle einen neuen Download-Ordner, am Computer oder vom Handy.',
          text: 'Dateien zeigt den Download-Ordner und jeden Ordner, den du auf dem Computer mit Magnetar hinzufügst: erst Ordner, dann Dateien, mit Größe und Datum. Dateien aus einem Download lassen sich abspielen oder in seinen Details öffnen.',
          points: [
            'Sortiert, wie Menschen Namen lesen: Folge 2 vor Folge 10',
            'Einen Ordner anlegen oder den angezeigten als Download-Ordner verwenden',
            'Über die Website sind nur diese Ordner zu sehen, über denselben verschlüsselten Kanal; versteckte Dateien und Links, die hinausführen, bleiben draußen',
            'Ordner werden nur am Computer selbst hinzugefügt, nie von einem anderen Gerät',
          ],
        },
        speed: {
          title: 'Limits nach deinem Tagesablauf',
          gain: 'Downloads, die nicht die ganze Leitung belegen, während du arbeitest, und volles Tempo in der Nacht.',
          text: 'Begrenze das Download- und Upload-Tempo, schalte die Drosselung mit einem Tipp auf der Downloads-Seite ein oder lass das einen Zeitplan übernehmen. Leg fest, was passiert, wenn ein Download abgeschlossen ist.',
          points: [
            `Obergrenzen ab ${minSpeedKb} KB/s; leer heißt kein Limit`,
            'Gedrosselt sind es 2 MB/s Download und 512 KB/s Upload, sofern du nichts änderst, und der Zeitplan darf über Mitternacht reichen',
            'Wenn ein Download abgeschlossen ist: Seeding beenden, bis zu einer Ratio seeden (0,1 bis 100) oder weiter seeden',
          ],
        },
        'kill-switch': {
          title: 'An dein VPN gebunden',
          gain: 'Torrent-Verkehr läuft nie über die falsche Verbindung, auch wenn das VPN abbricht.',
          text: 'Wähle eine Netzwerkschnittstelle, und jede Verbindung der Engine läuft darüber. Verschwindet sie, hält die Engine an, und Downloads warten, bis sie wieder da ist.',
          points: [
            'Unter macOS und Linux',
            'Die Downloads-Seite erklärt, warum sich nichts bewegt, solange die Schnittstelle fehlt',
          ],
        },
      },
    },
    anywhere: {
      title: 'Von überall',
      label: 'Überall',
      lead: 'Dasselbe Dashboard auf deinem Computer und auf magnetar.codefusion.cc, verbunden über ein Relay, das immer nur verschlüsselte Bytes transportiert.',
      features: {
        website: {
          title: 'Dasselbe Dashboard in jedem Browser',
          gain: 'Starte im Bus vom Handy aus einen Download, und er wartet zu Hause auf deinem Computer.',
          text: 'Melde dich auf magnetar.codefusion.cc an und öffne einen deiner Computer: Suche, Downloads, Merkliste und Einstellungen funktionieren wie zu Hause. Die Arbeit macht dein Computer; die Website verbindet dich nur mit ihm.',
          points: [
            'Deine Geräte mit ihrem Online-Status, alle 15 Sekunden aktualisiert',
            'Ein Handy bekommt unten eine Tab-Leiste, ein Computer eine Seitenleiste',
            'Was nur am Computer selbst Sinn ergibt (seine Ordnerauswahl, das Öffnen von Dateien), bleibt dort',
            'Anmeldung mit Google; Sitzungen gelten 30 Tage ab deinem letzten Besuch, und beim Abmelden trennt sich dieser Browser sofort von deinen Computern',
          ],
        },
        pairing: {
          title: 'Einen Computer mit einem Klick verbinden',
          gain: 'Keine Codes zum Abtippen: Die App öffnet die Website, du bestätigst, und der Computer gehört dir.',
          text: 'Unter Einstellungen → Fernzugriff öffnet „Mit deinem Konto verbinden“ die Website mit einem Kopplungslink. Melde dich an, bestätige, und die App holt sich ihren Schlüssel ab. Der Gerätename, den du gewählt hast, wird zu seiner Adresse.',
          points: [
            'Ein Kopplungslink gilt zehn Minuten, und der Schlüssel wird nur einmal übergeben',
            'Bis zu 20 Computer pro Konto',
            'Die Website speichert vom Token jedes Computers nur einen Hash',
          ],
        },
        phone: {
          title: 'Ein Handy per QR-Code verknüpfen',
          gain: 'Richte die Handykamera auf den Bildschirm, und dein Computer öffnet sich, schon verknüpft.',
          text: 'Jeder Browser bekommt einen eigenen Schlüssel, erzeugt auf deinem Computer. Der QR-Code trägt ihn in dem Teil des Links, der nie einen Server erreicht; das Handy speichert ihn so, dass seine Skripte ihn nutzen, aber nie auslesen können.',
          points: [
            'Verknüpfte Browser stehen mit ihrer letzten Nutzung in einer Liste, jeder mit einem Knopf „Widerrufen“',
            'Ein Browser ohne den Schlüssel sieht, dass er nicht verknüpft ist, aber nie deine Daten',
          ],
        },
        'device-addresses': {
          title: 'Jeder Computer unter eigener Adresse',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: Am Link erkennst du, welchen Computer er öffnet.',
          text: 'Der Name eines Computers ist der erste Teil der Adressen seiner Seiten. Wechsle über den Namen in der Seitenleiste zwischen Computern und bleib dabei auf derselben Seite.',
          points: [
            `Namen sind Buchstaben und Ziffern, durch Bindestriche verbunden, bis zu ${DEVICE_NAME_MAX_LENGTH} Zeichen; jeder eingegebene Name wird so geschrieben („Pawełs Mac“ wird zu Pawels-Mac)`,
            'Wird ein Computer umbenannt, wechselt eine offene Seite auf seine neue Adresse',
            'Benachrichtigungen verlinken den Computer über seine ID, damit sie ihn auch nach einer Umbenennung öffnen',
          ],
        },
        install: {
          title: 'Die Website als App installieren',
          gain: 'Magnetar auf dem Home-Bildschirm deines Handys, im Vollbild wie jede andere App.',
          text: 'In Chrome und Edge erscheint in der Kopfzeile der Knopf „App installieren“; in Safari geht es über das Teilen-Menü.',
          points: [
            'Auf iPhone und iPad kann die Website erst nach der Installation Benachrichtigungen zeigen',
          ],
        },
      },
    },
    notify: {
      title: 'Bescheid bekommen',
      label: 'Benachrichtigungen',
      lead: 'Wenn ein Download startet oder fertig ist, eine Beobachtung etwas findet oder ein Update erscheint: dort, wo du es erfahren willst.',
      features: {
        channels: {
          title: 'Fünf Wege, Bescheid zu bekommen',
          gain: 'Erfahre auf dem Handy, im Posteingang oder in Telegram, dass ein Download fertig ist, ohne einen Tab offen zu halten.',
          text: 'Schalte Desktop, Browser-Push, E-Mail, ntfy und Telegram nach Belieben ein und wähle, ob du vom Start eines Downloads, von seinem Abschluss oder von beidem erfahren willst. Jeder Kanal hat einen Knopf „Testbenachrichtigung senden“.',
          points: [
            'Fällt ein Kanal aus, laufen die anderen trotzdem weiter',
            'E-Mail über deinen eigenen SMTP-Server; ntfy.sh oder dein eigener ntfy-Server; ein Telegram-Bot',
            'Der Fund einer Beobachtung und eine neue Version werden je einmal gemeldet',
          ],
        },
        push: {
          title: 'Push, den die Website nicht lesen kann',
          gain: 'Benachrichtigungen auf dem Handy, auch wenn Magnetar nicht offen ist, so versiegelt, dass nur dein Handy sie lesen kann.',
          text: 'Dein Computer verschlüsselt jede Benachrichtigung für deinen Browser (RFC 8291), bevor sie ihn verlässt; die Website signiert sie nur und reicht sie weiter. Ein Tipp darauf öffnet die Seite dieses Computers.',
          points: [
            'Nur die Push-Dienste von Google, Mozilla, Apple und Microsoft werden akzeptiert',
            'Ein Browser, der sich abgemeldet hat, wird beim nächsten Senden entfernt',
          ],
        },
      },
    },
    app: {
      title: 'Die App',
      label: 'App',
      lead: 'Eine Datei für macOS, Windows oder Linux, die sich selbst aktuell hält und deine Daten auf deinem Computer lässt.',
      features: {
        desktop: {
          title: 'Eine App, sonst nichts zu installieren',
          gain: 'Herunterladen, öffnen, und das Dashboard ist in deinem Browser: kein Installer, keine Laufzeitumgebung, zu Hause kein Konto nötig.',
          text: 'Die App ist eine einzelne ausführbare Datei mit dem Dashboard darin, unter http://localhost:47820. Deine Downloads, Serien und Einstellungen bleiben in einer Datenbank auf deinem Computer. Öffnest du sie ein zweites Mal, öffnet sich nur ihr Dashboard.',
          points: [
            'macOS (Apple Silicon und Intel), Windows und Linux (x64 und ARM)',
            '„Beim Anmelden starten“ unter macOS und Windows',
            'Helles, dunkles oder System-Design, für jeden Browser einzeln gewählt',
          ],
        },
        tray: {
          title: 'In der Menüleiste',
          gain: 'Downloads, Tempo und Drosselung einen Klick entfernt, ohne das Dashboard zu öffnen.',
          text: 'Unter macOS und Windows listet ein Symbol in der Menüleiste oder im Infobereich deine Downloads mit ihrem Fortschritt und setzt Tempolimits aus Voreinstellungen.',
          points: [
            'Unter macOS wohnt Magnetar in der Menüleiste, ohne Dock-Symbol',
            'Zeigt an, wenn ein Update bereitsteht',
          ],
        },
        updates: {
          title: 'Updates, denen du vertrauen kannst',
          gain: 'Eine neue Version ist einen Klick entfernt, und installiert wird nur eine, die der Entwickler signiert hat.',
          text: 'Die App sucht eine Minute nach dem Start und dann alle sechs Stunden nach einer neuen Version, prüft ihre Signatur (Ed25519) gegen den eingebauten Schlüssel und installiert sie, wenn du es sagst. Downloads pausieren erst, wenn das Update bereit ist, und laufen danach weiter.',
          points: [
            'Unter macOS wird die App nach dem Beenden ausgetauscht und bei einem Fehler wiederhergestellt',
            'Versionshinweise und „Nach Updates suchen“ unter Einstellungen → Info',
            'Die Website bringt eine offene Seite beim nächsten Klick auf die neue Version, nie während du tippst',
          ],
        },
        agents: {
          title: 'Ein KI-Agent erledigt das',
          gain: 'Bitte Claude, Codex oder Gemini in normalen Worten, etwas zu finden und herunterzuladen oder eine Serie einzurichten.',
          text: 'Schalte den Agentenzugriff ein, und Magnetar bietet MCP-Tools und eine REST-API (mit OpenAPI-Beschreibung) für Suche, Downloads und Serien. Ein Klick richtet es in Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode oder Claude Desktop ein.',
          points: [
            'Aus, bis du ihn einschaltest; Agenten auf einem anderen Rechner brauchen HTTPS und ein Token',
            'Suchen sind in ihrer Häufigkeit begrenzt, und ein Agent kann nur in deinem Download-Ordner speichern',
          ],
        },
        reports: {
          title: 'Fehlerberichte ohne deine Daten',
          gain: 'Wenn etwas kaputtgeht, erfährt der Entwickler davon, ohne etwas über dich oder deine Downloads.',
          text: 'Fehler werden von Namen, Pfaden, Adressen, Links und Hashes bereinigt, bevor sie verschickt werden, und gehen an CodeFusion Console, wo sie nach Ursache gruppiert werden. Höchstens zehn pro Stunde.',
          points: [
            'Abschalten unter Einstellungen → Allgemein („Anonyme Fehlerberichte senden“)',
            'Fehler der Website werden genauso bereinigt',
          ],
        },
        import: {
          title: 'Umstieg von MediaDownloader',
          gain: 'Deine Downloads, Serien und Einstellungen kommen mit, ohne dass du von vorn anfängst.',
          text: 'Magnetar liest die Datenbank von MediaDownloader, ohne sie zu ändern, und importiert deine Downloads, Serien und Einstellungen. Downloads, die liefen, kommen pausiert an.',
          points: ['Passwörter und Tokens werden nicht übernommen: Gib sie in den Einstellungen neu ein'],
        },
        languages: {
          title: 'In deiner Sprache',
          gain: 'Das Dashboard und diese Seite auf Englisch, Deutsch, Spanisch, Französisch, Italienisch, Polnisch, Portugiesisch und Russisch.',
          text: 'Wähle die Sprache unter Einstellungen → Allgemein; sie gilt für jeden Browser, der diesen Computer öffnet. Die eigenen Seiten der Website folgen der Sprache deines Browsers.',
          points: ['Datum und Uhrzeit stehen so da, wie man sie in deiner Sprache schreibt'],
        },
      },
    },
  },
  shots: {
    search: 'Suchergebnisse mit Release-Tags, aus allen Quellen zusammengeführt',
    'search-phone': 'Die Suche auf dem Handy, mit den Auflösungsfiltern',
    'search-sources': 'Was jede Quelle gefunden hat und wie schnell',
    add: 'Der Hinzufügen-Dialog mit eingefügten Magnet-Links',
    watchlist: 'Die Merkliste: Serien mit ihrer nächsten Folge',
    watches: 'Beobachtungen für Releases, jede mit ihrem Prüfintervall',
    downloads: 'Laufende Downloads mit Tempo, Peers und Restzeit',
    details: 'Die Dateien eines Downloads, jede mit ihrem Fortschritt',
    player: 'Ein frei lizenzierter Film im Browser, mit seinen englischen Untertiteln',
    speed: 'Tempolimits, Drosselung und ihr Zeitplan',
    devices: 'Deine Geräte auf der Website, mit ihrem Online-Status',
    'remote-phone': 'Die Downloads eines Computers auf dem Handy, über die Website',
    remote: 'Fernzugriff in den Einstellungen der App, mit einem Konto verbunden',
    pair: 'Einen Computer auf der Website bestätigen',
    'link-qr': 'Ein QR-Code, der ein Handy verknüpft',
    switcher: 'Wechsel zwischen Computern über die Seitenleiste',
    notifications: 'Benachrichtigungskanäle, jeder mit Test-Knopf',
    settings: 'Allgemeine Einstellungen: Sprache, Design, „Beim Anmelden starten“',
    about: 'Die Version und die Suche nach Updates',
    agents: 'Agentenzugriff und Einrichtung für KI-Agenten mit einem Klick',
  },
  privacy: {
    title: 'Datenschutz in Kürze',
    label: 'Datenschutz',
    lead: 'Dein Computer macht die Arbeit und behält deine Daten. Die Website verbindet dich mit ihm und kann nicht lesen, was durchläuft.',
    items: {
      e2e: { title: 'Ende-zu-Ende-verschlüsselt', text: 'Jede Verbindung erzeugt neue Schlüssel (ECDH P-256, HKDF), und jede Nachricht wird der Reihe nach mit AES-256-GCM versiegelt, sodass eine wiederholte oder umsortierte abgelehnt wird.' },
      worker: { title: 'Was die Website sieht', text: 'Welche Computer zu deinem Konto gehören, ihre Namen, Versionen und ob sie online sind. Nie deine Suchen, Downloads, Einstellungen, Dateien oder Benachrichtigungen.' },
      sealed: { title: 'Geheimnisse zu Hause versiegelt', text: 'Passwörter und Tokens in deinen Einstellungen werden auf deinem Computer verschlüsselt, mit einem Schlüssel, der neben der Datenbank liegt.' },
      visits: { title: 'Kein Tracking', text: 'Die Website zählt Seitenaufrufe nur pro Seite: keine Besucher-ID, keine Cookies dafür, nichts in deinem Browser gespeichert.' },
      local: { title: 'Lokal bleibt lokal', text: 'Auf deinem Computer antwortet das Dashboard nur diesem Computer selbst und weist Seiten anderer Websites ab.' },
    },
  },
  builtOn: {
    title: 'Worauf es läuft',
    label: 'Technik',
    lead: 'Open Source, MIT-lizenziert.',
    items: {
      client: { name: 'Rust', text: 'Die App: eine ausführbare Datei mit Dashboard, Datenbank (SQLite) und Engine darin.' },
      engine: { name: 'librqbit', text: 'Die BitTorrent-Engine: DHT, Tracker, UPnP, schnelles Fortsetzen und Streaming unfertiger Dateien.' },
      dashboard: { name: 'React und daisyUI', text: 'Das Dashboard, derselbe Build auf deinem Computer und auf der Website.' },
      worker: { name: 'Cloudflare Workers', text: 'Die Website: Anmeldung und Geräte in D1 und pro Computer ein Durable Object, das seine verschlüsselten Verbindungen weiterleitet.' },
      packages: { name: 'CodeFusion-Pakete', text: 'Gemeinsamer, getesteter Code für Anmeldung, Push, base58-IDs, das Design, App-Updates und diese Seite.' },
      console: { name: 'CodeFusion Console', text: 'Hier werden Fehler nach Ursache gruppiert, und der Entwickler sieht jedes Deployment und was es geändert hat.' },
      releases: { name: 'GitHub Releases', text: 'Sechs Builds pro Version, gebaut von GitHub Actions, ihre Prüfsummen mit Ed25519 signiert.' },
    },
  },
  closing: {
    title: 'Magnetar ausprobieren',
    lead: 'Lade die kostenlose App für deinen Computer herunter und melde dich dann hier an, um ihn von überall zu erreichen.',
    download: 'App herunterladen',
    signIn: 'Anmelden',
  },
}
