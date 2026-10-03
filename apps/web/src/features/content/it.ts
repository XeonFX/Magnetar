import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Magnetar: tutte le funzioni',
    description: 'Cerca in sei fonti torrent insieme, scarica sul tuo computer e segui tutto da qualsiasi browser o telefono, con cifratura end-to-end. Gratis per macOS, Windows e Linux.',
  },
  header: { language: 'Lingua', signIn: 'Accedi', devices: 'I tuoi dispositivi', home: 'Home di Magnetar' },
  hero: {
    badge: 'Gratis per macOS, Windows e Linux',
    title: 'I tuoi download, ',
    accent: 'ovunque tu sia',
    lead: 'Magnetar cerca in sei fonti torrent insieme, scarica sul tuo computer e segue le tue serie. Aprilo da qualsiasi browser o telefono: tutto ciò che passa tra i due è cifrato end-to-end. Ogni screenshot di questa pagina mostra l’app vera.',
    primary: 'Scopri le funzioni',
    secondary: 'Scarica l’app',
  },
  stats: { features: n => plural('it', n, { one: 'funzione', other: 'funzioni' }), screenshots: n => plural('it', n, { one: 'screenshot dell’app', other: 'screenshot dell’app' }), sources: n => plural('it', n, { one: 'fonte torrent in una sola ricerca', other: 'fonti torrent in una sola ricerca' }), languages: n => plural('it', n, { one: 'lingua', other: 'lingue' }) },
  copy: {
    skipToFeatures: 'Vai alle funzioni',
    sectionsLabel: 'Sezioni della pagina',
    overview: { label: 'Panoramica', title: 'Tutto quello che fa, in breve', lead: 'Scegli una funzione per vederne screenshot e dettagli.', count: n => `${n} ${n === 1 ? 'funzione' : 'funzioni'}` },
    contents: 'Indice',
    whatItGives: 'Cosa ti dà: ',
    moreDetails: n => `Altri dettagli (${n})`,
    fewerDetails: 'Meno dettagli',
    featureLink: 'Link a questa funzione',
    shots: {
      group: title => `Screenshot: ${title}`,
      enlarge: alt => `Ingrandisci: ${alt}`,
      previous: 'Screenshot precedenti',
      next: 'Screenshot successivi',
      previousOne: 'Screenshot precedente',
      nextOne: 'Screenshot successivo',
      of: (index, count) => `${index} di ${count}`,
      close: 'Chiudi',
    },
  },
  groups: {
    find: {
      title: 'Trovalo',
      label: 'Cerca',
      lead: 'Una ricerca in sei fonti, indirizzi leggibili per ogni elenco di risultati e serie che si scaricano da sole.',
      features: {
        sources: {
          title: 'Sei fonti in una ricerca',
          gain: 'Una casella di ricerca invece di sei siti: i risultati arrivano man mano che ogni fonte risponde, senza pubblicità.',
          text: 'Magnetar interroga contemporaneamente EZTV, 1337x, Nyaa, The Pirate Bay, RARBG e Torrents-CSV e unisce le copie dello stesso torrent in una sola riga. Ogni risultato mostra dimensione, seeder e i dettagli della release letti dal titolo.',
          points: [
            'Tag della release dal titolo: risoluzione (da 480p a 4K), HDR o Dolby Vision, il codec (H.264, HEVC, AV1) e la fonte (BluRay, WEB, HDTV, DVD)',
            'Filtra per risoluzione e fonte; ordina per seeder, più recenti, più grandi o più piccoli',
            'Una fonte lenta o non disponibile non blocca mai le altre: quella che non risponde entro 15 secondi viene esclusa, e «Mostra fonti» dice cosa ha trovato ciascuna',
            'I mirror si alternano: se uno non risponde entro un secondo e mezzo si interroga il successivo, e il più veloce viene ricordato',
            'Solo titoli che contengono ogni parola digitata, in qualsiasi alfabeto; i titoli con caratteri corrotti vengono riparati',
            'Apri un risultato per vederne i dettagli, copia il suo link magnet o invialo in qualsiasi cartella',
            'Disattiva le fonti in Impostazioni → Fonti',
          ],
        },
        addresses: {
          title: 'Indirizzi da leggere e condividere',
          gain: 'Una ricerca è un link: salvalo nei preferiti, ricaricalo o invialo, e si apre con gli stessi risultati.',
          text: 'Le parole vanno nel percorso e nella query solo le scelte che hai cambiato: /search/big+buck+bunny?res=1080p&sort=new. Anche il filtro dei download e ogni sezione delle impostazioni hanno un proprio indirizzo.',
          points: [
            'Indietro e Avanti passano da una ricerca all’altra come tra pagine; cambiare un filtro non aggiunge un passo',
            'I link più vecchi vengono riscritti sul posto nella forma attuale, quindi quelli salvati continuano a funzionare',
            'Gli id che vedi sono in base58: lettere e cifre senza i caratteri che si confondono, 0, O, I e l, così resistono alla lettura ad alta voce, alla digitazione e al doppio clic',
          ],
        },
        add: {
          title: 'Link magnet e file .torrent, comunque tu li abbia',
          gain: 'Incolla una pagina piena di link o trascina un file ovunque: ogni torrent parte da solo, e un link non valido non ferma gli altri.',
          text: 'La finestra Aggiungi trova ogni link magnet in ciò che incolli. Incollane uno in qualsiasi punto della pagina, o trascinaci sopra un file .torrent, e la finestra si apre già compilata, con una cartella che puoi cambiare.',
          points: [
            `File .torrent fino a ${torrentMb} MB`,
            'Sul tuo computer Magnetar può diventare l’app predefinita per i link magnet e i file .torrent, così basta un clic nel browser o nel file manager per aggiungerli',
            'Sul sito, il browser può inviare i link magnet direttamente al tuo computer («Apri i link magnet qui» nella pagina dei dispositivi)',
            'Scegli un’altra cartella nella finestra, con un selettore di cartelle',
          ],
        },
        series: {
          title: 'Serie che si scaricano da sole',
          gain: 'I nuovi episodi arrivano da soli, nella qualità che vuoi, senza controllare ogni settimana.',
          text: 'Aggiungi una serie e Magnetar cerca nuovi episodi con la frequenza che scegli, prende la release migliore consentita dalle tue regole e passa alla successiva quando una non trova peer. Locandine, emittenti e date di messa in onda arrivano da TVmaze.',
          points: [
            'Regole per ogni serie: risoluzione, seeder minimi, dimensione massima, parole da preferire e da evitare',
            'Parti da un episodio a tua scelta, dall’ultimo uscito o solo dai nuovi episodi',
            'Controlli da ogni 15 minuti a una volta al giorno (ogni ora come impostazione predefinita), al massimo 25 episodi alla volta',
            'Ogni scheda mostra la prossima data di messa in onda e a che punto è la serie',
          ],
        },
        watches: {
          title: 'Attese per film e tutto il resto',
          gain: 'Dici una volta sola cosa aspetti: ti avvisa, o lo scarica, appena compare.',
          text: 'Un’attesa cerca una release secondo un orario. Quando ne trova una ti avvisa o avvia il download, come hai scelto, poi si ferma finché non la riattivi.',
          points: [
            '«Attendi questo» nella pagina di ricerca trasforma la ricerca attuale in un’attesa',
            'Controlli da ogni ora a una volta a settimana (ogni sei ore come impostazione predefinita)',
            'Le stesse regole di qualità delle serie',
          ],
        },
      },
    },
    download: {
      title: 'Scaricalo',
      label: 'Download',
      lead: 'Un motore BitTorrent integrato: avanzamento in tempo reale, i file che scegli, riproduzione durante il download e limiti che seguono la tua giornata.',
      features: {
        engine: {
          title: 'Un motore di download integrato',
          gain: 'Avanzamento, velocità, peer e tempo rimanente in tempo reale per ogni download, senza installare nient’altro.',
          text: 'I download girano dentro Magnetar su librqbit, con DHT e tracker, e la dashboard si aggiorna una volta al secondo. Mettere in pausa, riavviare o aggiornare non fa mai rileggere i pezzi già completati.',
          points: [
            'Filtra per attivi, in pausa, completati o non riusciti; metti in pausa, riprendi, riprova o elimina ciascuno',
            'Quando elimini, ti chiede se tenere i file',
            'Velocità totale di download e upload e lo spazio libero rimasto, che diventa un avviso sotto i 5 GB',
            'La porta del router viene aperta via UPnP, e un torrent che non trova peer in tre minuti lo segnala invece di aspettare all’infinito',
            'Un torrent con più file ha una propria cartella',
          ],
        },
        files: {
          title: 'Solo i file che vuoi',
          gain: 'Scarica un episodio di una stagione, o salta gli extra, e segui ogni file singolarmente.',
          text: 'I dettagli di un download elencano i suoi file, ognuno con una casella di spunta e il suo avanzamento, aggiornato ogni due secondi durante il download, insieme a dimensione, ratio, date, fonte e cartella.',
          points: [
            'Cambia la selezione in qualsiasi momento; un pulsante la salva',
            '«Mostra nella cartella» apre Finder o Explorer sul file, sul tuo computer',
          ],
        },
        play: {
          title: 'Guarda mentre scarica',
          gain: 'Inizia a guardare un video nel browser prima che finisca, con i sottotitoli che lo accompagnano.',
          text: 'Il lettore chiede la parte del file che gli serve e Magnetar scarica prima quei pezzi. Dal sito, il video viaggia sullo stesso canale cifrato di tutto il resto.',
          points: [
            'Fino a otto tracce di sottotitoli dal torrent; i file SRT vengono convertiti al volo',
            'Sul tuo computer: copia un link per VLC o apri il file completato nel tuo lettore',
            'Da un telefono o da un altro browser, fino a quattro video contemporaneamente',
          ],
        },
        browse: {
          title: 'I tuoi download, cartella per cartella',
          gain: 'Guarda cosa è arrivato dove, riproducilo o scegli una nuova cartella di download, dal computer o dal telefono.',
          text: 'File mostra la cartella di download e ogni cartella aggiunta sul computer che esegue Magnetar: prima le cartelle, poi i file, con dimensioni e date. I file di un download si possono riprodurre o aprire nei suoi dettagli.',
          points: [
            'Ordinati come si leggono i nomi: l\'episodio 2 prima del 10',
            'Crea una cartella o usa quella mostrata come cartella di download',
            'Dal sito si vedono solo queste cartelle, sullo stesso canale cifrato; i file nascosti e i collegamenti che portano fuori restano esclusi',
            'Le cartelle si aggiungono solo sul computer stesso, mai da un altro dispositivo',
          ],
        },
        speed: {
          title: 'Limiti che seguono la tua giornata',
          gain: 'Download che non si prendono tutta la connessione mentre lavori, e velocità massima di notte.',
          text: 'Limita la velocità di download e upload, passa alla modalità rallentata con un tocco nella pagina Download o lascia che sia un orario a farlo. Scegli cosa succede quando un download finisce.',
          points: [
            `Limiti da ${minSpeedKb} KB/s; vuoto significa nessun limite`,
            'La modalità rallentata è di 2 MB/s in download e 512 KB/s in upload, se non la cambi, e il suo orario può scavalcare la mezzanotte',
            'Al termine: interrompi il seeding, prosegui fino a un ratio (da 0,1 a 100) o continua il seeding',
          ],
        },
        'kill-switch': {
          title: 'Legato alla tua VPN',
          gain: 'Il traffico torrent non esce mai dalla connessione sbagliata, nemmeno se la VPN cade.',
          text: 'Scegli un’interfaccia di rete e ogni connessione del motore passa da lì. Se scompare, il motore si ferma e i download aspettano che torni.',
          points: [
            'Su macOS e Linux',
            'La pagina Download spiega perché è tutto fermo mentre l’interfaccia manca',
          ],
        },
      },
    },
    anywhere: {
      title: 'Da ovunque',
      label: 'Ovunque',
      lead: 'La stessa dashboard sul tuo computer e su magnetar.codefusion.cc, collegati tramite un relay che trasporta solo byte cifrati.',
      features: {
        website: {
          title: 'La stessa dashboard, da qualsiasi browser',
          gain: 'Avvia un download dal telefono sull’autobus e lo trovi ad aspettarti sul computer di casa.',
          text: 'Accedi su magnetar.codefusion.cc e apri uno qualsiasi dei tuoi computer: ricerca, download, la lista Da seguire e le impostazioni funzionano come a casa. Il lavoro lo fa il tuo computer; il sito ti collega soltanto a lui.',
          points: [
            'I tuoi dispositivi con il loro stato online, aggiornato ogni 15 secondi',
            'Su un telefono le schede sono in basso, su un computer c’è una barra laterale',
            'Quello che ha senso solo al computer (il suo selettore di cartelle, l’apertura dei file) resta lì',
            'Accesso con Google; le sessioni durano 30 giorni dall’ultima visita, e uscendo quel browser si scollega subito dai tuoi computer',
          ],
        },
        pairing: {
          title: 'Collega un computer con un clic',
          gain: 'Nessun codice da copiare: l’app apre il sito, approvi, e il computer è tuo.',
          text: 'In Impostazioni → Accesso remoto, «Collega al tuo account» apre il sito con un link di abbinamento. Accedi, approva e l’app riceve la sua chiave. Il nome del dispositivo che hai scelto diventa il suo indirizzo.',
          points: [
            'Un link di abbinamento vale dieci minuti e la chiave viene consegnata una sola volta',
            'Fino a 20 computer per account',
            'Il sito conserva solo un hash del token di ogni computer',
          ],
        },
        phone: {
          title: 'Collega un telefono con un codice QR',
          gain: 'Inquadra lo schermo con la fotocamera del telefono e si apre il tuo computer, già collegato.',
          text: 'Ogni browser riceve una propria chiave, creata sul tuo computer. Il codice QR la trasporta nella parte del link che non arriva mai a un server; il telefono la conserva dove i suoi script possono usarla ma mai leggerla.',
          points: [
            'I browser collegati sono elencati con il loro ultimo utilizzo, ciascuno con un pulsante Revoca',
            'Un browser senza la chiave vede che non è collegato, mai i tuoi dati',
          ],
        },
        'device-addresses': {
          title: 'Ogni computer al suo indirizzo',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: dal link capisci quale computer apre.',
          text: 'Il nome di un computer è la prima parte degli indirizzi delle sue pagine. Passa da un computer all’altro dal nome nella barra laterale e resti sulla stessa pagina.',
          points: [
            `I nomi sono lettere e cifre unite da trattini, fino a ${DEVICE_NAME_MAX_LENGTH} caratteri; qualsiasi nome digiti viene scritto così («Paweł's Mac» diventa Pawels-Mac)`,
            'Rinominare un computer sposta una pagina aperta al suo nuovo indirizzo',
            'Le notifiche collegano al computer tramite il suo id, quindi lo aprono anche dopo che è stato rinominato',
          ],
        },
        install: {
          title: 'Installa il sito come app',
          gain: 'Magnetar nella schermata Home del telefono, a schermo intero come qualsiasi altra app.',
          text: 'In Chrome e Edge compare un pulsante «Installa app» nell’intestazione; in Safari si aggiunge dal menu Condividi.',
          points: [
            'Su iPhone e iPad è l’installazione che permette al sito di mostrare le notifiche',
          ],
        },
      },
    },
    notify: {
      title: 'Resta informato',
      label: 'Notifiche',
      lead: 'Quando un download inizia o finisce, un’attesa trova qualcosa o esce un aggiornamento: dove preferisci saperlo.',
      features: {
        channels: {
          title: 'Cinque modi per essere avvisato',
          gain: 'Scopri che un download è finito sul telefono, via e-mail o su Telegram, senza tenere aperta una scheda.',
          text: 'Attiva quelli che vuoi tra notifiche desktop, push del browser, e-mail, ntfy e Telegram, e scegli se essere avvisato quando i download iniziano, finiscono o entrambi. Ogni canale ha un pulsante «Invia notifica di prova».',
          points: [
            'Se un canale non funziona, gli altri continuano',
            'E-mail tramite il tuo server SMTP; ntfy.sh o il tuo server ntfy; un bot Telegram',
            'Una release trovata da un’attesa e una nuova versione vengono notificate una sola volta ciascuna',
          ],
        },
        push: {
          title: 'Push che il sito non può leggere',
          gain: 'Notifiche sul telefono anche quando Magnetar non è aperto, sigillate in modo che solo il tuo telefono possa leggerle.',
          text: 'Il tuo computer cifra ogni notifica per il tuo browser (RFC 8291) prima che parta; il sito si limita a firmarla e inoltrarla. Un tocco apre la pagina di quel computer.',
          points: [
            'Sono accettati solo i servizi push di Google, Mozilla, Apple e Microsoft',
            'Un browser che ha annullato l’iscrizione viene rimosso al successivo invio',
          ],
        },
      },
    },
    app: {
      title: 'L’app',
      label: 'L’app',
      lead: 'Un solo file da avviare su macOS, Windows o Linux, che si aggiorna da solo e tiene i tuoi dati sul tuo computer.',
      features: {
        desktop: {
          title: 'Un’app, nient’altro da installare',
          gain: 'Scaricala, aprila e la dashboard è nel browser: nessun programma di installazione, nessun runtime, nessun account a casa.',
          text: 'L’app è un singolo eseguibile con la dashboard all’interno, su http://localhost:47820. Download, serie e impostazioni restano in un database sul tuo computer. Aprirla una seconda volta apre semplicemente la sua dashboard.',
          points: [
            'macOS (Apple silicon e Intel), Windows e Linux (x64 e ARM)',
            '«Avvia all’accesso» su macOS e Windows',
            'Tema chiaro, scuro o di sistema, scelto per ogni browser',
          ],
        },
        tray: {
          title: 'Nella barra dei menu',
          gain: 'Download, velocità e modalità rallentata a un clic, senza aprire la dashboard.',
          text: 'Su macOS e Windows un’icona nella barra dei menu o nell’area di notifica elenca i download con il loro avanzamento e imposta i limiti di velocità da valori predefiniti.',
          points: [
            'Su macOS Magnetar vive nella barra dei menu, senza icona nel Dock',
            'Segnala quando un aggiornamento è pronto',
          ],
        },
        updates: {
          title: 'Aggiornamenti di cui fidarti',
          gain: 'Una nuova versione è a un clic, e viene installata solo se firmata dallo sviluppatore.',
          text: 'L’app cerca una nuova versione un minuto dopo l’avvio e poi ogni sei ore, ne verifica la firma (Ed25519) con la chiave integrata e la installa quando lo decidi tu. I download si mettono in pausa solo quando l’aggiornamento è pronto, e poi riprendono.',
          points: [
            'Su macOS l’app viene sostituita dopo la chiusura, e ripristinata se qualcosa va storto',
            'Note di rilascio e «Cerca aggiornamenti» in Impostazioni → Informazioni',
            'Il sito porta una pagina aperta alla nuova versione al clic successivo, mai mentre stai scrivendo',
          ],
        },
        agents: {
          title: 'Lascia fare a un agente IA',
          gain: 'Chiedi a Claude, Codex o Gemini, con parole semplici, di trovare e scaricare qualcosa o di impostare una serie.',
          text: 'Attiva l’accesso agenti e Magnetar offre strumenti MCP e un’API REST (con una descrizione OpenAPI) per ricerca, download e serie. Con un clic lo configuri in Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode o Claude Desktop.',
          points: [
            'Disattivato finché non lo attivi; gli agenti su un’altra macchina richiedono HTTPS e un token',
            'Le ricerche hanno un limite di frequenza, e un agente può salvare solo nella tua cartella di download',
          ],
        },
        reports: {
          title: 'Segnalazioni di errore senza i tuoi dati',
          gain: 'Quando qualcosa si rompe, lo sviluppatore lo viene a sapere, senza nulla su di te o sui tuoi download.',
          text: 'Prima di partire, dagli errori vengono rimossi nomi, percorsi, indirizzi, link e hash; poi arrivano a CodeFusion Console, dove sono raggruppati per causa. Al massimo dieci all’ora.',
          points: [
            'Disattivale in Impostazioni → Generali («Invia segnalazioni di errore anonime»)',
            'Gli errori del sito vengono ripuliti allo stesso modo',
          ],
        },
        import: {
          title: 'Se arrivi da MediaDownloader',
          gain: 'Download, serie e impostazioni vengono con te, senza ricominciare da capo.',
          text: 'Magnetar legge il database di MediaDownloader senza modificarlo e importa download, serie e impostazioni. I download in corso arrivano in pausa.',
          points: ['Password e token non vengono copiati: inseriscili di nuovo in Impostazioni'],
        },
        languages: {
          title: 'Nella tua lingua',
          gain: 'La dashboard e questa pagina in inglese, tedesco, spagnolo, francese, italiano, polacco, portoghese e russo.',
          text: 'Scegli una lingua in Impostazioni → Generali; vale per ogni browser che apre quel computer. Le pagine del sito seguono la lingua del tuo browser.',
          points: ['Date e ore sono scritte come si usa nella tua lingua'],
        },
      },
    },
  },
  shots: {
    search: 'Risultati di ricerca con i tag delle release, uniti da tutte le fonti',
    'search-sources': 'Cosa ha trovato ogni fonte, e con che velocità',
    add: 'La finestra Aggiungi con dei link magnet incollati',
    watchlist: 'La lista Da seguire: serie con il prossimo episodio',
    watches: 'Attese di release, con la frequenza dei controlli di ciascuna',
    downloads: 'Download in corso, con velocità, peer e tempo rimanente',
    'search-phone': 'La ricerca su un telefono, con i filtri di risoluzione',
    details: 'I file di un download, ciascuno con il suo avanzamento',
    player: 'Un film con licenza libera nel browser, con i suoi sottotitoli in inglese',
    speed: 'Limiti di velocità, modalità rallentata e il suo orario',
    devices: 'I tuoi dispositivi sul sito, con il loro stato online',
    'remote-phone': 'I download di un computer su un telefono, tramite il sito',
    remote: 'L’accesso remoto nelle impostazioni dell’app, collegato a un account',
    pair: 'Approvazione di un computer sul sito',
    'link-qr': 'Un codice QR che collega un telefono',
    switcher: 'Passaggio da un computer all’altro dalla barra laterale',
    notifications: 'Canali di notifica, ciascuno con un pulsante di prova',
    settings: 'Impostazioni generali: lingua, tema, avvio all’accesso',
    about: 'La versione e la ricerca di aggiornamenti',
    agents: 'Accesso agenti e configurazione con un clic per gli agenti IA',
  },
  privacy: {
    title: 'La privacy in breve',
    label: 'Privacy',
    lead: 'Il lavoro lo fa il tuo computer, che conserva anche i tuoi dati. Il sito ti collega a lui e non può leggere ciò che vi transita.',
    items: {
      e2e: { title: 'Cifrato end-to-end', text: 'Ogni connessione genera chiavi nuove (ECDH P-256, HKDF) e ogni messaggio è sigillato in ordine con AES-256-GCM, quindi uno ripetuto o fuori ordine viene rifiutato.' },
      worker: { title: 'Cosa vede il sito', text: 'Quali computer sono nel tuo account, i loro nomi, le versioni e se sono online. Mai le tue ricerche, i download, le impostazioni, i file o le notifiche.' },
      sealed: { title: 'Segreti sigillati a casa', text: 'Password e token nelle impostazioni sono cifrati sul tuo computer, con una chiave conservata accanto al database.' },
      visits: { title: 'Nessun tracciamento', text: 'Il sito conta le visualizzazioni solo per pagina: nessun id del visitatore, nessun cookie per questo, niente salvato nel browser.' },
      local: { title: 'Ciò che è locale resta locale', text: 'Sul tuo computer la dashboard risponde solo al computer stesso e rifiuta le pagine di altri siti.' },
    },
  },
  builtOn: {
    title: 'Su cosa si basa',
    label: 'Tecnologie',
    lead: 'Open source, con licenza MIT.',
    items: {
      client: { name: 'Rust', text: 'L’app: un unico eseguibile con dentro la dashboard, il database (SQLite) e il motore.' },
      engine: { name: 'librqbit', text: 'Il motore BitTorrent: DHT, tracker, UPnP, ripresa rapida e streaming dei file non completati.' },
      dashboard: { name: 'React e daisyUI', text: 'La dashboard, la stessa build sul tuo computer e sul sito.' },
      worker: { name: 'Cloudflare Workers', text: 'Il sito: accesso e dispositivi in D1, e un Durable Object per ogni computer che inoltra le sue connessioni cifrate.' },
      packages: { name: 'Pacchetti CodeFusion', text: 'Codice condiviso e testato per accesso, notifiche push, id base58, il tema, gli aggiornamenti dell’app e questa pagina.' },
      console: { name: 'CodeFusion Console', text: 'Dove gli errori sono raggruppati per causa e dove lo sviluppatore vede ogni deploy e cosa ha cambiato.' },
      releases: { name: 'GitHub Releases', text: 'Sei build per versione, create da GitHub Actions, con i checksum firmati con Ed25519.' },
    },
  },
  closing: {
    title: 'Prova Magnetar',
    lead: 'Scarica l’app gratuita per il tuo computer, poi accedi qui per raggiungerlo da ovunque.',
    download: 'Scarica l’app',
    signIn: 'Accedi',
  },
}
