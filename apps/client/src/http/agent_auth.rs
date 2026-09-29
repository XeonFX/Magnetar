use crate::api::agent_access::token_matches;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AgentAuth {
    Allowed,
    Disabled,
    ForbiddenOrigin,
    Unauthorized,
    RemoteDisabled,
    InsecureTransport,
}

pub fn is_agent_path(path: &str) -> bool {
    ["/api", "/mcp", "/openapi"].iter().any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

fn is_ipv4_loopback(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

pub fn is_loopback_address(address: &str) -> bool {
    let ip = address.strip_prefix("::ffff:").or_else(|| address.strip_prefix("::FFFF:")).unwrap_or(address);
    ip == "::1" || is_ipv4_loopback(ip)
}

/// True for `localhost`, `127.x` or `[::1]` host names, i.e. never a DNS name that rebinding could point here.
pub fn is_loopback_hostname(hostname: &str) -> bool {
    let host = hostname.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    host == "localhost" || host == "::1" || is_ipv4_loopback(&host)
}

/// The host name part of a Host header (`localhost:47820`, `[::1]:47820`).
pub fn host_name(host: &str) -> &str {
    if let Some(bracketed) = host.strip_prefix('[') {
        return bracketed.split(']').next().unwrap_or(bracketed);
    }
    host.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map_or(host, |(name, _)| name)
}

/// Only the app's own literal loopback origin counts as same-origin. Matching the Host header is
/// not enough: after a DNS rebind, `Origin: http://evil.example` and `Host: evil.example` also
/// match while the connection lands on 127.0.0.1.
pub fn is_allowed_loopback_origin(origin: &str, host: Option<&str>) -> bool {
    let (Some(host), Ok(url)) = (host, url::Url::parse(origin)) else { return false };
    let Some(origin_host) = url.host_str() else { return false };
    let origin_authority = match url.port() {
        Some(port) => format!("{origin_host}:{port}"),
        None => origin_host.to_owned(),
    };
    is_loopback_hostname(origin_host) && origin_authority.eq_ignore_ascii_case(host)
}

pub fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let value = authorization?.trim();
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

pub struct AgentRequest<'a> {
    pub enabled: bool,
    pub allow_remote: bool,
    pub token: &'a str,
    pub client_is_loopback: bool,
    /// The request came through a reverse proxy on this machine (X-Forwarded-For from a loopback peer).
    pub forwarded: bool,
    /// Host name the request was addressed to.
    pub hostname: &'a str,
    pub is_https: bool,
    pub origin: Option<&'a str>,
    pub host: Option<&'a str>,
    pub authorization: Option<&'a str>,
}

/// Whether a request may use the agent API. In order:
/// 1. feature off → 404, as if the endpoints didn't exist;
/// 2. a direct request addressed to anything but a loopback host name → 403: a DNS-rebound page
///    (evil.example → 127.0.0.1) sends no Origin on its same-origin GETs, so only the Host shows it;
/// 3. a cross-origin `Origin` header → 403, token or not: otherwise any web page could POST to
///    localhost and queue downloads;
/// 4. loopback → allowed without a token;
/// 5. remote access off → 404; remote plaintext → 426; remote HTTPS → the bearer token must match.
pub fn evaluate(r: &AgentRequest<'_>) -> AgentAuth {
    if !r.enabled {
        return AgentAuth::Disabled;
    }
    if !r.forwarded && !is_loopback_hostname(r.hostname) {
        return AgentAuth::ForbiddenOrigin;
    }
    if r.origin.is_some_and(|origin| !is_allowed_loopback_origin(origin, r.host)) {
        return AgentAuth::ForbiddenOrigin;
    }
    if r.client_is_loopback {
        return AgentAuth::Allowed;
    }
    if !r.allow_remote {
        return AgentAuth::RemoteDisabled;
    }
    if !r.is_https {
        return AgentAuth::InsecureTransport;
    }
    if token_matches(bearer_token(r.authorization), r.token) { AgentAuth::Allowed } else { AgentAuth::Unauthorized }
}

/// Status and message for a refused request.
pub fn refusal(result: AgentAuth) -> (u16, &'static str) {
    match result {
        AgentAuth::Disabled => (404, "The agent API is turned off. Enable it in MediaDownloader under Settings → Agent access."),
        AgentAuth::RemoteDisabled => (404, "Remote agent access is turned off."),
        AgentAuth::InsecureTransport => {
            (426, "Remote agent requests require HTTPS. Put a TLS reverse proxy on this machine in front of the loopback URL.")
        }
        AgentAuth::ForbiddenOrigin => (403, "Cross-origin requests are not accepted by the agent API."),
        AgentAuth::Unauthorized => (401, "Requests from other machines need a bearer token. Find it in Settings → Agent access."),
        AgentAuth::Allowed => (200, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> AgentRequest<'static> {
        AgentRequest {
            enabled: true,
            allow_remote: false,
            token: "secret-token",
            client_is_loopback: true,
            forwarded: false,
            hostname: "localhost",
            is_https: false,
            origin: None,
            host: Some("localhost:47820"),
            authorization: None,
        }
    }

    #[test]
    fn off_means_absent_and_loopback_needs_no_token() {
        assert_eq!(evaluate(&AgentRequest { enabled: false, ..base() }), AgentAuth::Disabled);
        assert_eq!(evaluate(&base()), AgentAuth::Allowed);
    }

    #[test]
    fn web_page_origins_are_refused_token_or_not() {
        assert_eq!(evaluate(&AgentRequest { origin: Some("https://evil.example"), ..base() }), AgentAuth::ForbiddenOrigin);
        let with_token =
            AgentRequest { origin: Some("https://evil.example"), authorization: Some("Bearer secret-token"), ..base() };
        assert_eq!(evaluate(&with_token), AgentAuth::ForbiddenOrigin);
    }

    #[test]
    fn dns_rebinding_is_refused_with_or_without_an_origin() {
        let rebound = AgentRequest { origin: Some("http://evil.example:47820"), host: Some("evil.example:47820"), ..base() };
        assert_eq!(evaluate(&rebound), AgentAuth::ForbiddenOrigin);
        let same_origin_get = AgentRequest { hostname: "evil.example", host: Some("evil.example:47820"), ..base() };
        assert_eq!(evaluate(&same_origin_get), AgentAuth::ForbiddenOrigin);
        // Through a TLS proxy on this machine the public host name is expected.
        let proxied = AgentRequest {
            forwarded: true,
            client_is_loopback: false,
            allow_remote: true,
            is_https: true,
            hostname: "mini.example",
            authorization: Some("Bearer secret-token"),
            ..base()
        };
        assert_eq!(evaluate(&proxied), AgentAuth::Allowed);
    }

    #[test]
    fn the_apps_own_loopback_origin_is_fine() {
        assert_eq!(evaluate(&AgentRequest { origin: Some("http://localhost:47820"), ..base() }), AgentAuth::Allowed);
        assert!(is_allowed_loopback_origin("http://127.0.0.1:47820", Some("127.0.0.1:47820")));
        assert!(is_allowed_loopback_origin("http://[::1]:47820", Some("[::1]:47820")));
        assert!(!is_allowed_loopback_origin("http://localhost:5173", Some("localhost:47820")));
    }

    #[test]
    fn remote_callers() {
        let remote = || AgentRequest { client_is_loopback: false, forwarded: true, hostname: "mini.example", ..base() };
        assert_eq!(evaluate(&remote()), AgentAuth::RemoteDisabled);
        assert_eq!(evaluate(&AgentRequest { allow_remote: true, ..remote() }), AgentAuth::InsecureTransport);
        let https = || AgentRequest { allow_remote: true, is_https: true, ..remote() };
        assert_eq!(evaluate(&https()), AgentAuth::Unauthorized);
        assert_eq!(evaluate(&AgentRequest { authorization: Some("Bearer wrong"), ..https() }), AgentAuth::Unauthorized);
        assert_eq!(evaluate(&AgentRequest { authorization: Some("Bearer secret-token"), ..https() }), AgentAuth::Allowed);
    }

    #[test]
    fn host_names_from_host_headers() {
        assert_eq!(host_name("localhost:47820"), "localhost");
        assert_eq!(host_name("[::1]:47820"), "::1");
        assert_eq!(host_name("evil.example"), "evil.example");
        assert!(is_loopback_address("::ffff:127.0.0.1"));
        assert!(!is_loopback_address("192.168.1.2"));
    }
}
