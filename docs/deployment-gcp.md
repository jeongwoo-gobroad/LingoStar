# LingoStar GCP Deployment Guide

This guide prepares LingoStar for ChatGPT Apps deployment on Google Cloud Run.

Official references:

- OpenAI Apps SDK server flow: https://developers.openai.com/apps-sdk/build/mcp-server
- OpenAI Apps SDK authentication: https://developers.openai.com/apps-sdk/build/auth
- OpenAI Apps SDK reference for widget CSP metadata: https://developers.openai.com/apps-sdk/reference
- MCP Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Auth0 API RBAC and permissions claims: https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis
- Google Cloud Run container contract: https://cloud.google.com/run/docs/container-contract
- Google Cloud Run HTTP/2 configuration: https://cloud.google.com/run/docs/configuring/http2
- Google Cloud Run deploy from source: https://cloud.google.com/run/docs/deploying-source-code
- Google Cloud Run secrets: https://cloud.google.com/run/docs/configuring/services/secrets
- Firestore Native mode: https://cloud.google.com/firestore/docs

## What GCP Solves

Cloud Run gives LingoStar a stable public HTTPS origin for ChatGPT Apps:

- MCP endpoint: `https://YOUR_ORIGIN/mcp`
- Widget origin: `https://YOUR_ORIGIN`
- Icon: `https://YOUR_ORIGIN/icon.png`
- OAuth protected-resource metadata: `https://YOUR_ORIGIN/.well-known/oauth-protected-resource`
- Privacy policy: `https://YOUR_ORIGIN/privacy-poilcy.html`
- Terms of service: `https://YOUR_ORIGIN/terms-of-service.html`

The server reads Cloud Run's `PORT` environment variable and listens on `0.0.0.0`, which satisfies the Cloud Run runtime contract.

Cloud Run instances are stateless. LingoStar therefore uses Firestore in Native mode for deployment state. Local `memory` mode is only for single-process development.

## Required Files Added

- `Dockerfile`
- `.dockerignore`
- `.env.example`
- `deploy/gcp/deploy-cloud-run.ps1`
- `deploy/gcp/deploy-cloud-run.sh`
- `deploy/gcp/cloudbuild.yaml`
- `scripts/verify-auth.mjs`

## Environment Variables

Core:

```text
APP_ORIGIN=https://YOUR_ORIGIN
CORS_ALLOWED_ORIGINS=https://YOUR_ORIGIN,https://chatgpt.com
WIDGET_CONNECT_DOMAINS=https://YOUR_ORIGIN
WIDGET_RESOURCE_DOMAINS=https://YOUR_ORIGIN
```

Audio fallback:

```text
IS_AI_FALLBACK=true
OPENAI_API_KEY=<stored in Secret Manager>
OPENAI_STT_MODEL=gpt-4o-transcribe
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=alloy
OPENAI_TTS_FORMAT=mp3
```

State store:

```text
LINGOSTAR_STATE_STORE=firestore
FIRESTORE_PROJECT_ID=YOUR_GCP_PROJECT
FIRESTORE_DATABASE_ID=(default)
FIRESTORE_COLLECTION=lingostar_states
```

Set `IS_AI_FALLBACK=false` if browser speech must be the only speech path. In that mode, the widget does not call OpenAI audio tools and asks the learner to type or skip the current exercise when speech is unavailable.

OAuth:

```text
LINGOSTAR_AUTH_REQUIRED=1
OAUTH_ISSUER=https://YOUR_IDP_ISSUER
OAUTH_AUTHORIZATION_SERVERS=https://YOUR_IDP_ISSUER
OAUTH_JWKS_URL=https://YOUR_IDP_ISSUER/.well-known/jwks.json
OAUTH_AUDIENCE=https://YOUR_ORIGIN
OAUTH_SCOPES=lingostar.read lingostar.write lingostar.audio
OAUTH_REQUEST_SCOPES=lingostar.read lingostar.write lingostar.audio
OAUTH_CLIENT_ID=YOUR_AUTH0_CLIENT_ID
OAUTH_SCOPE_MODE=none
OAUTH_VALIDATE_CLIENT_ID=true
OAUTH_ALLOW_SCOPELESS_TOKENS=false
OAUTH_RESOURCE_DOCUMENTATION=https://YOUR_ORIGIN/privacy-poilcy.html
```

Use `LINGOSTAR_AUTH_REQUIRED=0` only for local demos or private review videos.

Feedback admin:

```text
FEEDBACK_ADMIN_ID=admin-user
FEEDBACK_ADMIN_PASSWORD=strong-password
```

The feedback admin page is available at `https://YOUR_ORIGIN/feedback` and uses HTTP Basic authentication. In Cloud Run, inject those variables from Secret Manager secrets named `feedback-id` and `feedback-pw`; `.env` values are for local development.

## Deploy: Fast Demo Mode

This mode is useful for recording an upload demo. It keeps ChatGPT user separation based on ChatGPT-provided user metadata, but does not force OAuth linking.

Before deploying, create or confirm Firestore Native mode:

```powershell
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=asia-northeast3 --database="(default)"
```

If the database already exists, the second command will fail harmlessly; continue with deployment.

Grant the Cloud Run runtime service account Firestore access. For the default Compute Engine service account:

```powershell
$projectNumber = gcloud projects describe YOUR_GCP_PROJECT --format "value(projectNumber)"
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT `
  --member "serviceAccount:$projectNumber-compute@developer.gserviceaccount.com" `
  --role "roles/datastore.user"
```

Grant the same runtime service account access to Secret Manager values injected into Cloud Run:

```powershell
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT `
  --member "serviceAccount:$projectNumber-compute@developer.gserviceaccount.com" `
  --role "roles/secretmanager.secretAccessor"
```

1. Create an OpenAI API key secret for optional STT/TTS fallback:

```powershell
printf "sk-..." | gcloud secrets create openai-api-key --data-file=-
```

If the secret already exists:

```powershell
printf "sk-..." | gcloud secrets versions add openai-api-key --data-file=-
```

Create feedback admin secrets used by `/feedback`:

```powershell
printf "admin-id" | gcloud secrets create feedback-id --data-file=-
printf "strong-password" | gcloud secrets create feedback-pw --data-file=-
```

If they already exist:

```powershell
printf "admin-id" | gcloud secrets versions add feedback-id --data-file=-
printf "strong-password" | gcloud secrets versions add feedback-pw --data-file=-
```

2. Deploy from the repository root:

```powershell
.\deploy\gcp\deploy-cloud-run.ps1 -ProjectId YOUR_GCP_PROJECT -Region asia-northeast3
```

The script does two deploys when `-AppOrigin` is omitted:

- first deploy obtains the Cloud Run `*.run.app` URL,
- second deploy writes that URL into `APP_ORIGIN`, widget CSP, CORS, and OAuth audience defaults.

Both Cloud Run deploy scripts pass `--no-use-http2`. LingoStar's Node server is an HTTP/1 server; if the Cloud Run container port is named `h2c`, Cloud Run forwards HTTP/2 cleartext to the container and requests can fail before reaching `/mcp` with an upstream protocol error.

3. Check the result:

```powershell
$origin = gcloud run services describe lingostar --region asia-northeast3 --format "value(status.url)"
curl "$origin/healthz"
curl "$origin/status.json"
curl "$origin/.well-known/oauth-protected-resource"
```

4. In ChatGPT Apps developer mode, use:

```text
MCP URL: https://YOUR_RUN_APP_URL/mcp
Privacy Policy: https://YOUR_RUN_APP_URL/privacy-poilcy.html
Terms of Service: https://YOUR_RUN_APP_URL/terms-of-service.html
```

## Deploy: OAuth Submission Mode

OpenAI recommends using an established identity provider rather than writing a custom OAuth server. LingoStar is the resource server:

- It publishes protected-resource metadata.
- It advertises tool-level `securitySchemes`.
- It verifies bearer JWTs with your IdP's JWKS.
- It rejects unauthenticated calls with `_meta["mcp/www_authenticate"]`, so ChatGPT can show the OAuth linking UI.

Your IdP must provide:

- OAuth/OIDC discovery metadata.
- Authorization-code + PKCE support.
- CIMD or DCR support, or a predefined client accepted by ChatGPT.
- A token whose `aud` or `resource` claim matches `APP_ORIGIN`.
- Either app-level authorization by issuer/audience/client-id, or custom scopes matching `lingostar.read`, `lingostar.write`, and `lingostar.audio`.

### Auth0 Checklist

For Auth0, configure the API and application this way:

1. Applications > APIs: create or open the LingoStar API.
2. Set the API Identifier to exactly `https://YOUR_ORIGIN`.
3. Add permissions named `lingostar.read`, `lingostar.write`, and `lingostar.audio` if you plan to run `OAUTH_SCOPE_MODE=strict`.
4. For ChatGPT Apps with Auth0, start with `OAUTH_SCOPE_MODE=none`. ChatGPT may complete the authorization-code flow with Auth0 logging `scope: null`; in this mode LingoStar does not advertise or require custom API scopes.
5. Keep `OAUTH_CLIENT_ID` set to the Auth0 application client id and `OAUTH_VALIDATE_CLIENT_ID=true`. LingoStar verifies JWT signature, issuer, audience/resource, and rejects mismatched `azp`/`client_id`/`cid` claims when Auth0 includes them. Auth0's discovery issuer commonly ends with `/`; LingoStar accepts both the configured issuer and the trailing-slash form.
6. If your Auth0 flow reliably emits custom API scopes and you want tool-level scope enforcement, switch to `OAUTH_SCOPE_MODE=strict`, enable RBAC if needed, and enable "Add Permissions in the Access Token" if you want Auth0 to emit a `permissions` claim. LingoStar accepts both `scope` and `permissions`.
7. Applications > LingoStar app: confirm the token endpoint authentication method matches the ChatGPT app setting, for example `client_secret_post`.
8. In the ChatGPT Apps OAuth settings, leave Default scopes empty for `OAUTH_SCOPE_MODE=none`. For `OAUTH_SCOPE_MODE=strict`, set Default scopes to:

```text
lingostar.read lingostar.write lingostar.audio
```

If Auth0 logs still show `scope: null` in `OAUTH_SCOPE_MODE=none`, that is acceptable. The server omits `scopes_supported`, publishes OAuth tool descriptors with an empty scope list, and returns `WWW-Authenticate` challenges without a `scope="..."` parameter. ChatGPT should stop treating missing custom scopes as a failed grant after you redeploy and reconnect the app.

`OAUTH_ALLOW_SCOPELESS_TOKENS=true` exists only as a legacy emergency compatibility switch for `OAUTH_SCOPE_MODE=strict`. Prefer `OAUTH_SCOPE_MODE=none` for Auth0 + ChatGPT Apps because it makes the advertised contract match the tokens Auth0 is actually returning in this flow.

Deploy with OAuth enabled:

```powershell
.\deploy\gcp\deploy-cloud-run.ps1 `
  -ProjectId YOUR_GCP_PROJECT `
  -Region asia-northeast3 `
  -AuthRequired `
  -OAuthIssuer "https://YOUR_IDP_ISSUER" `
  -OAuthJwksUrl "https://YOUR_IDP_ISSUER/.well-known/jwks.json" `
  -OAuthScopeMode none
```

If you use a custom domain, pass it explicitly:

```powershell
.\deploy\gcp\deploy-cloud-run.ps1 `
  -ProjectId YOUR_GCP_PROJECT `
  -Region asia-northeast3 `
  -AppOrigin "https://lingostar.example.com" `
  -AuthRequired `
  -OAuthIssuer "https://YOUR_IDP_ISSUER" `
  -OAuthJwksUrl "https://YOUR_IDP_ISSUER/.well-known/jwks.json" `
  -OAuthAudience "https://lingostar.example.com" `
  -OAuthScopeMode none
```

## ChatGPT Apps Checklist

Use these values in the app submission/developer console:

```text
MCP endpoint: https://YOUR_ORIGIN/mcp
OAuth resource metadata: https://YOUR_ORIGIN/.well-known/oauth-protected-resource
Privacy policy: https://YOUR_ORIGIN/privacy-poilcy.html
Terms of service: https://YOUR_ORIGIN/terms-of-service.html
Icon: https://YOUR_ORIGIN/icon.png
```

Always register the ChatGPT app with the `/mcp` endpoint. The server also accepts MCP `POST`/`OPTIONS` requests at `/` as a compatibility alias because some ChatGPT backend retries have been observed to POST to the origin root after a successful `/mcp` call. This alias should prevent a root-path `404` from breaking the connection, but `/mcp` remains the canonical endpoint.

The MCP 2025-06-18 Streamable HTTP transport requires a single endpoint that supports `POST` and, when streaming is offered, `GET`; LingoStar's canonical single endpoint is `/mcp`. The root alias is compatibility-only and should not be entered in the ChatGPT app settings.

The MCP SDK enforces `Accept: application/json, text/event-stream` and `Content-Type: application/json` for `POST`. ChatGPT backend retries have been observed to send looser headers on both `/mcp` and the root compatibility path, so LingoStar normalizes MCP `POST` request headers before handing them to the SDK transport.

The widget resource metadata is generated by `server.js`:

- `_meta.ui.domain = APP_ORIGIN`
- `_meta.ui.csp.connectDomains = WIDGET_CONNECT_DOMAINS`
- `_meta.ui.csp.resourceDomains = WIDGET_RESOURCE_DOMAINS`
- legacy ChatGPT compatibility keys are also emitted:
  - `openai/widgetDomain`
  - `openai/widgetCSP`
  - `openai/widgetPrefersBorder`

Keep CSP minimal. For the current implementation, `WIDGET_CONNECT_DOMAINS` and `WIDGET_RESOURCE_DOMAINS` should usually be only `APP_ORIGIN`.

The widget resource URIs are versioned in `server.js`:

- `ui://widget/lingostar-dashboard-v0-8-0.html`
- `ui://widget/lingostar-lesson-v0-8-0.html`
- `ui://widget/lingostar-settings-v0-8-0.html`

When changing the widget UI, bump both `WIDGET_VERSION` and the URI filenames so ChatGPT does not reuse older cached component templates.

## GCP Console Checklist

1. Open Google Cloud Console and select `YOUR_GCP_PROJECT`.
2. Enable APIs: Cloud Run, Cloud Build, Artifact Registry, Secret Manager, and Firestore.
3. Open Firestore and create a Native mode database in the same region family as Cloud Run, for example `asia-northeast3`.
4. Open Secret Manager and create `openai-api-key`, `feedback-id`, and `feedback-pw`. Leave `openai-api-key` empty only if `IS_AI_FALLBACK=false`.
5. Open Cloud Run and verify the `lingostar` service allows unauthenticated requests. ChatGPT must be able to reach `/mcp`; user authorization is handled by OAuth/JWT inside LingoStar when enabled.
6. In Cloud Run's container settings, confirm HTTP/2 end-to-end is disabled. In `gcloud run services describe`, the container port should not be named `h2c`.
7. In Cloud Run service variables, confirm `APP_ORIGIN`, `WIDGET_CONNECT_DOMAINS`, `WIDGET_RESOURCE_DOMAINS`, `LINGOSTAR_STATE_STORE=firestore`, Firestore variables, OAuth variables, and feedback admin variables.
8. In ChatGPT Apps developer settings, set the MCP URL to `https://YOUR_ORIGIN/mcp`, then test `get_lingostar_state`, `manage_learning_session`, and `create_lesson_exercises`.

## State and Multi-Context Model

Firestore stores one document per ChatGPT user key. In `--developer-mode`, every request intentionally uses `developer-mode:local-demo-user` so the upload demo is stable. Outside developer mode, LingoStar derives the key from ChatGPT/OAuth subject metadata first, then falls back to conversation/session metadata.

The persisted state contains these logical contexts:

- `agentContexts.userAgent`: stable user namespace.
- `agentContexts.languageSelection`: active language sessions and goals.
- `agentContexts.trackingAgent`: natural-language progress context by language session, written in the learner's interface language.
- `agentContexts.problemManagementAgent`: natural-language weakness context by language session, written in the learner's interface language.

This is not a separate hosted multi-agent runtime. ChatGPT performs the reasoning/tool orchestration; the MCP server provides structured tools, GUI state, validation, audio fallback, OAuth checks, and durable context storage.

## Verification

Run locally:

```powershell
npm run check
npm run verify
npm run verify:auth
npm run verify:developer-mode
```

After Cloud Run deployment:

```powershell
$origin = gcloud run services describe lingostar --region asia-northeast3 --format "value(status.url)"
curl "$origin/status.json"
curl "$origin/icon.png" -I
curl "$origin/privacy-poilcy.html" -I
curl "$origin/terms-of-service.html" -I
curl "$origin/.well-known/oauth-protected-resource"
```

`/status.json` also reports `widgetVersion`, `widgetUri`, `oauthScopeMode`, `oauthScopesAdvertised`, `oauthScopesEnforced`, `oauthScopes`, `oauthRequestScopes`, `oauthClientIdConfigured`, `oauthValidateClientId`, `oauthAllowScopelessTokens`, and `feedbackAdminConfigured` for deployment diagnostics. `/healthz` is kept as a local compatibility alias, but `/status.json` is preferred for Cloud Run external checks.

## Notes

- Cloud Run IAM should allow unauthenticated HTTPS requests because ChatGPT must reach `/mcp`.
- End-user authorization is enforced by LingoStar's OAuth/JWT validation when `LINGOSTAR_AUTH_REQUIRED=1`.
- Do not enable `LINGOSTAR_DEVELOPER_MODE` in production.
- Store `OPENAI_API_KEY` only in Secret Manager, not in source files.
