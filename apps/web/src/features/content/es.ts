import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from '@codefusion-cc/i18n'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Funciones de Magnetar',
    description: 'Seis fuentes de torrents en una búsqueda, descargas en tu ordenador y acceso cifrado de extremo a extremo desde cualquier navegador o móvil. Gratis para macOS, Windows y Linux.',
  },
  header: { language: 'Idioma', signIn: 'Iniciar sesión', devices: 'Tus dispositivos', home: 'Inicio de Magnetar' },
  hero: {
    badge: 'Gratis para macOS, Windows y Linux',
    title: 'Tus descargas, ',
    accent: 'desde cualquier lugar',
    lead: 'Magnetar busca en seis fuentes de torrents a la vez, descarga en tu propio ordenador y sigue tus series. Ábrelo desde cualquier navegador o móvil: todo lo que viaja entre ellos va cifrado de extremo a extremo. Todas las capturas de esta página son de la app real.',
    primary: 'Ver las funciones',
    secondary: 'Descargar la app',
  },
  stats: { features: n => plural('es', n, { one: 'función', other: 'funciones' }), screenshots: n => plural('es', n, { one: 'captura de la app', other: 'capturas de la app' }), sources: n => plural('es', n, { one: 'fuente de torrents en una búsqueda', other: 'fuentes de torrents en una búsqueda' }), languages: n => plural('es', n, { one: 'idioma', other: 'idiomas' }) },
  copy: {
    skipToFeatures: 'Saltar a las funciones',
    sectionsLabel: 'Secciones de la página',
    overview: { label: 'Resumen', title: 'Todo lo que hace, de un vistazo', lead: 'Elige una función para ver sus capturas y detalles.', count: n => `${n} ${n === 1 ? 'función' : 'funciones'}` },
    contents: 'Contenido',
    whatItGives: 'Lo que te da: ',
    moreDetails: n => `Más detalles (${n})`,
    fewerDetails: 'Menos detalles',
    featureLink: 'Enlace a esta función',
    shots: {
      group: title => `Capturas: ${title}`,
      enlarge: alt => `Ampliar: ${alt}`,
      previous: 'Capturas anteriores',
      next: 'Capturas siguientes',
      previousOne: 'Captura anterior',
      nextOne: 'Captura siguiente',
      of: (index, count) => `${index} de ${count}`,
      close: 'Cerrar',
    },
  },
  groups: {
    find: {
      title: 'Encuéntralo',
      label: 'Buscar',
      lead: 'Una búsqueda en seis fuentes, direcciones legibles para cada lista de resultados y series que se descargan solas.',
      features: {
        sources: {
          title: 'Seis fuentes en una sola búsqueda',
          gain: 'Un solo cuadro de búsqueda en lugar de seis sitios: los resultados llegan a medida que responde cada fuente, y sin anuncios.',
          text: 'Magnetar consulta EZTV, 1337x, Nyaa, The Pirate Bay, RARBG y Torrents-CSV a la vez y une las copias del mismo torrent en una sola fila. Cada resultado muestra su tamaño, sus seeders y los datos de la versión que se leen en su título.',
          points: [
            'Etiquetas de versión sacadas del título: resolución (de 480p a 4K), HDR o Dolby Vision, el códec (H.264, HEVC, AV1) y el origen (BluRay, WEB, HDTV, DVD)',
            'Filtra por resolución y origen; ordena por seeders, más recientes, más grandes o más pequeños',
            'Una fuente lenta o caída nunca retrasa a las demás: la que no responde en 15 segundos se queda fuera, y «Mostrar fuentes» indica lo que encontró cada una',
            'Los servidores espejo se turnan: si uno no responde en segundo y medio, se consulta el siguiente, y se recuerda el más rápido',
            'Solo títulos con todas las palabras que escribiste, en cualquier alfabeto; los títulos con caracteres corruptos se reparan',
            'Abre un resultado para ver sus detalles, copia su enlace magnet o envíalo a cualquier carpeta',
            'Desactiva fuentes en Ajustes → Fuentes',
          ],
        },
        addresses: {
          title: 'Direcciones que se leen y se comparten',
          gain: 'Una búsqueda es un enlace: guárdala en marcadores, recárgala o envíala, y abre los mismos resultados.',
          text: 'Las palabras van en la ruta, y en la consulta solo las opciones que cambiaste: /search/big+buck+bunny?res=1080p&sort=new. El filtro de descargas y cada sección de los ajustes también tienen su propia dirección.',
          points: [
            'Atrás y Adelante pasan de una búsqueda a otra como entre páginas; cambiar un filtro no añade un paso',
            'Los enlaces antiguos se reescriben al formato actual sobre la marcha, así que uno guardado sigue funcionando',
            'Los identificadores que ves están en base58: letras y cifras sin las que se confunden entre sí (0, O, I y l), así que aguantan que se lean en voz alta, se tecleen o se seleccionen con doble clic',
          ],
        },
        add: {
          title: 'Enlaces magnet y archivos .torrent, como los tengas',
          gain: 'Pega una página llena de enlaces o suelta un archivo en cualquier parte: cada torrent empieza por su cuenta, y un enlace erróneo no detiene a los demás.',
          text: 'El diálogo Añadir encuentra todos los enlaces magnet de lo que pegas. Pega uno en cualquier parte de la página, o suelta encima un archivo .torrent, y el diálogo se abre ya relleno, con una carpeta que puedes cambiar.',
          points: [
            `Archivos .torrent de hasta ${torrentMb} MB`,
            'En tu ordenador, Magnetar puede ser la app que abre los enlaces magnet y los archivos .torrent, así que un clic en el navegador o en el gestor de archivos los añade',
            'En la web, el navegador puede enviar los enlaces magnet directamente a tu ordenador («Abrir enlaces magnet aquí» en la página de dispositivos)',
            'Elige otra carpeta en el diálogo, con un explorador de carpetas',
          ],
        },
        series: {
          title: 'Series que se descargan solas',
          gain: 'Los episodios nuevos llegan solos, en la calidad que quieres, sin tener que mirar cada semana.',
          text: 'Añade una serie y Magnetar busca episodios nuevos con la frecuencia que elijas, toma la mejor versión que permitan tus reglas y pasa a la siguiente mejor cuando una no encuentra pares. Los pósteres, las cadenas y las fechas de emisión vienen de TVmaze.',
          points: [
            'Reglas por serie: resolución, mínimo de seeders, tamaño máximo, palabras que preferir y que evitar',
            'Empieza desde el episodio que elijas, desde el último o solo con los episodios nuevos',
            'Comprueba desde cada 15 minutos hasta una vez al día (cada hora por defecto), con un máximo de 25 episodios a la vez',
            'Cada tarjeta muestra la próxima fecha de emisión y cuánto llevas de la serie',
          ],
        },
        watches: {
          title: 'Seguimientos para películas y todo lo demás',
          gain: 'Di una vez qué estás esperando y entérate, o empieza a descargarse, en cuanto aparezca.',
          text: 'Un seguimiento busca una versión según un horario. Cuando la encuentra, te avisa o empieza la descarga, según hayas elegido, y después descansa hasta que lo reactives.',
          points: [
            '«Esperar esto» en la página de búsqueda convierte la búsqueda actual en un seguimiento',
            'Comprueba desde cada hora hasta una vez por semana (cada seis horas por defecto)',
            'Las mismas reglas de calidad que las series',
          ],
        },
      },
    },
    download: {
      title: 'Descárgalo',
      label: 'Descarga',
      lead: 'Un motor BitTorrent integrado: progreso en directo, los archivos que elijas, reproducción mientras descarga y límites que se adaptan a tu día.',
      features: {
        engine: {
          title: 'Un motor de descarga integrado',
          gain: 'Progreso, velocidad, pares y tiempo restante en directo para cada descarga, sin instalar nada más.',
          text: 'Las descargas se ejecutan dentro de Magnetar con librqbit, con DHT y trackers, y el panel se actualiza una vez por segundo. Pausar, reiniciar o actualizar nunca vuelve a leer las piezas ya terminadas.',
          points: [
            'Filtra por activas, en pausa, terminadas o con error; pausa, reanuda, reintenta o elimina cada una',
            'Al eliminar, pregunta si quieres conservar los archivos',
            'La velocidad total de descarga y subida y el espacio libre, que pasa a ser un aviso por debajo de 5 GB',
            'El puerto del router se abre por UPnP, y un torrent que no encuentra pares en tres minutos lo indica en lugar de esperar para siempre',
            'Un torrent de varios archivos tiene su propia carpeta',
          ],
        },
        files: {
          title: 'Solo los archivos que quieres',
          gain: 'Descarga un episodio de una temporada, o sáltate los extras, y sigue cada archivo por separado.',
          text: 'Los detalles de una descarga muestran sus archivos, cada uno con su casilla y su progreso, actualizados cada dos segundos mientras avanza, junto con su tamaño, ratio, fechas, origen y carpeta.',
          points: [
            'Cambia la selección cuando quieras; un botón la guarda',
            '«Mostrar en la carpeta» abre Finder o el Explorador de archivos en el archivo, en tu ordenador',
          ],
        },
        play: {
          title: 'Míralo mientras se descarga',
          gain: 'Empieza a ver un vídeo en el navegador antes de que termine, con los subtítulos que trae.',
          text: 'El reproductor pide la parte del archivo que necesita y Magnetar descarga esas piezas primero. A través de la web, el vídeo viaja por el mismo canal cifrado que todo lo demás.',
          points: [
            'Hasta ocho pistas de subtítulos del torrent; los archivos SRT se convierten al vuelo',
            'En tu ordenador: copia un enlace para VLC o abre el archivo terminado en tu propio reproductor',
            'Desde un móvil u otro navegador, hasta cuatro vídeos a la vez',
          ],
        },
        speed: {
          title: 'Límites que se adaptan a tu día',
          gain: 'Descargas que no acaparan la conexión mientras trabajas, y a toda velocidad por la noche.',
          text: 'Limita las velocidades de descarga y subida, activa los límites alternativos con un toque en la página de descargas o deja que un horario los active por ti. Elige qué pasa cuando termina una descarga.',
          points: [
            `Límites desde ${minSpeedKb} KB/s; en blanco, sin límite`,
            'Los límites alternativos son 2 MB/s de bajada y 512 KB/s de subida salvo que los cambies, y su horario puede pasar de la medianoche',
            'Al terminar: dejar de sembrar, sembrar hasta un ratio (de 0,1 a 100) o seguir sembrando',
          ],
        },
        'kill-switch': {
          title: 'Atado a tu VPN',
          gain: 'El tráfico de torrents nunca sale por la conexión equivocada, aunque se caiga la VPN.',
          text: 'Elige una interfaz de red y todas las conexiones del motor pasan por ella. Cuando desaparece, el motor se detiene y las descargas esperan a que vuelva.',
          points: [
            'En macOS y Linux',
            'La página de descargas explica por qué nada avanza mientras falta la interfaz',
          ],
        },
      },
    },
    anywhere: {
      title: 'Desde cualquier lugar',
      label: 'A distancia',
      lead: 'El mismo panel en tu ordenador y en magnetar.codefusion.cc, conectados a través de un relé que solo transporta bytes cifrados.',
      features: {
        website: {
          title: 'El mismo panel, desde cualquier navegador',
          gain: 'Empieza una descarga desde el móvil en el autobús y te estará esperando en el ordenador de casa.',
          text: 'Inicia sesión en magnetar.codefusion.cc y abre cualquiera de tus ordenadores: la búsqueda, las descargas, el seguimiento y los ajustes funcionan igual que en casa. Tu ordenador hace el trabajo; la web solo te conecta con él.',
          points: [
            'Tus dispositivos con su estado de conexión, actualizado cada 15 segundos',
            'En el móvil, una barra de pestañas abajo; en el ordenador, una barra lateral',
            'Lo que solo tiene sentido delante del ordenador (su selector de carpetas, abrir archivos) se queda allí',
            'Inicio de sesión con Google; las sesiones duran 30 días desde tu última visita',
          ],
        },
        pairing: {
          title: 'Conecta un ordenador con un clic',
          gain: 'Sin códigos que copiar: la app abre la web, das tu aprobación y el ordenador es tuyo.',
          text: 'En Ajustes → Acceso remoto, «Conectar con tu cuenta» abre la web con un enlace de emparejamiento. Inicia sesión, aprueba y la app recoge su clave. El nombre de dispositivo que elegiste pasa a ser su dirección.',
          points: [
            'Un enlace de emparejamiento sirve durante diez minutos, y la clave se entrega una sola vez',
            'Hasta 20 ordenadores por cuenta',
            'La web solo guarda un hash del token de cada ordenador',
          ],
        },
        phone: {
          title: 'Vincula un móvil con un código QR',
          gain: 'Apunta la cámara del móvil a la pantalla y abrirá tu ordenador, ya vinculado.',
          text: 'Cada navegador recibe su propia clave, creada en tu ordenador. El código QR la lleva en la parte del enlace que nunca llega a un servidor; el móvil la guarda donde sus scripts pueden usarla, pero nunca leerla.',
          points: [
            'Los navegadores vinculados aparecen con su último uso, cada uno con un botón Revocar',
            'Un navegador sin la clave ve que no está vinculado, nunca tus datos',
          ],
        },
        'device-addresses': {
          title: 'Cada ordenador en su propia dirección',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: por el enlace sabes qué ordenador abre.',
          text: 'El nombre de un ordenador es la primera parte de las direcciones de sus páginas. Cambia de ordenador desde el nombre en la barra lateral sin salir de la página en la que estás.',
          points: [
            `Los nombres son letras y cifras unidas por guiones, de hasta ${DEVICE_NAME_MAX_LENGTH} caracteres; cualquier nombre que escribas se adapta a esa forma («Mac de Paweł» pasa a ser Mac-de-Pawel)`,
            'Al renombrar un ordenador, una página abierta pasa a su nueva dirección',
            'Las notificaciones enlazan al ordenador por su id, así que lo abren incluso después de renombrarlo',
          ],
        },
        install: {
          title: 'Instala la web como una app',
          gain: 'Magnetar en la pantalla de inicio del móvil, abriéndose a pantalla completa como cualquier otra app.',
          text: 'En Chrome y Edge aparece un botón «Instalar app» en la cabecera; en Safari se añade desde el menú Compartir.',
          points: [
            'En iPhone y iPad, instalarla es lo que permite a la web mostrar notificaciones',
          ],
        },
      },
    },
    notify: {
      title: 'Entérate',
      label: 'Notificaciones',
      lead: 'Cuando una descarga empieza o termina, un seguimiento encuentra algo o sale una actualización: donde quieras enterarte.',
      features: {
        channels: {
          title: 'Cinco formas de enterarte',
          gain: 'Entérate de que terminó una descarga en el móvil, en tu correo o en Telegram, sin tener una pestaña abierta.',
          text: 'Activa los que quieras entre escritorio, push del navegador, correo electrónico, ntfy y Telegram, y elige si quieres enterarte de las descargas que empiezan, de las que terminan o de ambas. Cada canal tiene un botón «Enviar notificación de prueba».',
          points: [
            'Si un canal falla, los demás siguen funcionando',
            'Correo a través de tu propio servidor SMTP; ntfy.sh o tu propio servidor ntfy; un bot de Telegram',
            'Lo que encuentra un seguimiento y cada versión nueva de la app se avisan una sola vez',
          ],
        },
        push: {
          title: 'Push que la web no puede leer',
          gain: 'Notificaciones en el móvil aunque Magnetar no esté abierto, selladas para que solo tu móvil pueda leerlas.',
          text: 'Tu ordenador cifra cada notificación para tu navegador (RFC 8291) antes de enviarla; la web solo la firma y la reenvía. Al tocarla se abre la página de ese ordenador.',
          points: [
            'Solo se aceptan los servicios push de Google, Mozilla, Apple y Microsoft',
            'Un navegador que canceló la suscripción se descarta en el siguiente envío',
          ],
        },
      },
    },
    app: {
      title: 'La app',
      label: 'La app',
      lead: 'Un solo archivo para macOS, Windows o Linux, que se mantiene al día por sí solo y guarda tus datos en tu ordenador.',
      features: {
        desktop: {
          title: 'Una app, nada más que instalar',
          gain: 'Descárgala, ábrela y tendrás el panel en el navegador: sin instalador, sin entorno de ejecución y sin necesidad de cuenta en casa.',
          text: 'La app es un único ejecutable con el panel dentro, en http://localhost:47820. Tus descargas, series y ajustes se quedan en una base de datos en tu ordenador. Si la abres por segunda vez, solo se abre su panel.',
          points: [
            'macOS (Apple silicon e Intel), Windows y Linux (x64 y ARM)',
            '«Iniciar al iniciar sesión» en macOS y Windows',
            'Tema claro, oscuro o del sistema, elegido en cada navegador',
          ],
        },
        tray: {
          title: 'En la barra de menús',
          gain: 'Descargas, velocidades y límites alternativos a un clic, sin abrir el panel.',
          text: 'En macOS y Windows, un icono en la barra de menús o en el área de notificación muestra tus descargas con su progreso y fija límites de velocidad predefinidos.',
          points: [
            'En macOS, Magnetar vive en la barra de menús, sin icono en el Dock',
            'Avisa cuando hay una actualización lista',
          ],
        },
        updates: {
          title: 'Actualizaciones de confianza',
          gain: 'Una nueva versión está a un clic, y solo se instala si la ha firmado el desarrollador.',
          text: 'La app busca una nueva versión un minuto después de arrancar y cada seis horas, comprueba su firma (Ed25519) con la clave que lleva integrada y la instala cuando tú lo dices. Las descargas solo se pausan cuando la actualización está lista, y se reanudan después.',
          points: [
            'En macOS, la app se sustituye después de cerrarse, y se restaura la anterior si algo sale mal',
            'Notas de la versión y «Buscar actualizaciones» en Ajustes → Acerca de',
            'La web pasa una página abierta a la nueva versión en el siguiente clic, nunca mientras escribes',
          ],
        },
        agents: {
          title: 'Deja que lo haga un agente de IA',
          gain: 'Pide a Claude, Codex o Gemini que busque y descargue algo, o que configure una serie, con tus propias palabras.',
          text: 'Activa el acceso de agentes y Magnetar ofrece herramientas MCP y una API REST (con descripción OpenAPI) para la búsqueda, las descargas y las series. Un clic lo configura en Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode o Claude Desktop.',
          points: [
            'Desactivado hasta que lo actives; los agentes de otra máquina necesitan HTTPS y un token',
            'Las búsquedas tienen un límite de frecuencia, y un agente solo puede guardar dentro de tu carpeta de descargas',
          ],
        },
        reports: {
          title: 'Informes de errores sin tus datos',
          gain: 'Cuando algo falla, el desarrollador se entera, sin saber nada de ti ni de tus descargas.',
          text: 'Antes de salir, a los errores se les quitan nombres, rutas, direcciones, enlaces y hashes, y van a CodeFusion Console, donde se agrupan por causa. Como mucho, diez por hora.',
          points: [
            'Desactívalos en Ajustes → General («Enviar informes de errores anónimos»)',
            'Los errores de la web se limpian de la misma forma',
          ],
        },
        import: {
          title: 'Si vienes de MediaDownloader',
          gain: 'Tus descargas, series y ajustes se vienen contigo, sin empezar de cero.',
          text: 'Magnetar lee la base de datos de MediaDownloader sin modificarla e importa tus descargas, series y ajustes. Las descargas que estaban en curso llegan en pausa.',
          points: ['Las contraseñas y los tokens no se copian: vuelve a introducirlos en Ajustes'],
        },
        languages: {
          title: 'En tu idioma',
          gain: 'El panel y esta página en inglés, alemán, español, francés, italiano, polaco, portugués y ruso.',
          text: 'Elige un idioma en Ajustes → General; se aplica a todos los navegadores que abran ese ordenador. Las páginas propias de la web siguen el idioma de tu navegador.',
          points: ['Las fechas y horas se escriben como se escriben en tu idioma'],
        },
      },
    },
  },
  shots: {
    search: 'Resultados de búsqueda con etiquetas de versión, reunidos de todas las fuentes',
    'search-phone': 'Búsqueda en un móvil, con los botones de resolución',
    'search-sources': 'Lo que encontró cada fuente y lo rápido que respondió',
    add: 'El diálogo Añadir con enlaces magnet pegados',
    watchlist: 'El seguimiento: series con su próximo episodio',
    watches: 'Seguimientos de versiones, con la frecuencia con que comprueba cada uno',
    downloads: 'Descargas en curso, con velocidad, pares y tiempo restante',
    details: 'Los archivos de una descarga, cada uno con su progreso',
    player: 'Una película de licencia libre en el navegador, con sus subtítulos en inglés',
    speed: 'Límites de velocidad, límites alternativos y su horario',
    devices: 'Tus dispositivos en la web, con su estado de conexión',
    'remote-phone': 'Las descargas de un ordenador en un móvil, a través de la web',
    remote: 'Acceso remoto en los ajustes de la app, conectado a una cuenta',
    pair: 'Aprobación de un ordenador en la web',
    'link-qr': 'Un código QR que vincula un móvil',
    switcher: 'Cambio de ordenador desde la barra lateral',
    notifications: 'Canales de notificación, cada uno con un botón de prueba',
    settings: 'Ajustes generales: idioma, tema, inicio al iniciar sesión',
    about: 'La versión y la búsqueda de actualizaciones',
    agents: 'Acceso de agentes y configuración con un clic para agentes de IA',
  },
  privacy: {
    title: 'La privacidad, en resumen',
    label: 'Privacidad',
    lead: 'Tu ordenador hace el trabajo y guarda tus datos. La web te conecta con él y no puede leer lo que pasa por ella.',
    items: {
      e2e: { title: 'Cifrado de extremo a extremo', text: 'Cada conexión crea claves nuevas (ECDH P-256, HKDF), y cada mensaje se sella con AES-256-GCM en orden, así que uno repetido o desordenado se rechaza.' },
      worker: { title: 'Lo que ve la web', text: 'Qué ordenadores hay en tu cuenta, sus nombres, sus versiones y si están en línea. Nunca tus búsquedas, descargas, ajustes, archivos ni notificaciones.' },
      sealed: { title: 'Secretos sellados en casa', text: 'Las contraseñas y los tokens de tus ajustes se cifran en tu ordenador, con una clave guardada junto a la base de datos.' },
      visits: { title: 'Sin rastreo', text: 'La web cuenta las visitas solo por página: sin identificador de visitante, sin cookies para ello y sin nada guardado en tu navegador.' },
      local: { title: 'Lo local se queda en local', text: 'En tu ordenador, el panel solo responde a ese mismo ordenador y rechaza páginas de otros sitios.' },
    },
  },
  builtOn: {
    title: 'Sobre qué funciona',
    label: 'Tecnología',
    lead: 'Código abierto, con licencia MIT.',
    items: {
      client: { name: 'Rust', text: 'La app: un único ejecutable con el panel, la base de datos (SQLite) y el motor dentro.' },
      engine: { name: 'librqbit', text: 'El motor BitTorrent: DHT, trackers, UPnP, reanudación rápida y streaming de archivos sin terminar.' },
      dashboard: { name: 'React y daisyUI', text: 'El panel, la misma compilación en tu ordenador y en la web.' },
      worker: { name: 'Cloudflare Workers', text: 'La web: inicio de sesión y dispositivos en D1, y un Durable Object por ordenador que retransmite sus conexiones cifradas.' },
      packages: { name: 'Paquetes de CodeFusion', text: 'Código compartido y probado para el inicio de sesión, las notificaciones push, los identificadores base58, el tema, las actualizaciones de la app y esta página.' },
      console: { name: 'CodeFusion Console', text: 'Donde los errores se agrupan por causa y donde el desarrollador ve cada despliegue y lo que cambió.' },
      releases: { name: 'GitHub Releases', text: 'Seis compilaciones por versión, generadas con GitHub Actions, con sus sumas de comprobación firmadas con Ed25519.' },
    },
  },
  closing: {
    title: 'Prueba Magnetar',
    lead: 'Descarga la app gratuita para tu ordenador y después inicia sesión aquí para acceder a ella desde cualquier lugar.',
    download: 'Descargar la app',
    signIn: 'Iniciar sesión',
  },
}
