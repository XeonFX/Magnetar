use serde_json::{Value, json};

use crate::config::VERSION;

fn nullable(kind: &str) -> Value {
    json!({ "type": [kind, "null"] })
}

fn body(schema: Value) -> Value {
    json!({ "required": true, "content": { "application/json": { "schema": schema } } })
}

/// The agent REST API described for OpenAPI tooling; see rest.rs for the routes.
pub fn document() -> Value {
    let ok = json!({ "200": { "description": "OK" }, "400": { "description": "Invalid request" }, "404": { "description": "Not found" } });
    let limited = json!({
        "200": { "description": "OK" }, "400": { "description": "Invalid request" },
        "404": { "description": "Not found" }, "429": { "description": "Rate limited" },
    });
    let id = json!({ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } });
    let series_properties = json!({
        "name": { "type": "string" },
        "query": { "type": "string" },
        "provider": nullable("string"),
        "titleFilter": nullable("string"),
        "season": nullable("integer"),
        "startEpisode": { "type": "integer" },
        "endEpisode": nullable("integer"),
        "checkIntervalMinutes": { "type": "integer" },
        "enabled": { "type": "boolean" },
        "downloadFolder": nullable("string"),
    });
    let all_fields: Vec<&str> = series_properties.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    let series = |required: &[&str]| json!({ "type": "object", "properties": series_properties, "required": required, "additionalProperties": false });
    json!({
        "openapi": "3.1.0",
        "info": { "title": "MediaDownloader agent API", "version": VERSION },
        "paths": {
            "/api/sources": { "get": { "summary": "List sources", "responses": ok } },
            "/api/search": { "post": {
                "summary": "Search torrents",
                "requestBody": body(json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "source": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                    },
                    "required": ["query"],
                })),
                "responses": limited,
            } },
            "/api/search/{resultId}": { "get": {
                "summary": "Details of a search result",
                "parameters": [{ "name": "resultId", "in": "path", "required": true, "schema": { "type": "string" } }],
                "responses": ok,
            } },
            "/api/downloads": {
                "get": { "summary": "List downloads", "parameters": [{ "name": "status", "in": "query", "schema": { "type": "string" } }], "responses": ok },
                "post": {
                    "summary": "Start a download",
                    "requestBody": body(json!({
                        "type": "object",
                        "properties": { "resultId": { "type": "string" }, "magnet": { "type": "string" }, "folder": { "type": "string" } },
                        "additionalProperties": false,
                    })),
                    "responses": ok,
                },
            },
            "/api/downloads/{id}": {
                "get": { "summary": "Get a download", "parameters": [id], "responses": ok },
                "delete": {
                    "summary": "Remove a download",
                    "parameters": [id, { "name": "deleteFiles", "in": "query", "schema": { "type": "boolean", "default": false } }],
                    "responses": ok,
                },
            },
            "/api/downloads/{id}/pause": { "post": { "summary": "Pause", "parameters": [id], "responses": ok } },
            "/api/downloads/{id}/resume": { "post": { "summary": "Resume or retry", "parameters": [id], "responses": ok } },
            "/api/series": {
                "get": { "summary": "List series tasks", "responses": ok },
                "post": { "summary": "Create a series task", "requestBody": body(series(&["name", "query"])), "responses": ok },
            },
            "/api/series/{id}": {
                "get": { "summary": "Get a series task", "parameters": [id], "responses": ok },
                "put": { "summary": "Replace every field", "parameters": [id], "requestBody": body(series(&all_fields)), "responses": ok },
                "patch": { "summary": "Change the fields sent", "parameters": [id], "requestBody": body(series(&[])), "responses": ok },
                "delete": { "summary": "Delete (downloads are kept)", "parameters": [id], "responses": ok },
            },
            "/api/series/{id}/check": { "post": { "summary": "Check now", "parameters": [id], "responses": limited } },
            "/api/settings": { "get": { "summary": "Download folder and post-download action", "responses": ok } },
        },
    })
}
