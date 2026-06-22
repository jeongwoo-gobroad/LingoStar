param(
  [Parameter(Mandatory = $true)]
  [string] $ProjectId,
  [string] $Region = "asia-northeast3",
  [string] $Service = "lingostar",
  [string] $AppOrigin = "",
  [string] $CorsAllowedOrigins = "",
  [string] $WidgetConnectDomains = "",
  [string] $WidgetResourceDomains = "",
  [string] $OpenAiSecret = "openai-api-key:latest",
  [string] $StateStore = "firestore",
  [string] $FirestoreProjectId = "",
  [string] $FirestoreDatabaseId = "(default)",
  [string] $FirestoreCollection = "lingostar_states",
  [string] $IsAiFallback = "true",
  [switch] $AuthRequired,
  [string] $OAuthIssuer = "",
  [string] $OAuthAuthorizationServers = "",
  [string] $OAuthJwksUrl = "",
  [string] $OAuthAudience = "",
  [string] $OAuthScopes = "lingostar.read lingostar.write lingostar.audio",
  [string] $OAuthRequestScopes = "lingostar.read lingostar.write lingostar.audio",
  [string] $OAuthClientId = "",
  [ValidateSet("strict", "optional", "none")]
  [string] $OAuthScopeMode = "none",
  [string] $OAuthValidateClientId = "true",
  [string] $OAuthAllowScopelessTokens = "false",
  [string] $FeedbackAdminIdSecret = "feedback-id:latest",
  [string] $FeedbackAdminPasswordSecret = "feedback-pw:latest"
)

$ErrorActionPreference = "Stop"

$appOriginProvided = [bool] $AppOrigin
if (-not $AppOrigin) {
  $AppOrigin = "https://placeholder.invalid"
}
if (-not $CorsAllowedOrigins) { $CorsAllowedOrigins = "$AppOrigin,https://chatgpt.com" }
if (-not $WidgetConnectDomains) { $WidgetConnectDomains = $AppOrigin }
if (-not $WidgetResourceDomains) { $WidgetResourceDomains = $AppOrigin }
if (-not $OAuthAuthorizationServers) {
  $OAuthAuthorizationServers = $OAuthIssuer
}
if (-not $OAuthAudience) {
  $OAuthAudience = $AppOrigin
}
if (-not $FirestoreProjectId) {
  $FirestoreProjectId = $ProjectId
}

function Get-EnvVars {
  $authFlag = if ($AuthRequired) { "1" } else { "0" }
  $vars = @(
    "APP_ORIGIN=$AppOrigin",
    "CORS_ALLOWED_ORIGINS=$CorsAllowedOrigins",
    "WIDGET_CONNECT_DOMAINS=$WidgetConnectDomains",
    "WIDGET_RESOURCE_DOMAINS=$WidgetResourceDomains",
    "IS_AI_FALLBACK=$IsAiFallback",
    "LINGOSTAR_STATE_STORE=$StateStore",
    "FIRESTORE_PROJECT_ID=$FirestoreProjectId",
    "FIRESTORE_DATABASE_ID=$FirestoreDatabaseId",
    "FIRESTORE_COLLECTION=$FirestoreCollection",
    "LINGOSTAR_AUTH_REQUIRED=$authFlag",
    "OAUTH_ISSUER=$OAuthIssuer",
    "OAUTH_AUTHORIZATION_SERVERS=$OAuthAuthorizationServers",
    "OAUTH_JWKS_URL=$OAuthJwksUrl",
    "OAUTH_AUDIENCE=$OAuthAudience",
    "OAUTH_SCOPES=$OAuthScopes",
    "OAUTH_REQUEST_SCOPES=$OAuthRequestScopes",
    "OAUTH_CLIENT_ID=$OAuthClientId",
    "OAUTH_SCOPE_MODE=$OAuthScopeMode",
    "OAUTH_VALIDATE_CLIENT_ID=$OAuthValidateClientId",
    "OAUTH_ALLOW_SCOPELESS_TOKENS=$OAuthAllowScopelessTokens",
    "OAUTH_RESOURCE_DOCUMENTATION=$AppOrigin/privacy-policy.html"
  )
  return "^##^" + ($vars -join "##")
}

gcloud config set project $ProjectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com

function Deploy-Service {
  gcloud run deploy $Service `
    --source . `
    --region $Region `
    --allow-unauthenticated `
    --port 8080 `
    --no-use-http2 `
    --memory 512Mi `
    --cpu 1 `
    --timeout 300 `
    --set-env-vars (Get-EnvVars) `
    --set-secrets "OPENAI_API_KEY=$OpenAiSecret,FEEDBACK_ADMIN_ID=$FeedbackAdminIdSecret,FEEDBACK_ADMIN_PASSWORD=$FeedbackAdminPasswordSecret"
}

Deploy-Service

$serviceUrl = gcloud run services describe $Service `
  --region $Region `
  --format "value(status.url)"

if (-not $appOriginProvided) {
  $AppOrigin = $serviceUrl
  $CorsAllowedOrigins = "$serviceUrl,https://chatgpt.com"
  $WidgetConnectDomains = $serviceUrl
  $WidgetResourceDomains = $serviceUrl
  $OAuthAudience = $serviceUrl
  Deploy-Service
}

Write-Output $serviceUrl
