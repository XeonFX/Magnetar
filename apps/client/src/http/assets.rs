use axum::body::Body;
use axum::http::{Response, StatusCode, header};
use rust_embed::RustEmbed;

/// The dashboard's built files: embedded in release builds, read from apps/web/dist in debug builds.
#[derive(RustEmbed)]
#[folder = "../web/dist"]
#[exclude = "_headers"]
// Source maps for CodeFusion Console, which only the Worker reads.
#[exclude = "_console/*"]
// The features page's screenshots: the page is the website's (vite.config.ts).
#[exclude = "assets/features/*"]
#[allow_missing = true]
struct Dashboard;

fn with_security_headers(builder: axum::http::response::Builder) -> axum::http::response::Builder {
    builder.header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("x-frame-options", "DENY")
}

pub fn serve(path: &str) -> Response<Body> {
    let Some(decoded) = percent_decode(path) else {
        return Response::builder().status(StatusCode::BAD_REQUEST).body(Body::from("Bad request")).unwrap();
    };
    let relative = decoded.trim_start_matches('/');
    // Only plain path segments: no "..", no absolute or drive paths.
    let safe = !relative.split('/').any(|segment| segment == ".." || segment.contains('\\') || segment.contains(':'));
    let hashed = relative.starts_with("assets/");
    // Client-side routes fall back to the app shell; a missing hashed asset is a real 404.
    let direct = if safe && !relative.is_empty() { Dashboard::get(relative).map(|f| (relative, f)) } else { None };
    let file = direct.or_else(|| if hashed { None } else { Dashboard::get("index.html").map(|f| ("index.html", f)) });
    let Some((name, file)) = file else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("The dashboard has not been built. Run `npm run build:web`, or use the Vite dev server."))
            .unwrap();
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    with_security_headers(Response::builder())
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, if hashed { "public, max-age=31536000, immutable" } else { "no-cache" })
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

/// `decodeURIComponent`: None for malformed escapes or invalid UTF-8.
fn percent_decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
