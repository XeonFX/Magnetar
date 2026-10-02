import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Fonctionnalités de Magnetar',
    description: 'Six sources torrent en une recherche, téléchargement sur votre ordinateur et suivi depuis tout navigateur, chiffré de bout en bout. Gratuit sur macOS, Windows et Linux.',
  },
  header: { language: 'Langue', signIn: 'Se connecter', devices: 'Vos appareils', home: 'Accueil Magnetar' },
  hero: {
    badge: 'Gratuit pour macOS, Windows et Linux',
    title: 'Vos téléchargements, ',
    accent: 'où que vous soyez',
    lead: 'Magnetar cherche sur six sources torrent à la fois, télécharge sur votre propre ordinateur et suit vos séries. Ouvrez-le depuis n’importe quel navigateur ou téléphone : tout ce qui passe entre eux est chiffré de bout en bout. Chaque capture d’écran de cette page montre la vraie app.',
    primary: 'Voir les fonctionnalités',
    secondary: 'Obtenir l’app',
  },
  stats: { features: n => plural('fr', n, { one: 'fonctionnalité', other: 'fonctionnalités' }), screenshots: n => plural('fr', n, { one: 'capture d’écran de l’app', other: 'captures d’écran de l’app' }), sources: n => plural('fr', n, { one: 'source torrent en une recherche', other: 'sources torrent en une recherche' }), languages: n => plural('fr', n, { one: 'langue', other: 'langues' }) },
  copy: {
    skipToFeatures: 'Aller aux fonctionnalités',
    sectionsLabel: 'Sections de la page',
    overview: { label: 'Aperçu', title: 'Tout ce qu’il fait, en un coup d’œil', lead: 'Choisissez une fonctionnalité pour voir ses captures d’écran et ses détails.', count: n => (n < 2 ? `${n} fonctionnalité` : `${n} fonctionnalités`) },
    contents: 'Sommaire',
    whatItGives: 'Ce que ça apporte : ',
    moreDetails: n => `Plus de détails (${n})`,
    fewerDetails: 'Moins de détails',
    featureLink: 'Lien vers cette fonctionnalité',
    shots: {
      group: title => `Captures d’écran : ${title}`,
      enlarge: alt => `Agrandir : ${alt}`,
      previous: 'Captures précédentes',
      next: 'Captures suivantes',
      previousOne: 'Capture précédente',
      nextOne: 'Capture suivante',
      of: (index, count) => `${index} sur ${count}`,
      close: 'Fermer',
    },
  },
  groups: {
    find: {
      title: 'Le trouver',
      label: 'Recherche',
      lead: 'Une recherche sur six sources, des adresses lisibles pour chaque liste de résultats et des séries qui se téléchargent toutes seules.',
      features: {
        sources: {
          title: 'Six sources, une seule recherche',
          gain: 'Un champ de recherche au lieu de six sites : les résultats arrivent à mesure que chaque source répond, sans les publicités.',
          text: 'Magnetar interroge en même temps EZTV, 1337x, Nyaa, The Pirate Bay, RARBG et Torrents-CSV, et fusionne les copies d’un même torrent en une seule ligne. Chaque résultat indique sa taille, ses seeders et les détails de la version tirés de son titre.',
          points: [
            'Étiquettes tirées du titre : résolution (480p à 4K), HDR ou Dolby Vision, codec (H.264, HEVC, AV1) et source (BluRay, WEB, HDTV, DVD)',
            'Filtrez par résolution et par source ; triez par seeders, plus récents, plus grands ou plus petits',
            'Une source lente ou en panne ne retarde jamais les autres : celle qui n’a pas répondu en 15 secondes est écartée, et « Afficher les sources » indique ce que chacune a trouvé',
            'Les miroirs se relaient : si l’un ne répond pas en une seconde et demie, le suivant est interrogé, et le plus rapide est mémorisé',
            'Seuls les titres qui contiennent tous les mots saisis, quel que soit l’alphabet ; les titres aux caractères corrompus sont réparés',
            'Ouvrez un résultat pour voir ses détails, copiez son lien magnet ou envoyez-le dans n’importe quel dossier',
            'Désactivez des sources dans Paramètres → Sources',
          ],
        },
        addresses: {
          title: 'Des adresses lisibles et partageables',
          gain: 'Une recherche est un lien : ajoutez-la aux favoris, rechargez-la ou envoyez-la, elle rouvre les mêmes résultats.',
          text: 'Les mots vont dans le chemin, et seuls les choix que vous avez modifiés dans la requête : /search/big+buck+bunny?res=1080p&sort=new. Le filtre des téléchargements et chaque section des paramètres ont aussi leur propre adresse.',
          points: [
            'Précédent et Suivant passent d’une recherche à l’autre comme d’une page à l’autre ; changer un filtre n’ajoute pas d’étape',
            'Les anciens liens sont réécrits sur place dans la forme actuelle : un lien enregistré continue de fonctionner',
            'Les identifiants affichés sont en base58 : des lettres et des chiffres sans les sosies 0, O, I et l, pour résister à la lecture à voix haute, à la saisie et au double-clic',
          ],
        },
        add: {
          title: 'Liens magnet et fichiers .torrent, sous toutes leurs formes',
          gain: 'Collez une page pleine de liens ou déposez un fichier n’importe où : chaque torrent démarre de son côté, et un lien invalide n’arrête pas les autres.',
          text: 'La fenêtre Ajouter trouve tous les liens magnet dans ce que vous collez. Collez-en un n’importe où sur la page, ou déposez-y un fichier .torrent, et la fenêtre s’ouvre déjà remplie, avec un dossier que vous pouvez changer.',
          points: [
            `Fichiers .torrent jusqu’à ${torrentMb} Mo`,
            'Sur votre ordinateur, Magnetar peut devenir l’application des liens magnet et des fichiers .torrent : un clic dans le navigateur ou le gestionnaire de fichiers les ajoute',
            'Sur le site, le navigateur peut envoyer les liens magnet directement à votre ordinateur (« Ouvrir les liens magnet ici » sur la page des appareils)',
            'Choisissez un autre dossier dans la fenêtre, avec un explorateur de dossiers',
          ],
        },
        series: {
          title: 'Des séries qui se téléchargent toutes seules',
          gain: 'Les nouveaux épisodes arrivent d’eux-mêmes, dans la qualité voulue, sans vérifier chaque semaine.',
          text: 'Ajoutez une série et Magnetar cherche les nouveaux épisodes aussi souvent que vous le décidez, prend la meilleure version que vos règles autorisent et passe à la suivante quand l’une ne trouve aucun pair. Affiches, chaînes et dates de diffusion viennent de TVmaze.',
          points: [
            'Des règles par série : résolution, seeders minimum, taille maximale, mots à préférer et à éviter',
            'Commencez par l’épisode de votre choix, par le dernier, ou seulement avec les nouveaux',
            'Vérification toutes les 15 minutes à une fois par jour (toutes les heures par défaut), 25 épisodes au plus à la fois',
            'Chaque carte indique la prochaine date de diffusion et l’avancement de la série',
          ],
        },
        watches: {
          title: 'Des suivis pour les films et tout le reste',
          gain: 'Dites une seule fois ce que vous attendez : vous êtes prévenu, ou le téléchargement démarre, dès que ça apparaît.',
          text: 'Un suivi cherche une version selon un horaire. Quand il en trouve une, il vous prévient ou lance le téléchargement, selon votre choix, puis s’arrête jusqu’à ce que vous le réarmiez.',
          points: [
            '« Attendre ceci » sur la page de recherche transforme la recherche en cours en suivi',
            'Vérification toutes les heures à une fois par semaine (toutes les six heures par défaut)',
            'Les mêmes règles de qualité que pour les séries',
          ],
        },
      },
    },
    download: {
      title: 'Le télécharger',
      label: 'Téléchargement',
      lead: 'Un moteur BitTorrent intégré : la progression en direct, les fichiers que vous choisissez, la lecture en cours de téléchargement et des limites qui suivent votre journée.',
      features: {
        engine: {
          title: 'Un moteur de téléchargement intégré',
          gain: 'Progression, vitesse, pairs et temps restant en direct pour chaque téléchargement, sans rien d’autre à installer.',
          text: 'Les téléchargements tournent dans Magnetar sur librqbit, avec DHT et trackers, et le tableau de bord se met à jour chaque seconde. Une pause, un redémarrage ou une mise à jour ne relit jamais les pièces déjà terminées.',
          points: [
            'Filtrez par Actifs, En pause, Terminés ou En échec ; mettez en pause, reprenez, réessayez ou supprimez chacun',
            'La suppression demande s’il faut garder les fichiers',
            'Vitesses totales de réception et d’envoi, et espace libre restant, signalé en avertissement sous 5 Go',
            'Le port du routeur est ouvert par UPnP, et un torrent qui ne trouve aucun pair en trois minutes le signale au lieu d’attendre indéfiniment',
            'Un torrent de plusieurs fichiers a son propre dossier',
          ],
        },
        files: {
          title: 'Seulement les fichiers voulus',
          gain: 'Téléchargez un seul épisode d’une saison, ou laissez de côté les bonus, et suivez chaque fichier séparément.',
          text: 'Les détails d’un téléchargement listent ses fichiers, chacun avec une case à cocher et sa progression, actualisée toutes les deux secondes pendant le téléchargement, ainsi que sa taille, son ratio, ses dates, sa source et son dossier.',
          points: [
            'Modifiez la sélection à tout moment ; un bouton l’enregistre',
            '« Afficher dans le dossier » ouvre le Finder ou l’Explorateur de fichiers sur le fichier, sur votre ordinateur',
          ],
        },
        play: {
          title: 'Regarder pendant le téléchargement',
          gain: 'Commencez à regarder une vidéo dans le navigateur avant la fin du téléchargement, avec les sous-titres fournis.',
          text: 'Le lecteur demande la partie du fichier dont il a besoin, et Magnetar récupère ces pièces en priorité. Par le site, la vidéo passe par le même canal chiffré que tout le reste.',
          points: [
            'Jusqu’à huit pistes de sous-titres du torrent ; les fichiers SRT sont convertis à la volée',
            'Sur votre ordinateur : copiez un lien pour VLC, ou ouvrez le fichier terminé dans votre propre lecteur',
            'Depuis un téléphone ou un autre navigateur, jusqu’à quatre vidéos à la fois',
          ],
        },
        speed: {
          title: 'Des limites qui suivent votre journée',
          gain: 'Des téléchargements qui ne prennent pas toute la connexion pendant que vous travaillez, et la pleine vitesse la nuit.',
          text: 'Plafonnez les vitesses de réception et d’envoi, passez en mode ralenti d’un geste sur la page Téléchargements, ou laissez un horaire le faire pour vous. Choisissez ce qui se passe quand un téléchargement se termine.',
          points: [
            `Plafonds à partir de ${minSpeedKb} Ko/s ; vide signifie aucune limite`,
            'Le mode ralenti, c’est 2 Mo/s en réception et 512 Ko/s en envoi, sauf si vous le changez, et son horaire peut s’étendre sur la nuit',
            'À la fin : « Arrêter le seeding », « Seeder jusqu’à un ratio » (0,1 à 100) ou « Continuer le seeding »',
          ],
        },
        'kill-switch': {
          title: 'Lié à votre VPN',
          gain: 'Le trafic torrent ne sort jamais par la mauvaise connexion, même si le VPN tombe.',
          text: 'Choisissez une interface réseau, et toutes les connexions du moteur passent par elle. Si elle disparaît, le moteur s’arrête et les téléchargements attendent son retour.',
          points: [
            'Sur macOS et Linux',
            'La page Téléchargements explique pourquoi rien ne bouge tant que l’interface est absente',
          ],
        },
      },
    },
    anywhere: {
      title: 'De partout',
      label: 'Partout',
      lead: 'Le même tableau de bord sur votre ordinateur et sur magnetar.codefusion.cc, reliés par un relais qui ne transporte jamais que des octets chiffrés.',
      features: {
        website: {
          title: 'Le même tableau de bord, depuis n’importe quel navigateur',
          gain: 'Lancez un téléchargement depuis votre téléphone dans le bus : il vous attend sur votre ordinateur à la maison.',
          text: 'Connectez-vous sur magnetar.codefusion.cc et ouvrez n’importe lequel de vos ordinateurs : la recherche, les téléchargements, la liste À suivre et les paramètres fonctionnent comme chez vous. Votre ordinateur fait le travail ; le site ne fait que vous y connecter.',
          points: [
            'Vos appareils et leur état en ligne, actualisés toutes les 15 secondes',
            'Un téléphone a une barre d’onglets en bas, un ordinateur une barre latérale',
            'Ce qui n’a de sens que devant l’ordinateur (son sélecteur de dossiers, l’ouverture des fichiers) y reste',
            'Connexion avec Google ; les sessions durent 30 jours après votre dernière visite, et la déconnexion coupe aussitôt ce navigateur de vos ordinateurs',
          ],
        },
        pairing: {
          title: 'Connecter un ordinateur en un clic',
          gain: 'Aucun code à recopier : l’app ouvre le site, vous approuvez, et l’ordinateur est à vous.',
          text: 'Dans Paramètres → Accès à distance, « Connecter à votre compte » ouvre le site avec un lien d’association. Connectez-vous, approuvez, et l’app récupère sa clé. Le nom d’appareil que vous avez choisi devient son adresse.',
          points: [
            'Un lien d’association est valable dix minutes, et la clé n’est remise qu’une fois',
            'Jusqu’à 20 ordinateurs par compte',
            'Le site ne conserve qu’un hachage du jeton de chaque ordinateur',
          ],
        },
        phone: {
          title: 'Associer un téléphone par code QR',
          gain: 'Pointez l’appareil photo de votre téléphone vers l’écran : il ouvre votre ordinateur, déjà associé.',
          text: 'Chaque navigateur reçoit sa propre clé, créée sur votre ordinateur. Le code QR la transporte dans la partie du lien qui n’atteint jamais un serveur ; le téléphone la stocke là où ses scripts peuvent l’utiliser sans jamais la lire.',
          points: [
            'Les navigateurs associés sont listés avec leur dernière utilisation, chacun avec un bouton Révoquer',
            'Un navigateur sans la clé voit qu’il n’est pas associé, jamais vos données',
          ],
        },
        'device-addresses': {
          title: 'Chaque ordinateur à sa propre adresse',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search : le lien suffit à savoir quel ordinateur il ouvre.',
          text: 'Le nom d’un ordinateur est la première partie de l’adresse de ses pages. Passez d’un ordinateur à l’autre depuis son nom dans la barre latérale, en restant sur la même page.',
          points: [
            `Les noms sont faits de lettres et de chiffres reliés par des traits d’union, jusqu’à ${DEVICE_NAME_MAX_LENGTH} caractères ; tout nom saisi est écrit ainsi (« Paweł's Mac » devient Pawels-Mac)`,
            'Renommer un ordinateur déplace une page ouverte vers sa nouvelle adresse',
            'Les notifications désignent l’ordinateur par son identifiant : elles l’ouvrent même après un changement de nom',
          ],
        },
        install: {
          title: 'Installer le site comme une app',
          gain: 'Magnetar sur l’écran d’accueil de votre téléphone, en plein écran comme n’importe quelle autre app.',
          text: 'Dans Chrome et Edge, un bouton « Installer l’app » apparaît dans l’en-tête ; Safari l’ajoute depuis le menu Partager.',
          points: [
            'Sur iPhone et iPad, c’est l’installation qui permet au site d’afficher des notifications',
          ],
        },
      },
    },
    notify: {
      title: 'Être prévenu',
      label: 'Notifications',
      lead: 'Quand un téléchargement démarre ou se termine, qu’un suivi trouve quelque chose ou qu’une mise à jour sort : là où vous voulez l’apprendre.',
      features: {
        channels: {
          title: 'Cinq façons d’être prévenu',
          gain: 'Apprenez qu’un téléchargement est terminé sur votre téléphone, dans votre boîte mail ou dans Telegram, sans garder d’onglet ouvert.',
          text: 'Activez au choix les notifications de bureau, le push du navigateur, l’e-mail, ntfy et Telegram, et choisissez d’être prévenu du début des téléchargements, de leur fin, ou des deux. Chaque canal a un bouton « Envoyer une notification de test ».',
          points: [
            'Un canal en panne n’arrête jamais les autres',
            'L’e-mail par votre propre serveur SMTP ; ntfy.sh ou votre propre serveur ntfy ; un bot Telegram',
            'La trouvaille d’un suivi et une nouvelle version ne sont annoncées qu’une fois chacune',
          ],
        },
        push: {
          title: 'Des notifications push que le site ne peut pas lire',
          gain: 'Des notifications sur votre téléphone même quand Magnetar n’est pas ouvert, scellées pour que seul votre téléphone puisse les lire.',
          text: 'Votre ordinateur chiffre chaque notification pour votre navigateur (RFC 8291) avant qu’elle parte ; le site se contente de la signer et de la transmettre. Un appui ouvre la page de cet ordinateur.',
          points: [
            'Seuls les services push de Google, Mozilla, Apple et Microsoft sont acceptés',
            'Un navigateur désabonné est retiré au prochain envoi',
          ],
        },
      },
    },
    app: {
      title: 'L’app',
      label: 'L’app',
      lead: 'Un seul fichier à lancer sur macOS, Windows ou Linux, qui se met à jour tout seul et garde vos données sur votre ordinateur.',
      features: {
        desktop: {
          title: 'Une seule app, rien d’autre à installer',
          gain: 'Téléchargez-la, ouvrez-la, et le tableau de bord est dans votre navigateur : pas d’installateur, pas d’environnement d’exécution, pas de compte nécessaire chez vous.',
          text: 'L’app est un exécutable unique qui contient le tableau de bord, à l’adresse http://localhost:47820. Vos téléchargements, séries et paramètres restent dans une base de données sur votre ordinateur. L’ouvrir une seconde fois ouvre simplement son tableau de bord.',
          points: [
            'macOS (Apple silicon et Intel), Windows et Linux (x64 et ARM)',
            '« Lancer à l’ouverture de session » sur macOS et Windows',
            'Thème clair, sombre ou système, choisi par navigateur',
          ],
        },
        tray: {
          title: 'Dans la barre des menus',
          gain: 'Téléchargements, vitesses et mode ralenti à un clic, sans ouvrir le tableau de bord.',
          text: 'Sur macOS et Windows, une icône dans la barre des menus ou la zone de notification liste vos téléchargements avec leur progression et règle les limites de vitesse à partir de préréglages.',
          points: [
            'Sur macOS, Magnetar vit dans la barre des menus, sans icône dans le Dock',
            'Signale quand une mise à jour est prête',
          ],
        },
        updates: {
          title: 'Des mises à jour de confiance',
          gain: 'Une nouvelle version est à un clic, et seule une version signée par le développeur est installée.',
          text: 'L’app cherche une nouvelle version une minute après son démarrage puis toutes les six heures, vérifie sa signature (Ed25519) avec la clé qu’elle embarque, et l’installe quand vous le décidez. Les téléchargements ne se mettent en pause qu’une fois la mise à jour prête, et reprennent ensuite.',
          points: [
            'Sur macOS, l’app est remplacée après sa fermeture, et restaurée en cas de problème',
            'Notes de version et « Rechercher des mises à jour » dans Paramètres → À propos',
            'Le site fait passer une page ouverte à la nouvelle version au clic suivant, jamais pendant que vous tapez',
          ],
        },
        agents: {
          title: 'Confier la tâche à un agent IA',
          gain: 'Demandez à Claude, Codex ou Gemini de trouver et de télécharger quelque chose, ou de configurer une série, en langage courant.',
          text: 'Activez l’accès des agents et Magnetar propose des outils MCP et une API REST (avec une description OpenAPI) pour la recherche, les téléchargements et les séries. Un clic suffit pour le configurer dans Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode ou Claude Desktop.',
          points: [
            'Désactivé tant que vous ne l’activez pas ; les agents sur une autre machine ont besoin de HTTPS et d’un jeton',
            'Les recherches sont limitées en fréquence, et un agent ne peut enregistrer que dans votre dossier de téléchargement',
          ],
        },
        reports: {
          title: 'Des rapports d’erreur sans vos données',
          gain: 'Quand quelque chose casse, le développeur le sait, sans rien apprendre sur vous ni sur vos téléchargements.',
          text: 'Les erreurs sont débarrassées des noms, chemins, adresses, liens et hachages avant de partir, puis envoyées à CodeFusion Console, où elles sont regroupées par cause. Dix par heure au maximum.',
          points: [
            'Désactivez-les dans Paramètres → Général (« Envoyer des rapports d’erreur anonymes »)',
            'Les erreurs du site sont nettoyées de la même façon',
          ],
        },
        import: {
          title: 'Vous venez de MediaDownloader',
          gain: 'Vos téléchargements, séries et paramètres vous suivent, sans repartir de zéro.',
          text: 'Magnetar lit la base de données de MediaDownloader sans la modifier et importe vos téléchargements, séries et paramètres. Les téléchargements en cours arrivent en pause.',
          points: ['Les mots de passe et les jetons ne sont pas copiés : saisissez-les à nouveau dans Paramètres'],
        },
        languages: {
          title: 'Dans votre langue',
          gain: 'Le tableau de bord et cette page en anglais, allemand, espagnol, français, italien, polonais, portugais et russe.',
          text: 'Choisissez une langue dans Paramètres → Général ; elle s’applique à tous les navigateurs qui ouvrent cet ordinateur. Les pages propres au site suivent la langue de votre navigateur.',
          points: ['Les dates et les heures s’écrivent comme dans votre langue'],
        },
      },
    },
  },
  shots: {
    search: 'Résultats de recherche avec étiquettes de version, fusionnés depuis toutes les sources',
    'search-phone': 'La recherche sur un téléphone, avec les filtres de résolution',
    'search-sources': 'Ce que chaque source a trouvé, et en combien de temps',
    add: 'La fenêtre Ajouter avec des liens magnet collés',
    watchlist: 'La liste À suivre : les séries et leur prochain épisode',
    watches: 'Les suivis de versions, avec la fréquence de vérification de chacun',
    downloads: 'Téléchargements en cours, avec vitesse, pairs et temps restant',
    details: 'Les fichiers d’un téléchargement, chacun avec sa progression',
    player: 'Un film sous licence libre dans le navigateur, avec ses sous-titres anglais',
    speed: 'Limites de vitesse, mode ralenti et son horaire',
    devices: 'Vos appareils sur le site, avec leur état en ligne',
    'remote-phone': 'Les téléchargements d’un ordinateur sur un téléphone, via le site',
    remote: 'L’accès à distance dans les paramètres de l’app, connecté à un compte',
    pair: 'L’approbation d’un ordinateur sur le site',
    'link-qr': 'Un code QR qui associe un téléphone',
    switcher: 'Passer d’un ordinateur à l’autre depuis la barre latérale',
    notifications: 'Les canaux de notification, chacun avec un bouton de test',
    settings: 'Paramètres généraux : langue, thème, lancement à l’ouverture de session',
    about: 'La version et la recherche de mises à jour',
    agents: 'L’accès des agents et la configuration en un clic des agents IA',
  },
  privacy: {
    title: 'La confidentialité en bref',
    label: 'Confidentialité',
    lead: 'Votre ordinateur fait le travail et garde vos données. Le site vous y connecte et ne peut pas lire ce qui transite.',
    items: {
      e2e: { title: 'Chiffré de bout en bout', text: 'Chaque connexion génère de nouvelles clés (ECDH P-256, HKDF), et chaque message est scellé avec AES-256-GCM dans l’ordre : un message rejoué ou réordonné est refusé.' },
      worker: { title: 'Ce que voit le site', text: 'Quels ordinateurs sont sur votre compte, leur nom, leur version et s’ils sont en ligne. Jamais vos recherches, téléchargements, paramètres, fichiers ou notifications.' },
      sealed: { title: 'Des secrets scellés chez vous', text: 'Les mots de passe et les jetons de vos paramètres sont chiffrés sur votre ordinateur, avec une clé conservée à côté de la base de données.' },
      visits: { title: 'Aucun pistage', text: 'Le site compte les pages vues par page uniquement : aucun identifiant de visiteur, aucun cookie pour cela, rien de conservé dans votre navigateur.' },
      local: { title: 'Le local reste local', text: 'Sur votre ordinateur, le tableau de bord ne répond qu’à cet ordinateur lui-même et refuse les pages d’autres sites.' },
    },
  },
  builtOn: {
    title: 'Sur quoi il repose',
    label: 'Technologies',
    lead: 'Open source, sous licence MIT.',
    items: {
      client: { name: 'Rust', text: 'L’app : un exécutable qui contient le tableau de bord, la base de données (SQLite) et le moteur.' },
      engine: { name: 'librqbit', text: 'Le moteur BitTorrent : DHT, trackers, UPnP, reprise rapide et streaming des fichiers inachevés.' },
      dashboard: { name: 'React et daisyUI', text: 'Le tableau de bord, le même build sur votre ordinateur et sur le site.' },
      worker: { name: 'Cloudflare Workers', text: 'Le site : la connexion et les appareils dans D1, et un Durable Object par ordinateur qui relaie ses connexions chiffrées.' },
      packages: { name: 'Paquets CodeFusion', text: 'Du code partagé et testé pour la connexion, le push, les identifiants base58, le thème, les mises à jour de l’app et cette page.' },
      console: { name: 'CodeFusion Console', text: 'Là où les erreurs sont regroupées par cause, et où le développeur voit chaque déploiement et ce qu’il a changé.' },
      releases: { name: 'GitHub Releases', text: 'Six builds par version, compilés par GitHub Actions, leurs sommes de contrôle signées avec Ed25519.' },
    },
  },
  closing: {
    title: 'Essayer Magnetar',
    lead: 'Téléchargez l’app gratuite pour votre ordinateur, puis connectez-vous ici pour y accéder de partout.',
    download: 'Obtenir l’app',
    signIn: 'Se connecter',
  },
}
