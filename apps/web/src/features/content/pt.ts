import { DEVICE_NAME_MAX_LENGTH } from '@magnetar/protocol/device-name'
import { MAX_TORRENT_FILE, MIN_SPEED_LIMIT } from '@magnetar/protocol/limits'
import { plural } from './plural.ts'
import type { FeaturesContent } from './types.ts'

const torrentMb = MAX_TORRENT_FILE / 1024 / 1024
const minSpeedKb = MIN_SPEED_LIMIT / 1024

export const content: FeaturesContent = {
  meta: {
    title: 'Funcionalidades do Magnetar',
    description: 'Pesquise seis fontes de torrents de uma vez, transfira no seu computador e siga tudo no navegador ou telemóvel, encriptado. Grátis para macOS, Windows e Linux.',
  },
  header: { language: 'Idioma', signIn: 'Entrar', devices: 'Seus dispositivos', home: 'Página inicial do Magnetar' },
  hero: {
    badge: 'Gratuito para macOS, Windows e Linux',
    title: 'As suas transferências, ',
    accent: 'em qualquer lugar',
    lead: 'O Magnetar pesquisa em seis fontes de torrents ao mesmo tempo, transfere no seu próprio computador e acompanha as suas séries. Abra-o a partir de qualquer navegador ou telemóvel: tudo o que passa entre eles tem encriptação ponto a ponto. Todas as capturas de ecrã desta página são da aplicação real.',
    primary: 'Ver as funcionalidades',
    secondary: 'Obter a app',
  },
  stats: { features: n => plural('pt', n, { one: 'funcionalidade', other: 'funcionalidades' }), screenshots: n => plural('pt', n, { one: 'captura de ecrã da aplicação', other: 'capturas de ecrã da aplicação' }), sources: n => plural('pt', n, { one: 'fonte de torrents numa só pesquisa', other: 'fontes de torrents numa só pesquisa' }), languages: n => plural('pt', n, { one: 'idioma', other: 'idiomas' }) },
  copy: {
    skipToFeatures: 'Saltar para as funcionalidades',
    sectionsLabel: 'Secções da página',
    overview: { label: 'Visão geral', title: 'Tudo o que faz, num relance', lead: 'Escolha uma funcionalidade para ver as capturas de ecrã e os detalhes.', count: n => `${n} ${n === 1 ? 'funcionalidade' : 'funcionalidades'}` },
    contents: 'Índice',
    whatItGives: 'O que lhe dá: ',
    moreDetails: n => `Mais detalhes (${n})`,
    fewerDetails: 'Menos detalhes',
    featureLink: 'Ligação para esta funcionalidade',
    shots: {
      group: title => `Capturas de ecrã: ${title}`,
      enlarge: alt => `Ampliar: ${alt}`,
      previous: 'Capturas anteriores',
      next: 'Capturas seguintes',
      previousOne: 'Captura anterior',
      nextOne: 'Captura seguinte',
      of: (index, count) => `${index} de ${count}`,
      close: 'Fechar',
    },
  },
  groups: {
    find: {
      title: 'Encontrar',
      label: 'Pesquisar',
      lead: 'Uma pesquisa em seis fontes, endereços legíveis para cada lista de resultados e séries que se transferem sozinhas.',
      features: {
        sources: {
          title: 'Seis fontes numa só pesquisa',
          gain: 'Uma caixa de pesquisa em vez de seis sites: os resultados chegam à medida que cada fonte responde, sem anúncios.',
          text: 'O Magnetar consulta EZTV, 1337x, Nyaa, The Pirate Bay, RARBG e Torrents-CSV ao mesmo tempo e junta as cópias do mesmo torrent numa só linha. Cada resultado mostra o tamanho, os seeders e os detalhes da versão lidos do título.',
          points: [
            'Etiquetas da versão lidas do título: resolução (480p a 4K), HDR ou Dolby Vision, o codec (H.264, HEVC, AV1) e a origem (BluRay, WEB, HDTV, DVD)',
            'Filtre por resolução e origem; ordene por mais seeders, mais recentes, maiores ou menores',
            'Uma fonte lenta ou em baixo nunca atrasa as outras: a que não responder em 15 segundos fica de fora, e «Mostrar fontes» diz o que cada uma encontrou',
            'Os espelhos revezam-se: quando um não responde em segundo e meio, pergunta-se ao seguinte, e o mais rápido fica memorizado',
            'Só títulos com todas as palavras que escreveu, em qualquer alfabeto; os títulos com caracteres corrompidos são reparados',
            'Abra um resultado para ver os detalhes, copie a ligação magnet ou envie-o para qualquer pasta',
            'Desative fontes em Definições → Fontes',
          ],
        },
        addresses: {
          title: 'Endereços que se leem e partilham',
          gain: 'Uma pesquisa é uma ligação: guarde-a nos favoritos, recarregue-a ou envie-a, e abre os mesmos resultados.',
          text: 'As palavras vão no caminho e, nos parâmetros, só as opções que alterou: /search/big+buck+bunny?res=1080p&sort=new. O filtro das transferências e cada secção das definições também têm o seu próprio endereço.',
          points: [
            'Recuar e Avançar passam de uma pesquisa para outra como entre páginas; mudar um filtro não acrescenta um passo',
            'As ligações antigas passam ao formato atual sem sair da página, por isso uma ligação guardada continua a funcionar',
            'Os ids que vê estão em base58: letras e algarismos sem os que se confundem, 0, O, I e l, por isso resistem a ser ditados, escritos à mão ou selecionados com duplo clique',
          ],
        },
        add: {
          title: 'Ligações magnet e ficheiros .torrent, como os tiver',
          gain: 'Cole uma página cheia de ligações ou largue um ficheiro em qualquer lado: cada torrent começa por si, e uma ligação inválida não trava as restantes.',
          text: 'A janela Adicionar encontra todas as ligações magnet no que colar. Cole uma em qualquer parte da página, ou largue nela um ficheiro .torrent, e a janela abre já preenchida, com uma pasta que pode alterar.',
          points: [
            `Ficheiros .torrent até ${torrentMb} MB`,
            'No seu computador, o Magnetar pode passar a abrir as ligações magnet e os ficheiros .torrent, por isso basta um clique no navegador ou no gestor de ficheiros para os adicionar',
            'No site, o navegador pode enviar as ligações magnet diretamente para o seu computador («Abrir ligações magnet aqui» na página dos dispositivos)',
            'Escolha outra pasta na janela, com um explorador de pastas',
          ],
        },
        series: {
          title: 'Séries que se transferem sozinhas',
          gain: 'Os novos episódios chegam sozinhos, na qualidade que quer, sem ter de verificar todas as semanas.',
          text: 'Adicione uma série e o Magnetar procura novos episódios com a frequência que escolher, fica com a melhor versão que as suas regras permitem e passa à seguinte quando uma não encontra pares. Os pósteres, os canais e as datas de estreia vêm do TVmaze.',
          points: [
            'Regras por série: resolução, mínimo de seeders, tamanho máximo, palavras a preferir e a evitar',
            'Comece por um episódio à sua escolha, pelo mais recente ou só com os novos',
            'Verifica de 15 em 15 minutos até uma vez por dia (de hora a hora por omissão), no máximo 25 episódios de cada vez',
            'Cada cartão mostra a próxima data de estreia e o progresso da série',
          ],
        },
        watches: {
          title: 'À espera de filmes e de tudo o resto',
          gain: 'Diga uma vez do que está à espera e seja avisado, ou tenha a transferência a decorrer, assim que aparecer.',
          text: 'Um seguimento procura uma versão segundo um horário. Quando a encontra, avisa-o ou inicia a transferência, conforme escolheu, e depois fica parado até o reativar.',
          points: [
            '«Esperar isto», na página de pesquisa, transforma a pesquisa atual num seguimento',
            'Verifica de hora a hora até uma vez por semana (de seis em seis horas por omissão)',
            'As mesmas regras de qualidade das séries',
          ],
        },
      },
    },
    download: {
      title: 'Transferir',
      label: 'Transferências',
      lead: 'Um motor BitTorrent integrado: progresso em tempo real, os ficheiros que escolher, reprodução durante a transferência e limites que acompanham o seu dia.',
      features: {
        engine: {
          title: 'Um motor de transferências integrado',
          gain: 'Progresso, velocidade, pares e tempo restante de cada transferência em tempo real, sem mais nada para instalar.',
          text: 'As transferências correm dentro do Magnetar, com o librqbit, DHT e trackers, e o painel atualiza-se a cada segundo. Pausar, reiniciar ou atualizar nunca volta a ler as partes já concluídas.',
          points: [
            'Filtre por ativas, em pausa, concluídas ou com erro; pause, retome, tente novamente ou elimine cada uma',
            'Ao eliminar, pergunta se quer manter os ficheiros',
            'Velocidade total de receção e envio e o espaço livre, que passa a aviso abaixo de 5 GB',
            'A porta do router é aberta por UPnP, e um torrent que não encontra pares em três minutos avisa em vez de esperar para sempre',
            'Um torrent com vários ficheiros fica numa pasta própria',
          ],
        },
        files: {
          title: 'Só os ficheiros que quer',
          gain: 'Transfira um episódio de uma temporada inteira, ou deixe os extras de fora, e acompanhe cada ficheiro em separado.',
          text: 'Os detalhes de uma transferência listam os ficheiros, cada um com uma caixa de seleção e o seu progresso, atualizado a cada dois segundos enquanto decorre, além do tamanho, rácio, datas, origem e pasta.',
          points: [
            'Altere a seleção a qualquer momento; um botão guarda-a',
            '«Mostrar na pasta» abre o Finder ou o Explorer no ficheiro, no seu computador',
          ],
        },
        play: {
          title: 'Veja enquanto transfere',
          gain: 'Comece a ver um vídeo no navegador antes de a transferência terminar, com as legendas que vieram com ele.',
          text: 'O leitor pede o trecho do ficheiro de que precisa e o Magnetar vai buscar essas partes primeiro. Através do site, o vídeo viaja pelo mesmo canal encriptado que todo o resto.',
          points: [
            'Até oito faixas de legendas do torrent; os ficheiros SRT são convertidos na hora',
            'No seu computador: copie uma ligação para o VLC ou abra o ficheiro concluído no seu próprio leitor',
            'A partir de um telemóvel ou de outro navegador, até quatro vídeos em simultâneo',
          ],
        },
        speed: {
          title: 'Limites que acompanham o seu dia',
          gain: 'Transferências que não ocupam a ligação toda enquanto trabalha, e velocidade máxima à noite.',
          text: 'Limite as velocidades de receção e envio, ative os limites alternativos com um toque na página Transferências ou deixe que um horário o faça por si. Escolha o que acontece quando uma transferência termina.',
          points: [
            `Limites a partir de ${minSpeedKb} KB/s; em branco é sem limite`,
            'Os limites alternativos são 2 MB/s de receção e 512 KB/s de envio, salvo se os alterar, e o horário pode atravessar a noite',
            'Ao terminar: parar o seeding, seeding até um rácio (0,1 a 100) ou continuar o seeding',
          ],
        },
        'kill-switch': {
          title: 'Sempre pela sua VPN',
          gain: 'O tráfego torrent nunca sai pela ligação errada, mesmo que a VPN caia.',
          text: 'Escolha uma interface de rede e todas as ligações do motor passam por ela. Quando desaparece, o motor para e as transferências esperam até ela voltar.',
          points: [
            'No macOS e no Linux',
            'A página Transferências diz porque nada avança enquanto a interface não está disponível',
          ],
        },
      },
    },
    anywhere: {
      title: 'De qualquer lugar',
      label: 'Em qualquer lugar',
      lead: 'O mesmo painel no seu computador e em magnetar.codefusion.cc, ligados por um servidor intermédio que só transporta bytes encriptados.',
      features: {
        website: {
          title: 'O mesmo painel, em qualquer navegador',
          gain: 'Inicie uma transferência no telemóvel, no autocarro, e ela fica à sua espera no computador, em casa.',
          text: 'Entre em magnetar.codefusion.cc e abra qualquer um dos seus computadores: a pesquisa, as transferências, a lista A seguir e as definições funcionam como em casa. O seu computador faz o trabalho; o site só o liga a ele.',
          points: [
            'Os seus dispositivos com o estado online, atualizado a cada 15 segundos',
            'Num telemóvel aparece uma barra de separadores em baixo; num computador, uma barra lateral',
            'O que só faz sentido no computador (o seletor de pastas, abrir ficheiros) fica por lá',
            'Início de sessão com o Google; as sessões duram 30 dias desde a última visita',
          ],
        },
        pairing: {
          title: 'Associe um computador num clique',
          gain: 'Sem códigos para copiar: a aplicação abre o site, aprova, e o computador fica seu.',
          text: 'Em Definições → Acesso remoto, «Conectar à sua conta» abre o site com uma ligação de emparelhamento. Inicie sessão, aprove, e a aplicação vai buscar a sua chave. O nome que deu ao dispositivo torna-se o endereço dele.',
          points: [
            'Uma ligação de emparelhamento funciona durante dez minutos e a chave é entregue uma única vez',
            'Até 20 computadores por conta',
            'O site guarda apenas um hash do token de cada computador',
          ],
        },
        phone: {
          title: 'Associe um telemóvel com um código QR',
          gain: 'Aponte a câmara do telemóvel para o ecrã e ele abre o seu computador, já associado.',
          text: 'Cada navegador recebe a sua própria chave, criada no seu computador. O código QR leva-a na parte da ligação que nunca chega a um servidor; o telemóvel guarda-a onde os scripts a podem usar, mas nunca ler.',
          points: [
            'Os navegadores associados aparecem com a última utilização, cada um com um botão Revogar',
            'Um navegador sem a chave vê que não está associado, nunca os seus dados',
          ],
        },
        'device-addresses': {
          title: 'Cada computador no seu próprio endereço',
          gain: 'magnetar.codefusion.cc/MacBook-Pro/search: pela ligação, sabe que computador vai abrir.',
          text: 'O nome de um computador é a primeira parte dos endereços das suas páginas. Mude de computador a partir do nome na barra lateral e fique na mesma página.',
          points: [
            `Os nomes são letras e algarismos unidos por hífenes, até ${DEVICE_NAME_MAX_LENGTH} caracteres; qualquer nome que escreva é convertido para essa forma («Mac do Paweł» passa a Mac-do-Pawel)`,
            'Mudar o nome a um computador leva uma página aberta para o novo endereço',
            'As notificações apontam para o computador pelo seu id, por isso abrem-no mesmo depois de lhe mudar o nome',
          ],
        },
        install: {
          title: 'Instale o site como uma app',
          gain: 'O Magnetar no ecrã principal do telemóvel, a abrir em ecrã inteiro como qualquer outra app.',
          text: 'No Chrome e no Edge aparece um botão «Instalar app» no cabeçalho; no Safari, adicione-o a partir do menu Partilhar.',
          points: [
            'No iPhone e no iPad, é ao instalá-lo que o site passa a poder mostrar notificações',
          ],
        },
      },
    },
    notify: {
      title: 'Ser avisado',
      label: 'Notificações',
      lead: 'Quando uma transferência começa ou termina, um seguimento encontra algo ou sai uma atualização: onde quiser ser avisado.',
      features: {
        channels: {
          title: 'Cinco formas de ser avisado',
          gain: 'Saiba que uma transferência terminou no telemóvel, no e-mail ou no Telegram, sem manter um separador aberto.',
          text: 'Ative qualquer um destes canais: ambiente de trabalho, push do navegador, e-mail, ntfy e Telegram, e escolha se quer ser avisado quando as transferências começam, quando terminam ou ambos. Cada canal tem um botão «Enviar notificação de teste».',
          points: [
            'A falha de um canal nunca trava os outros',
            'E-mail pelo seu próprio servidor SMTP; ntfy.sh ou o seu próprio servidor ntfy; um bot do Telegram',
            'Cada achado de um seguimento e cada nova versão da aplicação são avisados uma única vez',
          ],
        },
        push: {
          title: 'Push que o site não consegue ler',
          gain: 'Notificações no telemóvel mesmo com o Magnetar fechado, seladas para que só o seu telemóvel as possa ler.',
          text: 'O seu computador encripta cada notificação para o seu navegador (RFC 8291) antes de ela sair; o site só a assina e reencaminha. Um toque abre a página desse computador.',
          points: [
            'Só são aceites os serviços push da Google, da Mozilla, da Apple e da Microsoft',
            'Um navegador que cancelou a subscrição é removido no envio seguinte',
          ],
        },
      },
    },
    app: {
      title: 'A aplicação',
      label: 'A aplicação',
      lead: 'Um único ficheiro para correr no macOS, Windows ou Linux, que se mantém atualizado e guarda os seus dados no seu computador.',
      features: {
        desktop: {
          title: 'Uma aplicação, nada mais para instalar',
          gain: 'Transfira-a, abra-a e o painel aparece no navegador: sem instalador, sem runtime, sem conta para usar em casa.',
          text: 'A aplicação é um único executável com o painel lá dentro, em http://localhost:47820. As suas transferências, séries e definições ficam numa base de dados no seu computador. Abri-la uma segunda vez apenas abre o painel.',
          points: [
            'macOS (Apple silicon e Intel), Windows e Linux (x64 e ARM)',
            '«Iniciar ao entrar na sessão» no macOS e no Windows',
            'Tema claro, escuro ou do sistema, escolhido em cada navegador',
          ],
        },
        tray: {
          title: 'Na barra de menus',
          gain: 'Transferências, velocidades e limites alternativos a um clique, sem abrir o painel.',
          text: 'No macOS e no Windows, um ícone na barra de menus ou na área de notificação lista as transferências com o seu progresso e define limites de velocidade a partir de predefinições.',
          points: [
            'No macOS, o Magnetar vive na barra de menus, sem ícone na Dock',
            'Mostra quando há uma atualização pronta',
          ],
        },
        updates: {
          title: 'Atualizações de confiança',
          gain: 'Uma nova versão fica a um clique, e só é instalada se estiver assinada pelo programador.',
          text: 'A aplicação procura uma nova versão um minuto depois de arrancar e a cada seis horas, verifica a assinatura (Ed25519) com a chave incorporada e instala-a quando o indicar. As transferências só param quando a atualização está pronta, e retomam depois.',
          points: [
            'No macOS, a aplicação é substituída depois de fechar e reposta se algo correr mal',
            'Notas de lançamento e «Procurar atualizações» em Definições → Acerca',
            'O site passa uma página aberta para a nova versão no clique seguinte, nunca enquanto está a escrever',
          ],
        },
        agents: {
          title: 'Deixe um agente de IA tratar disso',
          gain: 'Peça ao Claude, ao Codex ou ao Gemini, por palavras suas, que encontrem e transfiram algo ou que configurem uma série.',
          text: 'Ative o acesso de agentes e o Magnetar oferece ferramentas MCP e uma API REST (com descrição OpenAPI) para pesquisa, transferências e séries. Um clique configura-o no Claude Code, Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode ou Claude Desktop.',
          points: [
            'Desligado até o ativar; agentes noutra máquina precisam de HTTPS e de um token',
            'As pesquisas têm limite de frequência, e um agente só pode guardar dentro da sua pasta de transferência',
          ],
        },
        reports: {
          title: 'Relatórios de erro sem os seus dados',
          gain: 'Quando algo falha, o programador fica a saber, sem nada sobre si ou as suas transferências.',
          text: 'Os erros são limpos de nomes, caminhos, endereços, ligações e hashes antes de saírem e vão para a CodeFusion Console, onde são agrupados por causa. No máximo dez por hora.',
          points: [
            'Desative-os em Definições → Geral («Enviar relatórios de erro anônimos»)',
            'Os erros do site são limpos da mesma forma',
          ],
        },
        import: {
          title: 'Vindo do MediaDownloader',
          gain: 'As suas transferências, séries e definições vêm consigo, sem começar do zero.',
          text: 'O Magnetar lê a base de dados do MediaDownloader sem a alterar e importa as suas transferências, séries e definições. As transferências que estavam a decorrer chegam em pausa.',
          points: ['As palavras-passe e os tokens não são copiados: introduza-os de novo nas Definições'],
        },
        languages: {
          title: 'No seu idioma',
          gain: 'O painel e esta página em inglês, alemão, espanhol, francês, italiano, polaco, português e russo.',
          text: 'Escolha um idioma em Definições → Geral; aplica-se a todos os navegadores que abram esse computador. As páginas do próprio site seguem o idioma do seu navegador.',
          points: ['Datas e horas escritas como no seu idioma'],
        },
      },
    },
  },
  shots: {
    search: 'Resultados da pesquisa com as etiquetas da versão, reunidos de todas as fontes',
    'search-phone': 'Pesquisa num telemóvel, com os botões de resolução',
    'search-sources': 'O que cada fonte encontrou, e com que rapidez',
    add: 'A janela Adicionar com ligações magnet coladas',
    watchlist: 'A lista A seguir: séries com o próximo episódio',
    watches: 'Seguimentos de versões, com a frequência de cada um',
    downloads: 'Transferências em curso, com velocidade, pares e tempo restante',
    details: 'Os ficheiros de uma transferência, cada um com o seu progresso',
    player: 'Um filme de licença livre a ser reproduzido no navegador, com as suas legendas em inglês',
    speed: 'Limites de velocidade, limites alternativos e o seu horário',
    devices: 'Os seus dispositivos no site, com o estado online',
    'remote-phone': 'As transferências de um computador num telemóvel, através do site',
    remote: 'O acesso remoto nas definições da aplicação, ligado a uma conta',
    pair: 'Aprovar um computador no site',
    'link-qr': 'Um código QR que associa um telemóvel',
    switcher: 'Mudar de computador a partir da barra lateral',
    notifications: 'Canais de notificação, cada um com um botão de teste',
    settings: 'Definições gerais: idioma, tema, início ao entrar na sessão',
    about: 'A versão e a procura de atualizações',
    agents: 'Acesso de agentes e configuração num clique para agentes de IA',
  },
  privacy: {
    title: 'Privacidade em resumo',
    label: 'Privacidade',
    lead: 'O seu computador faz o trabalho e guarda os seus dados. O site liga-o a ele e não consegue ler o que passa.',
    items: {
      e2e: { title: 'Encriptação ponto a ponto', text: 'Cada ligação cria chaves novas (ECDH P-256, HKDF), e cada mensagem é selada com AES-256-GCM, por ordem, por isso uma mensagem repetida ou fora de ordem é recusada.' },
      worker: { title: 'O que o site vê', text: 'Que computadores estão na sua conta, os nomes, as versões e se estão online. Nunca as suas pesquisas, transferências, definições, ficheiros ou notificações.' },
      sealed: { title: 'Segredos selados em casa', text: 'As palavras-passe e os tokens nas suas definições são encriptados no seu computador, com uma chave guardada junto à base de dados.' },
      visits: { title: 'Sem rastreio', text: 'O site conta as visualizações apenas por página: sem identificador de visitante, sem cookies para isso, nada guardado no seu navegador.' },
      local: { title: 'O local fica local', text: 'No seu computador, o painel só responde ao próprio computador e recusa páginas de outros sites.' },
    },
  },
  builtOn: {
    title: 'Em que assenta',
    label: 'Tecnologia',
    lead: 'Código aberto, licença MIT.',
    items: {
      client: { name: 'Rust', text: 'A aplicação: um executável com o painel, a base de dados (SQLite) e o motor lá dentro.' },
      engine: { name: 'librqbit', text: 'O motor BitTorrent: DHT, trackers, UPnP, retoma rápida e streaming de ficheiros incompletos.' },
      dashboard: { name: 'React e daisyUI', text: 'O painel, a mesma compilação no seu computador e no site.' },
      worker: { name: 'Cloudflare Workers', text: 'O site: início de sessão e dispositivos no D1, e um Durable Object por computador que retransmite as suas ligações encriptadas.' },
      packages: { name: 'Pacotes CodeFusion', text: 'Código partilhado e testado para início de sessão, push, ids base58, o tema, as atualizações da aplicação e esta página.' },
      console: { name: 'CodeFusion Console', text: 'Onde os erros são agrupados por causa e onde o programador vê cada publicação e o que ela mudou.' },
      releases: { name: 'GitHub Releases', text: 'Seis compilações por versão, feitas pelo GitHub Actions, com as somas de verificação assinadas com Ed25519.' },
    },
  },
  closing: {
    title: 'Experimente o Magnetar',
    lead: 'Transfira a aplicação gratuita para o seu computador e depois inicie sessão aqui para lhe aceder de qualquer lugar.',
    download: 'Obter a app',
    signIn: 'Entrar',
  },
}
