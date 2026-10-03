import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const en: FeaturesContent = {
  meta: {
    title: 'Magnetar features',
    description: 'Search six torrent sources at once, download on your own computer and follow it from any browser or phone, end-to-end encrypted. Free for macOS, Windows and Linux.',
  },
  header: { language: 'Language', signIn: 'Sign in', devices: 'Your devices', home: 'Magnetar home' },
  hero: {
    badge: 'Free for macOS, Windows and Linux',
    title: 'Your downloads, ',
    accent: 'from anywhere',
    lead: 'Magnetar searches six torrent sources at once, downloads on your own computer and follows your series. Open it from any browser or phone: everything between them is end-to-end encrypted. Every screenshot on this page is the real app.',
    primary: 'See the features',
    secondary: 'Get the app',
  },
  stats: { features: n => plural('en', n, { one: 'feature', other: 'features' }), screenshots: n => plural('en', n, { one: 'screenshot of the app', other: 'screenshots of the app' }), sources: n => plural('en', n, { one: 'torrent source in one search', other: 'torrent sources in one search' }), languages: n => plural('en', n, { one: 'language', other: 'languages' }) },
  copy: {
    skipToFeatures: 'Skip to the features',
    sectionsLabel: 'Page sections',
    overview: { label: 'Overview', title: 'Everything it does, at a glance', lead: 'Pick a feature to see its screenshots and details.', count: n => `${n} ${n === 1 ? 'feature' : 'features'}` },
    contents: 'Contents',
    whatItGives: 'What it gives: ',
    moreDetails: n => `More details (${n})`,
    fewerDetails: 'Fewer details',
    featureLink: 'Link to this feature',
    shots: {
      group: title => `Screenshots: ${title}`,
      enlarge: alt => `Enlarge: ${alt}`,
      previous: 'Previous screenshots',
      next: 'Next screenshots',
      previousOne: 'Previous screenshot',
      nextOne: 'Next screenshot',
      of: (index, count) => `${index} of ${count}`,
      close: 'Close',
    },
  },
  groups: {
    find: {
      title: 'Find it',
      label: 'Search',
      lead: 'One search across six sources, readable addresses for every result list, and series that download themselves.',
      features: {
        sources: {
          title: 'Six sources in one search',
          gain: 'One search box instead of six sites: results arrive as each source answers, without the ads.',
          text: 'Magnetar asks EZTV, 1337x, Nyaa, The Pirate Bay, RARBG and Torrents-CSV at the same time and merges copies of the same torrent into one row. Each result shows its size, seeders and the release details read from its title.',
          points: [
            'Release tags from the title: resolution (480p to 4K), HDR or Dolby Vision, the codec (H.264, HEVC, AV1) and the source (BluRay, WEB, HDTV, DVD)',
            'Narrow by resolution and source; sort by seeders, newest, largest or smallest',
            'A source that is slow or down never holds up the others: one that hasn\'t answered in 15 seconds is left out, and "Show sources" says what each one found',
            'Mirrors take turns: when one doesn\'t answer within a second and a half, the next is asked, and the fastest is remembered',
            'Only titles with every word you typed, in any script; garbled titles are repaired',
            'Open a result for its details, copy its magnet link, or send it to any folder',
            'Switch sources off in Settings → Sources',
          ],
        },
        addresses: {
          title: 'Addresses you can read and share',
          gain: 'A search is a link: bookmark it, reload it or send it, and it opens the same results.',
          text: 'The words go in the path and only the choices you changed in the query: /search/big+buck+bunny?res=1080p&sort=new. The downloads filter and each settings section have their own address too.',
          points: [
            'Back and Forward move between searches as between pages; changing a filter doesn\'t add a step',
            'Older links are rewritten to the current form in place, so a saved one keeps working',
            'Ids you see are base58: letters and digits without the look-alikes 0, O, I and l, so they survive being read aloud, typed or double-clicked',
          ],
        },
        add: {
          title: 'Magnet links and .torrent files, any way you have them',
          gain: 'Paste a page full of links or drop a file anywhere: each torrent starts on its own, and a bad link doesn\'t stop the rest.',
          text: 'The Add dialog finds every magnet link in what you paste. Paste one anywhere on the page, or drop a .torrent file on it, and the dialog opens already filled in, with a folder you can change.',
          points: [
            `.torrent files up to ${torrentMb} MB`,
            'On your computer Magnetar can become the handler for magnet links and .torrent files, so a click in the browser or the file manager adds them',
            'On the website, the browser can send magnet links straight to your computer ("Open magnet links here" on the devices page)',
            'Pick another folder in the dialog, with a folder browser',
          ],
        },
        series: {
          title: 'Series that download themselves',
          gain: 'New episodes arrive on their own, in the quality you want, without checking every week.',
          text: 'Add a series and Magnetar checks for new episodes as often as you choose, takes the best release your rules allow, and moves on to the next best when one finds no peers. Posters, networks and air dates come from TVmaze.',
          points: [
            'Rules per series: resolution, minimum seeders, maximum size, words to prefer and to avoid',
            'Start from an episode you choose, from the latest one, or with new episodes only',
            'Checks every 15 minutes to once a day (every hour by default), at most 25 episodes at a time',
            'Each card shows the next air date and how far along the series is',
          ],
        },
        watches: {
          title: 'Watches for films and anything else',
          gain: 'Say what you are waiting for once, and hear about it, or have it downloading, the moment it appears.',
          text: 'A watch searches for a release on a schedule. When it finds one it tells you or starts the download, as you chose, then rests until you re-arm it.',
          points: [
            '"Watch for this" on the search page turns the current search into a watch',
            'Checks every hour to once a week (every six hours by default)',
            'The same quality rules as series',
          ],
        },
      },
    },
    download: {
      title: 'Download it',
      label: 'Download',
      lead: 'A BitTorrent engine built in: live progress, the files you pick, playback while it runs, and limits that follow your day.',
      features: {
        engine: {
          title: 'A download engine built in',
          gain: 'Live progress, speed, peers and time left for every download, with nothing else to install.',
          text: 'Downloads run inside Magnetar on librqbit, with DHT and trackers, and the dashboard updates once a second. Pausing, restarting or an update never reads finished pieces again.',
          points: [
            'Filter by active, paused, finished or failed; pause, resume, retry or delete each one',
            'Deleting asks whether to keep the files',
            'Total download and upload speed and the free space left, which turns to a warning below 5 GB',
            'The router\'s port is opened by UPnP, and a torrent that finds no peers in three minutes says so instead of waiting forever',
            'A torrent of several files gets its own folder',
          ],
        },
        files: {
          title: 'Just the files you want',
          gain: 'Download one episode out of a season, or skip the extras, and follow each file on its own.',
          text: 'A download\'s details list its files with a checkbox each and their progress, refreshed every two seconds while it runs, with its size, ratio, dates, source and folder.',
          points: [
            'Change the selection at any time; one button saves it',
            '"Show in folder" opens Finder or Explorer at the file, on your computer',
          ],
        },
        play: {
          title: 'Watch while it downloads',
          gain: 'Start watching a video in the browser before it has finished, with the subtitles that came with it.',
          text: 'The player asks for the part of the file it needs and Magnetar fetches those pieces first. Through the website the video travels over the same encrypted channel as everything else.',
          points: [
            'Up to eight subtitle tracks from the torrent; SRT files are converted on the fly',
            'On your computer: copy a link for VLC, or open the finished file in your own player',
            'From a phone or another browser, up to four videos at once',
          ],
        },
        browse: {
          title: 'Your downloads, folder by folder',
          gain: 'See what landed where, play it, or pick a new download folder, from the computer or from your phone.',
          text: 'Files shows the download folder and any folder you add on the computer running Magnetar: folders first, then files, with their sizes and dates. Files that came from a download can be played or opened in its details.',
          points: [
            'Sorted as people read names: episode 2 before episode 10',
            'Make a folder, or use the one on screen as the download folder',
            'Through the website, only these folders can be seen, over the same encrypted channel; hidden files and links leading out of them stay out',
            'Folders are added only on the computer itself, never from another device',
          ],
        },
        speed: {
          title: 'Limits that follow your day',
          gain: 'Downloads that don\'t take the whole connection while you work, and full speed at night.',
          text: 'Cap download and upload speeds, switch to slow mode with one tap on the downloads page, or let a schedule switch it for you. Choose what happens when a download finishes.',
          points: [
            `Caps from ${minSpeedKb} KB/s; blank is no limit`,
            'Slow mode is 2 MB/s down and 512 KB/s up unless you change it, and its schedule can run overnight',
            'When finished: stop seeding, seed to a ratio (0.1 to 100), or keep seeding',
          ],
        },
        'kill-switch': {
          title: 'Bound to your VPN',
          gain: 'Torrent traffic never leaves through the wrong connection, even if the VPN drops.',
          text: 'Choose a network interface and every connection of the engine goes through it. When it disappears, the engine stops and downloads wait until it is back.',
          points: [
            'On macOS and Linux',
            'The downloads page says why nothing moves while the interface is missing',
          ],
        },
      },
    },
    anywhere: {
      title: 'From anywhere',
      label: 'Anywhere',
      lead: 'The same dashboard on your computer and on magnetar.codefusion.cc, connected through a relay that only ever carries encrypted bytes.',
      features: {
        website: {
          title: 'The same dashboard, from any browser',
          gain: 'Start a download from your phone on the bus and it is waiting on your computer at home.',
          text: 'Sign in at magnetar.codefusion.cc and open any of your computers: search, downloads, the watchlist and settings work as they do at home. Your computer does the work; the website only connects you to it.',
          points: [
            'Your devices with their online state, refreshed every 15 seconds',
            'A phone gets a tab bar at the bottom, a computer a sidebar',
            'What only makes sense at the computer (its folder picker, opening files) stays there',
            'Google sign-in; sessions last 30 days from your last visit, and signing out disconnects that browser from your computers at once',
          ],
        },
        pairing: {
          title: 'Connect a computer in one click',
          gain: 'No codes to copy: the app opens the website, you approve, and the computer is yours.',
          text: 'In Settings → Remote access, "Connect to your account" opens the website with a pairing link. Sign in, approve, and the app collects its key. The device name you chose becomes its address.',
          points: [
            'A pairing link works for ten minutes, and the key is handed over once',
            'Up to 20 computers per account',
            'The website keeps only a hash of each computer\'s token',
          ],
        },
        phone: {
          title: 'Link a phone with a QR code',
          gain: 'Point your phone\'s camera at the screen and it opens your computer, already linked.',
          text: 'Each browser gets its own key, made on your computer. The QR code carries it in the part of the link that never reaches a server; the phone stores it where its scripts can use it but never read it.',
          points: [
            'Linked browsers are listed with their last use, each with a Revoke button',
            'A browser without the key sees that it isn\'t linked, never your data',
          ],
        },
        'device-addresses': {
          title: 'Each computer at its own address',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: you can tell from the link which computer it opens.',
          text: 'A computer\'s name is the first part of its pages\' addresses. Switch between computers from the name in the sidebar and stay on the same page.',
          points: [
            `Names are letters and digits joined by hyphens, up to ${DEVICE_NAME_MAX_LENGTH} characters; any name you type is spelled that way ("Paweł's Mac" becomes Pawels-Mac)`,
            'Renaming a computer moves an open page to its new address',
            'Notifications link to the computer by its id, so they open it even after a rename',
          ],
        },
        install: {
          title: 'Install the website as an app',
          gain: 'Magnetar on your phone\'s home screen, opening full screen like any other app.',
          text: 'In Chrome and Edge an "Install app" button appears in the header; Safari adds it from the Share menu.',
          points: [
            'On iPhone and iPad, installing it is what lets the website show notifications',
          ],
        },
      },
    },
    notify: {
      title: 'Hear about it',
      label: 'Notifications',
      lead: 'When a download starts or finishes, a watch finds something, or an update is out: wherever you want to hear it.',
      features: {
        channels: {
          title: 'Five ways to be told',
          gain: 'Hear that a download finished on your phone, in your inbox or in Telegram, without keeping a tab open.',
          text: 'Turn on any of the desktop, browser push, e-mail, ntfy and Telegram, and choose whether to hear about downloads starting, finishing, or both. Each channel has a "Send a test" button.',
          points: [
            'One channel failing never stops the others',
            'E-mail through your own SMTP server; ntfy.sh or your own ntfy server; a Telegram bot',
            'A watch\'s find and a new version are told once each',
          ],
        },
        push: {
          title: 'Push the website can\'t read',
          gain: 'Notifications on your phone even when Magnetar isn\'t open, sealed so only your phone can read them.',
          text: 'Your computer encrypts each notification for your browser (RFC 8291) before it leaves; the website only signs it and passes it on. A tap opens that computer\'s page.',
          points: [
            'Only Google\'s, Mozilla\'s, Apple\'s and Microsoft\'s push services are accepted',
            'A browser that unsubscribed is dropped on the next send',
          ],
        },
      },
    },
    app: {
      title: 'The app',
      label: 'The app',
      lead: 'One file to run on macOS, Windows or Linux, which keeps itself up to date and keeps your data on your computer.',
      features: {
        desktop: {
          title: 'One app, nothing else to install',
          gain: 'Download it, open it, and the dashboard is in your browser: no installer, no runtime, no account needed at home.',
          text: 'The app is a single executable with the dashboard inside, at http://localhost:47820. Your downloads, series and settings stay in a database on your computer. Opening it a second time just opens its dashboard.',
          points: [
            'macOS (Apple silicon and Intel), Windows and Linux (x64 and ARM)',
            'Start at login on macOS and Windows',
            'The light, dark or system theme, chosen per browser',
          ],
        },
        tray: {
          title: 'In the menu bar',
          gain: 'Downloads, speeds and slow mode one click away, without opening the dashboard.',
          text: 'On macOS and Windows an icon in the menu bar or notification area lists your downloads with their progress and sets speed limits from presets.',
          points: [
            'On macOS Magnetar lives in the menu bar, without a Dock icon',
            'Shows when an update is ready',
          ],
        },
        updates: {
          title: 'Updates you can trust',
          gain: 'A new version is one click away, and only one signed by the developer is installed.',
          text: 'The app checks for a new version a minute after it starts and every six hours, checks its signature (Ed25519) against the key built into it, and installs it when you say so. Downloads pause only once the update is ready, and resume after.',
          points: [
            'On macOS the app is swapped after it quits, and put back if anything goes wrong',
            'Release notes and "Check for updates" in Settings → About',
            'The website moves an open page onto a new version on the next click, never while you are typing',
          ],
        },
        agents: {
          title: 'Let an AI agent do it',
          gain: 'Ask Claude, Codex or Gemini to find and download something, or to set up a series, in plain words.',
          text: 'Turn on agent access and Magnetar offers MCP tools and a REST API (with an OpenAPI description) for search, downloads and series. One click sets it up in Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode or Claude Desktop.',
          points: [
            'Off until you turn it on; agents on another machine need HTTPS and a token',
            'Searches are rate limited, and an agent can only save inside your download folder',
          ],
        },
        reports: {
          title: 'Error reports without your data',
          gain: 'When something breaks, the developer hears about it, without anything about you or your downloads.',
          text: 'Errors are scrubbed of names, paths, addresses, links and hashes before they leave, and go to CodeFusion Console, where they are grouped by cause. At most ten an hour.',
          points: [
            'Turn them off in Settings → General ("Send anonymous error reports")',
            'Website errors are scrubbed the same way',
          ],
        },
        import: {
          title: 'Coming from MediaDownloader',
          gain: 'Your downloads, series and settings come along, without starting over.',
          text: 'Magnetar reads MediaDownloader\'s database without changing it and imports your downloads, series and settings. Downloads that were running arrive paused.',
          points: ['Passwords and tokens are not copied: enter them again in Settings'],
        },
        languages: {
          title: 'In your language',
          gain: 'The dashboard and this page in English, German, Spanish, French, Italian, Polish, Portuguese and Russian.',
          text: 'Pick a language in Settings → General; it applies to every browser that opens that computer. The website\'s own pages follow your browser\'s language.',
          points: ['Dates and times are written the way your language writes them'],
        },
      },
    },
  },
  shots: {
    search: 'Search results with release tags, merged from every source',
    'search-phone': 'Search on a phone, with the resolution chips',
    'search-sources': 'What each source found, and how fast',
    add: 'The Add dialog with magnet links pasted in',
    watchlist: 'The watchlist: series with their next episode',
    watches: 'Watches for releases, with how often each checks',
    downloads: 'Downloads in progress, with speed, peers and time left',
    details: 'A download\'s files, each with its progress',
    player: 'A freely licensed film playing in the browser, with its English subtitles',
    speed: 'Speed limits, slow mode and its schedule',
    devices: 'Your devices on the website, with their online state',
    'remote-phone': 'A computer\'s downloads on a phone, through the website',
    remote: 'Remote access in the app\'s settings, connected to an account',
    pair: 'Approving a computer on the website',
    'link-qr': 'A QR code that links a phone',
    switcher: 'Switching between computers from the sidebar',
    notifications: 'Notification channels, each with a test button',
    settings: 'General settings: language, theme, start at login',
    about: 'The version and its update check',
    agents: 'Agent access and one-click setup for AI agents',
  },
  privacy: {
    title: 'Privacy in short',
    label: 'Privacy',
    lead: 'Your computer does the work and keeps your data. The website connects you to it and can\'t read what passes through.',
    items: {
      e2e: { title: 'End-to-end encrypted', text: 'Every connection makes fresh keys (ECDH P-256, HKDF), and each message is sealed with AES-256-GCM in order, so a replayed or reordered one is refused.' },
      worker: { title: 'What the website sees', text: 'Which computers are on your account, their names, versions and whether they are online. Never your searches, downloads, settings, files or notifications.' },
      sealed: { title: 'Secrets sealed at home', text: 'Passwords and tokens in your settings are encrypted on your computer, under a key kept beside the database.' },
      visits: { title: 'No tracking', text: 'The website counts page views by page only: no visitor id, no cookies for it, nothing kept in your browser.' },
      local: { title: 'Local stays local', text: 'On your computer the dashboard answers only that computer itself, and refuses pages from other sites.' },
    },
  },
  builtOn: {
    title: 'What it runs on',
    label: 'Built on',
    lead: 'Open source, MIT licensed.',
    items: {
      client: { name: 'Rust', text: 'The app: one executable with the dashboard, the database (SQLite) and the engine inside.' },
      engine: { name: 'librqbit', text: 'The BitTorrent engine: DHT, trackers, UPnP, fast resume and streaming of unfinished files.' },
      dashboard: { name: 'React and daisyUI', text: 'The dashboard, the same build on your computer and on the website.' },
      worker: { name: 'Cloudflare Workers', text: 'The website: sign-in and devices in D1, and a Durable Object per computer that relays its encrypted connections.' },
      packages: { name: 'CodeFusion packages', text: 'Shared, tested code for sign-in, push, base58 ids, the theme, app updates and this page.' },
      console: { name: 'CodeFusion Console', text: 'Where errors are grouped by cause, and where the developer sees each deploy and what it changed.' },
      releases: { name: 'GitHub Releases', text: 'Six builds per version, built by GitHub Actions, their checksums signed with Ed25519.' },
    },
  },
  closing: {
    title: 'Try Magnetar',
    lead: 'Download the free app for your computer, then sign in here to reach it from anywhere.',
    download: 'Get the app',
    signIn: 'Sign in',
  },
}
