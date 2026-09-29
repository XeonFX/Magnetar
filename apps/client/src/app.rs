use std::path::PathBuf;
use std::sync::Arc;

use crate::api::actions::{Actions, Caller};
use crate::api::agent_access::AgentAccess;
use crate::api::rate_limiter::RateLimiter;
use crate::db::{Db, KeyValue, SecretBox, SecretStore};
use crate::downloads::DownloadManager;
use crate::downloads::manager::EngineSource;
use crate::events::EventBus;
use crate::http::stream::StreamGrants;
use crate::legacy::LegacyImporter;
use crate::notifications::NotificationDispatcher;
use crate::paths::{Paths, legacy_database_path};
use crate::remote::{BrowserKeyStore, RemoteService};
use crate::rpc::RpcServer;
use crate::search::SearchService;
use crate::search::cache::SearchResultCache;
use crate::search::providers;
use crate::search::types::Provider;
use crate::series::{SeriesMonitor, SeriesStore};
use crate::settings::SettingsService;
use crate::updates::UpdateService;

pub struct AppOptions {
    pub paths: Paths,
    pub engine: EngineSource,
    pub providers: Vec<Arc<dyn Provider>>,
    pub legacy_database: Option<PathBuf>,
}

impl AppOptions {
    /// The real thing: an engine run as the settings say, every provider, and the legacy database
    /// where the old app kept it.
    pub fn production(paths: Paths) -> Self {
        Self {
            engine: EngineSource::Managed(paths.clone()),
            paths,
            providers: providers::all(),
            legacy_database: legacy_database_path(),
        }
    }
}

/// Every service, wired together. `main.rs` adds the HTTP server, tray and lifecycle around it.
pub struct App {
    pub paths: Paths,
    pub db: Db,
    pub events: EventBus,
    pub http: reqwest::Client,
    pub settings: Arc<SettingsService>,
    pub notifications: Arc<NotificationDispatcher>,
    pub search: Arc<SearchService>,
    pub downloads: Arc<DownloadManager>,
    pub series: Arc<SeriesStore>,
    pub monitor: Arc<SeriesMonitor>,
    /// For the dashboard.
    pub actions: Actions,
    /// For REST and MCP: rate limited and confined to the download folder.
    pub agent_actions: Actions,
    pub updates: Arc<UpdateService>,
    pub agent: AgentAccess,
    pub remote: Arc<RemoteService>,
    pub legacy: LegacyImporter,
    pub rpc: RpcServer,
    /// Tokens for `/stream/…` links to download files.
    pub streams: StreamGrants,
}

impl App {
    pub fn new(options: AppOptions) -> anyhow::Result<Arc<Self>> {
        // reqwest, the relay socket and SMTP share rustls; pick its crypto once for all of them.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let AppOptions { paths, engine, providers, legacy_database } = options;
        let db = Db::open(&paths.database)?;
        let kv = KeyValue(db.clone());
        let sealer = Arc::new(SecretBox::open(&paths.secret_key)?);
        let secrets = Arc::new(SecretStore::new(db.clone(), sealer.clone()));
        let events = EventBus::default();
        let http = reqwest::Client::builder().build()?;
        let settings = Arc::new(SettingsService::new(db.clone(), secrets.clone(), events.clone()));
        let notifications = Arc::new(NotificationDispatcher::new(settings.clone(), events.clone(), http.clone()));
        let search = Arc::new(SearchService::new(providers, settings.clone(), http.clone()));
        let downloads = DownloadManager::new(
            db.clone(),
            engine,
            settings.clone(),
            notifications.clone(),
            events.clone(),
            paths.torrent_files.clone(),
        );
        let series = Arc::new(SeriesStore::new(db.clone(), events.clone()));
        let monitor = SeriesMonitor::new(series.clone(), search.clone(), downloads.clone());
        let actions = Actions {
            search: search.clone(),
            downloads: downloads.clone(),
            series: series.clone(),
            monitor: monitor.clone(),
            settings: settings.clone(),
            cache: Arc::new(SearchResultCache::default()),
            limiter: Arc::new(RateLimiter::default()),
            caller: Caller::User,
        };
        let agent_actions = actions.as_caller(Caller::Agent);
        let updates = Arc::new(UpdateService::new(events.clone(), notifications.clone(), downloads.clone(), http.clone()));
        let agent = AgentAccess::new(settings.clone(), secrets.clone(), paths.clone());
        let legacy = LegacyImporter::new(db.clone(), kv.clone(), settings.clone(), legacy_database);
        let app = Arc::new_cyclic(|app| {
            let remote = Arc::new(RemoteService::new(
                kv,
                secrets,
                BrowserKeyStore::new(db.clone(), sealer),
                events.clone(),
                http.clone(),
                app.clone(),
            ));
            App {
                paths,
                db,
                events,
                http,
                settings,
                notifications,
                search,
                downloads,
                series,
                monitor,
                actions,
                agent_actions,
                updates,
                agent,
                remote,
                legacy,
                rpc: RpcServer::new(app.clone()),
                streams: StreamGrants::default(),
            }
        });
        app.notifications.send_to_browsers_through(app.remote.clone());
        Ok(app)
    }

    /// Starts the background work: resuming downloads, series checks, update checks, the relay.
    pub fn start(&self) {
        self.downloads.start();
        self.monitor.start();
        self.updates.start();
        self.remote.start();
    }

    pub async fn stop(&self) {
        self.monitor.stop();
        self.updates.stop();
        self.remote.stop();
        self.downloads.stop().await;
    }
}
