import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Funkcje Magnetara',
    description: 'Sześć źródeł torrentów naraz, pobieranie na własnym komputerze i dostęp z przeglądarki lub telefonu, szyfrowany end-to-end. Za darmo na macOS, Windows i Linux.',
  },
  header: { language: 'Język', signIn: 'Zaloguj się', devices: 'Twoje urządzenia', home: 'Strona główna Magnetara' },
  hero: {
    badge: 'Za darmo na macOS, Windows i Linux',
    title: 'Twoje pobierania ',
    accent: 'z dowolnego miejsca',
    lead: 'Magnetar przeszukuje sześć źródeł torrentów naraz, pobiera na Twoim komputerze i śledzi Twoje seriale. Otwierasz go z dowolnej przeglądarki lub telefonu, a wszystko, co płynie między nimi, jest szyfrowane end-to-end. Każdy zrzut ekranu na tej stronie pokazuje prawdziwą aplikację.',
    primary: 'Zobacz funkcje',
    secondary: 'Pobierz aplikację',
  },
  stats: { features: n => plural('pl', n, { one: 'funkcja', few: 'funkcje', other: 'funkcji' }), screenshots: n => plural('pl', n, { one: 'zrzut ekranu aplikacji', few: 'zrzuty ekranu aplikacji', other: 'zrzutów ekranu aplikacji' }), sources: n => plural('pl', n, { one: 'źródło torrentów w jednym wyszukiwaniu', few: 'źródła torrentów w jednym wyszukiwaniu', other: 'źródeł torrentów w jednym wyszukiwaniu' }), languages: n => plural('pl', n, { one: 'język', few: 'języki', other: 'języków' }) },
  copy: {
    skipToFeatures: 'Przejdź do funkcji',
    sectionsLabel: 'Sekcje strony',
    overview: { label: 'Przegląd', title: 'Wszystko, co potrafi, w jednym miejscu', lead: 'Wybierz funkcję, by zobaczyć jej zrzuty ekranu i szczegóły.', count: n => `${n} ${n === 1 ? 'funkcja' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'funkcje' : 'funkcji'}` },
    contents: 'Spis treści',
    whatItGives: 'Co daje: ',
    moreDetails: n => `Więcej szczegółów (${n})`,
    fewerDetails: 'Mniej szczegółów',
    featureLink: 'Link do tej funkcji',
    shots: {
      group: title => `Zrzuty ekranu: ${title}`,
      enlarge: alt => `Powiększ: ${alt}`,
      previous: 'Poprzednie zrzuty ekranu',
      next: 'Następne zrzuty ekranu',
      previousOne: 'Poprzedni zrzut ekranu',
      nextOne: 'Następny zrzut ekranu',
      of: (index, count) => `${index} z ${count}`,
      close: 'Zamknij',
    },
  },
  groups: {
    find: {
      title: 'Znajdź',
      label: 'Szukaj',
      lead: 'Jedno wyszukiwanie w sześciu źródłach, czytelne adresy każdej listy wyników i seriale, które pobierają się same.',
      features: {
        sources: {
          title: 'Sześć źródeł w jednym wyszukiwaniu',
          gain: 'Jedno pole wyszukiwania zamiast sześciu stron: wyniki spływają w miarę, jak odpowiadają kolejne źródła, i to bez reklam.',
          text: 'Magnetar pyta jednocześnie EZTV, 1337x, Nyaa, The Pirate Bay, RARBG i Torrents-CSV, a kopie tego samego torrenta łączy w jeden wiersz. Przy każdym wyniku widać rozmiar, liczbę seedów i szczegóły wydania odczytane z tytułu.',
          points: [
            'Tagi wydania z tytułu: rozdzielczość (od 480p do 4K), HDR lub Dolby Vision, kodek (H.264, HEVC, AV1) i źródło (BluRay, WEB, HDTV, DVD)',
            'Zawężanie według rozdzielczości i źródła; sortowanie według liczby seedów, od najnowszych, największych lub najmniejszych',
            'Wolne lub niedziałające źródło nigdy nie wstrzymuje pozostałych: to, które nie odpowie w 15 sekund, zostaje pominięte, a „Pokaż źródła” mówi, co znalazło każde z nich',
            'Serwery lustrzane działają na zmianę: gdy jeden nie odpowie w półtorej sekundy, pytany jest następny, a najszybszy zostaje zapamiętany',
            'Tylko tytuły zawierające każde wpisane słowo, w dowolnym alfabecie; zniekształcone tytuły są naprawiane',
            'Otwórz wynik, by zobaczyć szczegóły, skopiuj jego link magnet albo wyślij go do dowolnego folderu',
            'Źródła wyłączysz w sekcji Ustawienia → Źródła',
          ],
        },
        addresses: {
          title: 'Adresy, które da się przeczytać i udostępnić',
          gain: 'Wyszukiwanie to link: dodaj go do zakładek, odśwież albo wyślij, a otworzy te same wyniki.',
          text: 'Słowa trafiają do ścieżki, a do zapytania tylko te opcje, które zmienisz: /search/big+buck+bunny?res=1080p&sort=new. Filtr pobierania i każda sekcja ustawień też mają własny adres.',
          points: [
            'Wstecz i Dalej przechodzą między wyszukiwaniami jak między stronami; zmiana filtra nie dodaje kroku',
            'Starsze linki są od razu przepisywane na obecną postać, więc zapisany link nadal działa',
            'Widoczne identyfikatory są w base58: litery i cyfry bez łatwych do pomylenia 0, O, I i l, więc przetrwają czytanie na głos, przepisywanie i podwójne kliknięcie',
          ],
        },
        add: {
          title: 'Linki magnet i pliki .torrent – skądkolwiek je masz',
          gain: 'Wklej stronę pełną linków albo upuść plik w dowolnym miejscu: każdy torrent startuje osobno, a błędny link nie zatrzymuje reszty.',
          text: 'Okno „Dodaj” znajduje każdy link magnet we wklejonym tekście. Wklej link w dowolnym miejscu strony albo upuść na nią plik .torrent, a okno otworzy się już wypełnione, z folderem, który możesz zmienić.',
          points: [
            `Pliki .torrent do ${torrentMb} MB`,
            'Na komputerze Magnetar może obsługiwać linki magnet i pliki .torrent, więc dodasz je jednym kliknięciem w przeglądarce lub menedżerze plików',
            'Na stronie przeglądarka może wysyłać linki magnet prosto na Twój komputer („Otwieraj linki magnet tutaj” na stronie urządzeń)',
            'Inny folder wybierzesz w oknie, w przeglądarce folderów',
          ],
        },
        series: {
          title: 'Seriale, które pobierają się same',
          gain: 'Nowe odcinki pojawiają się same, w wybranej jakości, bez sprawdzania co tydzień.',
          text: 'Dodaj serial, a Magnetar będzie szukał nowych odcinków tak często, jak zechcesz, weźmie najlepsze wydanie dozwolone przez Twoje zasady, a gdy któreś nie znajdzie peerów, przejdzie do następnego w kolejności. Plakaty, stacje i daty emisji pochodzą z TVmaze.',
          points: [
            'Zasady dla każdego serialu: rozdzielczość, minimalna liczba seedów, maksymalny rozmiar, słowa preferowane i wykluczone',
            'Start od wybranego odcinka, od najnowszego albo tylko z nowymi odcinkami',
            'Sprawdzanie od co 15 minut do raz dziennie (domyślnie co godzinę), najwyżej 25 odcinków naraz',
            'Każda karta pokazuje datę emisji następnego odcinka i postęp serialu',
          ],
        },
        watches: {
          title: 'Obserwacje filmów i nie tylko',
          gain: 'Raz powiedz, na co czekasz, a dowiesz się o tym albo zaczniesz pobierać, gdy tylko się pojawi.',
          text: 'Obserwacja szuka wydania według harmonogramu. Gdy je znajdzie, powiadamia Cię albo zaczyna pobieranie, zależnie od Twojego wyboru, a potem czeka, aż włączysz ją ponownie.',
          points: [
            '„Czekaj na to” na stronie wyszukiwania zamienia bieżące wyszukiwanie w obserwację',
            'Sprawdzanie od co godzinę do raz w tygodniu (domyślnie co sześć godzin)',
            'Te same zasady jakości co w serialach',
          ],
        },
      },
    },
    download: {
      title: 'Pobierz',
      label: 'Pobieranie',
      lead: 'Wbudowany silnik BitTorrent: postęp na żywo, tylko wybrane pliki, odtwarzanie w trakcie pobierania i limity dopasowane do Twojego dnia.',
      features: {
        engine: {
          title: 'Wbudowany silnik pobierania',
          gain: 'Postęp, prędkość, peery i pozostały czas każdego pobierania na żywo, bez instalowania czegokolwiek więcej.',
          text: 'Pobieranie działa wewnątrz Magnetara na librqbit, z DHT i trackerami, a panel odświeża się co sekundę. Wstrzymanie, ponowne uruchomienie ani aktualizacja nigdy nie każą ponownie odczytywać ukończonych fragmentów.',
          points: [
            'Filtr: aktywne, wstrzymane, ukończone lub nieudane; każde pobieranie możesz wstrzymać, wznowić, ponowić albo usunąć',
            'Przy usuwaniu pojawia się pytanie, czy zachować pliki',
            'Łączna prędkość pobierania i wysyłania oraz wolne miejsce, które poniżej 5 GB zmienia się w ostrzeżenie',
            'Port na routerze otwiera UPnP, a torrent, który przez trzy minuty nie znajdzie peerów, mówi o tym, zamiast czekać w nieskończoność',
            'Torrent z kilkoma plikami dostaje własny folder',
          ],
        },
        files: {
          title: 'Tylko te pliki, których chcesz',
          gain: 'Pobierz jeden odcinek z całego sezonu albo pomiń dodatki i śledź każdy plik osobno.',
          text: 'Szczegóły pobierania pokazują jego pliki, każdy z polem wyboru i postępem odświeżanym co dwie sekundy w trakcie pobierania, a także rozmiar, współczynnik, daty, źródło i folder.',
          points: [
            'Wybór możesz zmienić w każdej chwili; zapisuje go jeden przycisk',
            '„Pokaż w folderze” otwiera Finder lub Explorer przy danym pliku, na Twoim komputerze',
          ],
        },
        play: {
          title: 'Oglądaj w trakcie pobierania',
          gain: 'Zacznij oglądać wideo w przeglądarce, zanim się pobierze, z napisami dołączonymi do torrenta.',
          text: 'Odtwarzacz prosi o potrzebną część pliku, a Magnetar pobiera te fragmenty w pierwszej kolejności. Przez stronę wideo płynie tym samym szyfrowanym kanałem co wszystko inne.',
          points: [
            'Do ośmiu ścieżek napisów z torrenta; pliki SRT są konwertowane w locie',
            'Na komputerze: skopiuj link do VLC albo otwórz gotowy plik we własnym odtwarzaczu',
            'Z telefonu lub innej przeglądarki do czterech filmów naraz',
          ],
        },
        browse: {
          title: 'Twoje pobrania, folder po folderze',
          gain: 'Zobacz, co gdzie trafiło, odtwórz to albo wybierz nowy folder pobierania, z komputera lub z telefonu.',
          text: 'Pliki pokazują folder pobierania i każdy folder dodany na komputerze, na którym działa Magnetar: najpierw foldery, potem pliki, z rozmiarem i datą. Pliki z pobrania można odtworzyć albo otworzyć w jego szczegółach.',
          points: [
            'Kolejność, w jakiej czyta się nazwy: odcinek 2 przed odcinkiem 10',
            'Utwórz folder albo ustaw widoczny jako folder pobierania',
            'Przez stronę widać tylko te foldery, tym samym szyfrowanym kanałem; ukryte pliki i linki prowadzące poza nie zostają pominięte',
            'Foldery dodaje się tylko na samym komputerze, nigdy z innego urządzenia',
          ],
        },
        speed: {
          title: 'Limity dopasowane do Twojego dnia',
          gain: 'Pobieranie nie zajmuje całego łącza, gdy pracujesz, a nocą idzie pełną prędkością.',
          text: 'Ogranicz prędkość pobierania i wysyłania, włącz limity alternatywne jednym kliknięciem na stronie Pobierania albo zostaw ich przełączanie harmonogramowi. Wybierz też, co ma się stać po ukończeniu pobierania.',
          points: [
            `Limity od ${minSpeedKb} KB/s; puste pole oznacza brak limitu`,
            'Limity alternatywne to domyślnie 2 MB/s pobierania i 512 KB/s wysyłania, a ich harmonogram może obejmować noc',
            'Po ukończeniu: zatrzymaj seedowanie, seeduj do współczynnika (od 0,1 do 100) albo kontynuuj seedowanie',
          ],
        },
        'kill-switch': {
          title: 'Przypięte do VPN',
          gain: 'Ruch torrentów nigdy nie wychodzi niewłaściwym połączeniem, nawet gdy VPN się rozłączy.',
          text: 'Wybierz interfejs sieciowy, a każde połączenie silnika przejdzie przez niego. Gdy interfejs zniknie, silnik się zatrzymuje, a pobieranie czeka na jego powrót.',
          points: [
            'Na macOS i Linuksie',
            'Strona Pobierania wyjaśnia, dlaczego nic się nie rusza, gdy brakuje interfejsu',
          ],
        },
      },
    },
    anywhere: {
      title: 'Z każdego miejsca',
      label: 'Wszędzie',
      lead: 'Ten sam panel na komputerze i na magnetar.codefusion.cc, połączony przez przekaźnik, który przenosi wyłącznie zaszyfrowane bajty.',
      features: {
        website: {
          title: 'Ten sam panel w każdej przeglądarce',
          gain: 'Uruchom pobieranie z telefonu w autobusie, a w domu będzie już czekać na komputerze.',
          text: 'Zaloguj się na magnetar.codefusion.cc i otwórz dowolny ze swoich komputerów: wyszukiwanie, pobieranie, Obserwowane i ustawienia działają tak jak w domu. Pracę wykonuje Twój komputer; strona tylko Cię z nim łączy.',
          points: [
            'Twoje urządzenia ze stanem online, odświeżanym co 15 sekund',
            'Telefon dostaje pasek kart na dole, komputer – pasek boczny',
            'To, co ma sens tylko przy komputerze (wybór folderu, otwieranie plików), zostaje na komputerze',
            'Logowanie przez Google; sesja trwa 30 dni od ostatniej wizyty, a wylogowanie od razu odłącza tę przeglądarkę od Twoich komputerów',
          ],
        },
        pairing: {
          title: 'Połącz komputer jednym kliknięciem',
          gain: 'Bez przepisywania kodów: aplikacja otwiera stronę, Ty zatwierdzasz, a komputer trafia na Twoje konto.',
          text: 'Przycisk „Połącz z kontem” w sekcji Ustawienia → Dostęp zdalny otwiera stronę z linkiem parowania. Zaloguj się, zatwierdź, a aplikacja odbierze swój klucz. Wybrana nazwa urządzenia staje się jego adresem.',
          points: [
            'Link parowania działa przez dziesięć minut, a klucz jest przekazywany tylko raz',
            'Do 20 komputerów na konto',
            'Strona przechowuje tylko hash tokenu każdego komputera',
          ],
        },
        phone: {
          title: 'Połącz telefon kodem QR',
          gain: 'Skieruj aparat telefonu na ekran, a otworzy się Twój komputer, już połączony.',
          text: 'Każda przeglądarka dostaje własny klucz, utworzony na Twoim komputerze. Kod QR przenosi go w tej części linku, która nigdy nie trafia na serwer; telefon zapisuje go tam, gdzie skrypty strony mogą go używać, ale nigdy go nie odczytają.',
          points: [
            'Połączone przeglądarki są wymienione z datą ostatniego użycia, każda z przyciskiem „Odbierz dostęp”',
            'Przeglądarka bez klucza widzi, że nie jest połączona, ale nigdy nie zobaczy Twoich danych',
          ],
        },
        'device-addresses': {
          title: 'Każdy komputer pod własnym adresem',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: już z linku widać, który komputer otwiera.',
          text: 'Nazwa komputera to pierwsza część adresów jego stron. Przełączaj się między komputerami, klikając nazwę na pasku bocznym, i zostań na tej samej stronie.',
          points: [
            `Nazwy to litery i cyfry połączone łącznikami, do ${DEVICE_NAME_MAX_LENGTH} znaków; każda wpisana nazwa jest zapisywana w tej postaci („Mac Pawła” staje się Mac-Pawla)`,
            'Zmiana nazwy komputera przenosi otwartą stronę pod nowy adres',
            'Powiadomienia wskazują komputer po identyfikatorze, więc otwierają go także po zmianie nazwy',
          ],
        },
        install: {
          title: 'Zainstaluj stronę jako aplikację',
          gain: 'Magnetar na ekranie początkowym telefonu, otwierany na pełnym ekranie jak każda inna aplikacja.',
          text: 'W Chrome i Edge w nagłówku pojawia się przycisk „Zainstaluj aplikację”; w Safari dodasz ją z menu Udostępnij.',
          points: [
            'Na iPhonie i iPadzie dopiero instalacja pozwala stronie wyświetlać powiadomienia',
          ],
        },
      },
    },
    notify: {
      title: 'Bądź na bieżąco',
      label: 'Powiadomienia',
      lead: 'Gdy pobieranie się zaczyna lub kończy, obserwacja coś znajduje albo wychodzi aktualizacja – tam, gdzie chcesz się o tym dowiedzieć.',
      features: {
        channels: {
          title: 'Pięć sposobów powiadamiania',
          gain: 'Dowiedz się o ukończonym pobieraniu na telefonie, w skrzynce e-mail albo na Telegramie, bez trzymania otwartej karty.',
          text: 'Włącz dowolne kanały – powiadomienia na pulpicie, push w przeglądarce, e-mail, ntfy i Telegram – i wybierz, czy chcesz wiedzieć o rozpoczęciu pobierania, o jego ukończeniu, czy o obu. Każdy kanał ma przycisk „Wyślij testowe powiadomienie”.',
          points: [
            'Awaria jednego kanału nigdy nie zatrzymuje pozostałych',
            'E-mail przez Twój własny serwer SMTP; ntfy.sh lub własny serwer ntfy; bot Telegram',
            'O znalezisku obserwacji i o nowej wersji dowiesz się tylko raz',
          ],
        },
        push: {
          title: 'Push, którego strona nie przeczyta',
          gain: 'Powiadomienia na telefonie, nawet gdy Magnetar nie jest otwarty, zaszyfrowane tak, że odczyta je tylko Twój telefon.',
          text: 'Twój komputer szyfruje każde powiadomienie dla Twojej przeglądarki (RFC 8291), zanim je wyśle; strona tylko je podpisuje i przekazuje dalej. Dotknięcie otwiera stronę tego komputera.',
          points: [
            'Akceptowane są tylko usługi push Google, Mozilli, Apple i Microsoftu',
            'Przeglądarka, która zrezygnowała z subskrypcji, jest usuwana przy następnej wysyłce',
          ],
        },
      },
    },
    app: {
      title: 'Aplikacja',
      label: 'Aplikacja',
      lead: 'Jeden plik do uruchomienia na macOS, Windows lub Linuksie, który sam się aktualizuje i trzyma Twoje dane na Twoim komputerze.',
      features: {
        desktop: {
          title: 'Jedna aplikacja, nic więcej do instalowania',
          gain: 'Pobierz, otwórz, a panel pojawi się w przeglądarce: bez instalatora, bez środowiska uruchomieniowego i bez konta w domu.',
          text: 'Aplikacja to jeden plik wykonywalny z panelem w środku, pod adresem http://localhost:47820. Twoje pobierania, seriale i ustawienia zostają w bazie danych na Twoim komputerze. Ponowne uruchomienie po prostu otwiera jej panel.',
          points: [
            'macOS (Apple silicon i Intel), Windows i Linux (x64 i ARM)',
            '„Uruchamiaj po zalogowaniu” na macOS i Windows',
            'Motyw jasny, ciemny lub systemowy, wybierany osobno w każdej przeglądarce',
          ],
        },
        tray: {
          title: 'Na pasku menu',
          gain: 'Pobierania, prędkości i limity alternatywne o jedno kliknięcie, bez otwierania panelu.',
          text: 'Na macOS i Windows ikona na pasku menu lub w obszarze powiadomień pokazuje Twoje pobierania z postępem i ustawia limity prędkości z gotowych wartości.',
          points: [
            'Na macOS Magnetar działa na pasku menu, bez ikony w Docku',
            'Pokazuje, kiedy aktualizacja jest gotowa',
          ],
        },
        updates: {
          title: 'Aktualizacje, którym można ufać',
          gain: 'Nowa wersja jest o jedno kliknięcie, a zainstalowana zostanie tylko taka, którą podpisał twórca.',
          text: 'Aplikacja szuka nowej wersji minutę po uruchomieniu i potem co sześć godzin, sprawdza jej podpis (Ed25519) kluczem wbudowanym w aplikację i instaluje ją, gdy się na to zgodzisz. Pobieranie zostaje wstrzymane dopiero wtedy, gdy aktualizacja jest gotowa, a potem jest wznawiane.',
          points: [
            'Na macOS aplikacja jest podmieniana po zamknięciu, a jeśli coś pójdzie nie tak, wraca poprzednia wersja',
            'Informacje o wydaniu i „Sprawdź aktualizacje” w sekcji Ustawienia → O aplikacji',
            'Strona przenosi otwartą kartę na nową wersję przy następnym kliknięciu, nigdy w trakcie pisania',
          ],
        },
        agents: {
          title: 'Niech zajmie się tym agent AI',
          gain: 'Poproś Claude, Codex albo Gemini zwykłymi słowami, by coś znalazł i pobrał albo skonfigurował serial.',
          text: 'Włącz dostęp dla agentów, a Magnetar udostępni narzędzia MCP i REST API (z opisem OpenAPI) do wyszukiwania, pobierania i seriali. Jedno kliknięcie konfiguruje go w Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode lub Claude Desktop.',
          points: [
            'Wyłączony, dopóki go nie włączysz; agenci na innej maszynie potrzebują HTTPS i tokenu',
            'Wyszukiwania mają limit częstotliwości, a agent może zapisywać tylko w Twoim folderze pobierania',
          ],
        },
        reports: {
          title: 'Raporty o błędach bez Twoich danych',
          gain: 'Gdy coś się psuje, twórca się o tym dowiaduje, ale nie dowiaduje się niczego o Tobie ani o Twoich pobieraniach.',
          text: 'Przed wysłaniem z błędów usuwane są nazwy, ścieżki, adresy, linki i hashe, a potem trafiają one do CodeFusion Console, gdzie są grupowane według przyczyny. Najwyżej dziesięć na godzinę.',
          points: [
            'Wyłączysz je w sekcji Ustawienia → Ogólne („Wysyłaj anonimowe raporty o błędach”)',
            'Błędy strony są czyszczone w ten sam sposób',
          ],
        },
        import: {
          title: 'Przesiadka z MediaDownloadera',
          gain: 'Twoje pobierania, seriale i ustawienia przechodzą razem z Tobą, bez zaczynania od zera.',
          text: 'Magnetar odczytuje bazę danych MediaDownloadera, niczego w niej nie zmieniając, i importuje Twoje pobierania, seriale i ustawienia. Pobierania, które były w toku, trafiają jako wstrzymane.',
          points: ['Hasła i tokeny nie są kopiowane: wpisz je ponownie w Ustawieniach'],
        },
        languages: {
          title: 'W Twoim języku',
          gain: 'Panel i ta strona po angielsku, niemiecku, hiszpańsku, francusku, włosku, polsku, portugalsku i rosyjsku.',
          text: 'Język wybierzesz w sekcji Ustawienia → Ogólne; obowiązuje w każdej przeglądarce, która otwiera ten komputer. Własne strony serwisu podążają za językiem przeglądarki.',
          points: ['Daty i godziny są zapisywane tak, jak przyjęło się w Twoim języku'],
        },
      },
    },
  },
  shots: {
    search: 'Wyniki wyszukiwania z tagami wydań, połączone ze wszystkich źródeł',
    'search-phone': 'Wyszukiwanie na telefonie, z filtrami rozdzielczości',
    'search-sources': 'Co znalazło każde źródło i jak szybko',
    add: 'Okno „Dodaj” z wklejonymi linkami magnet',
    watchlist: 'Obserwowane: seriale z następnym odcinkiem',
    watches: 'Obserwacje wydań i to, jak często każda sprawdza',
    downloads: 'Trwające pobierania z prędkością, peerami i pozostałym czasem',
    details: 'Pliki pobierania, każdy z własnym postępem',
    player: 'Film na wolnej licencji odtwarzany w przeglądarce, z angielskimi napisami',
    speed: 'Limity prędkości, limity alternatywne i ich harmonogram',
    devices: 'Twoje urządzenia na stronie, ze stanem online',
    'remote-phone': 'Pobierania komputera na telefonie, przez stronę',
    remote: 'Dostęp zdalny w ustawieniach aplikacji, połączony z kontem',
    pair: 'Zatwierdzanie komputera na stronie',
    'link-qr': 'Kod QR, który łączy telefon',
    switcher: 'Przełączanie między komputerami z paska bocznego',
    notifications: 'Kanały powiadomień, każdy z przyciskiem testu',
    settings: 'Ustawienia ogólne: język, motyw, uruchamianie po zalogowaniu',
    about: 'Wersja i sprawdzanie aktualizacji',
    agents: 'Dostęp dla agentów i konfiguracja agentów AI jednym kliknięciem',
  },
  privacy: {
    title: 'Prywatność w skrócie',
    label: 'Prywatność',
    lead: 'Pracę wykonuje Twój komputer i to on przechowuje Twoje dane. Strona łączy Cię z nim i nie może odczytać tego, co przez nią przechodzi.',
    items: {
      e2e: { title: 'Szyfrowanie end-to-end', text: 'Każde połączenie tworzy nowe klucze (ECDH P-256, HKDF), a każda wiadomość jest szyfrowana AES-256-GCM w ustalonej kolejności, więc powtórzona lub przestawiona wiadomość zostaje odrzucona.' },
      worker: { title: 'Co widzi strona', text: 'Które komputery są na Twoim koncie, ich nazwy, wersje i to, czy są online. Nigdy Twoich wyszukiwań, pobierań, ustawień, plików ani powiadomień.' },
      sealed: { title: 'Sekrety zaszyfrowane w domu', text: 'Hasła i tokeny z ustawień są szyfrowane na Twoim komputerze kluczem przechowywanym obok bazy danych.' },
      visits: { title: 'Bez śledzenia', text: 'Strona liczy wyświetlenia tylko według podstron: bez identyfikatora odwiedzającego, bez ciasteczek do tego celu i bez zapisywania czegokolwiek w przeglądarce.' },
      local: { title: 'Lokalne zostaje lokalne', text: 'Na Twoim komputerze panel odpowiada tylko temu komputerowi i odrzuca strony z innych witryn.' },
    },
  },
  builtOn: {
    title: 'Na czym działa',
    label: 'Technologie',
    lead: 'Otwarte źródło, licencja MIT.',
    items: {
      client: { name: 'Rust', text: 'Aplikacja: jeden plik wykonywalny z panelem, bazą danych (SQLite) i silnikiem w środku.' },
      engine: { name: 'librqbit', text: 'Silnik BitTorrent: DHT, trackery, UPnP, szybkie wznawianie i strumieniowanie nieukończonych plików.' },
      dashboard: { name: 'React i daisyUI', text: 'Panel – ta sama kompilacja na Twoim komputerze i na stronie.' },
      worker: { name: 'Cloudflare Workers', text: 'Strona: logowanie i urządzenia w D1 oraz osobny Durable Object dla każdego komputera, który przekazuje jego zaszyfrowane połączenia.' },
      packages: { name: 'Pakiety CodeFusion', text: 'Wspólny, przetestowany kod logowania, powiadomień push, identyfikatorów base58, motywu, aktualizacji aplikacji i tej strony.' },
      console: { name: 'CodeFusion Console', text: 'Tu błędy są grupowane według przyczyny, a twórca widzi każde wdrożenie i to, co zmieniło.' },
      releases: { name: 'GitHub Releases', text: 'Sześć kompilacji każdej wersji, budowanych przez GitHub Actions, z sumami kontrolnymi podpisanymi Ed25519.' },
    },
  },
  closing: {
    title: 'Wypróbuj Magnetar',
    lead: 'Pobierz darmową aplikację na komputer, a potem zaloguj się tutaj, by mieć do niej dostęp z każdego miejsca.',
    download: 'Pobierz aplikację',
    signIn: 'Zaloguj się',
  },
}
