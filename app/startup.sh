#!/bin/bash
# Barnaba Control Plane Startup Script
# Authenticates with Azure using Service Principal, then starts Node.js

echo "[Startup] ================================================"
echo "[Startup] Barnaba Control Plane Starting..."
echo "[Startup] ================================================"

verify_azure_resource_access() {
    if [ -z "$AZURE_SUBSCRIPTION_ID" ] || [ -z "$AZURE_RESOURCE_GROUP" ] || [ -z "$GATEWAY_CONTAINER_NAME" ]; then
        echo "[Startup] ERROR: Azure resource coordinates are incomplete"
        return 1
    fi

    if ! az account set --subscription "$AZURE_SUBSCRIPTION_ID"; then
        echo "[Startup] ERROR: Cannot select the configured Azure subscription"
        return 1
    fi

    RESOURCE_URL="/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_RESOURCE_GROUP}/providers/Microsoft.App/containerApps/${GATEWAY_CONTAINER_NAME}?api-version=2024-03-01"
    if ! az rest --method GET --url "$RESOURCE_URL" --output none; then
        echo "[Startup] ERROR: Azure identity cannot read the managed Container App"
        return 1
    fi

    echo "[Startup] Azure resource access verified"
}

if [ "$AZURE_USE_MANAGED_IDENTITY" = "true" ]; then
    echo "[Startup] Logging in with Managed Identity..."

    if [ -n "$AZURE_CLIENT_ID" ]; then
        LOGIN_ARGS=(--identity --client-id "$AZURE_CLIENT_ID")
    else
        LOGIN_ARGS=(--identity)
    fi

    if az login "${LOGIN_ARGS[@]}" --output none; then
        echo "[Startup] Azure managed identity login successful!"
    else
        echo "[Startup] ERROR: Azure managed identity login failed!"
        echo "[Startup] Container management will NOT work!"
        exit 1
    fi

    verify_azure_resource_access || exit 1

    echo "[Startup] Starting Control Plane..."
    exec node control-plane.js
fi

# Check if Service Principal credentials are configured
if [ -z "$AZURE_CLIENT_ID" ] || [ -z "$AZURE_CLIENT_SECRET" ] || [ -z "$AZURE_TENANT_ID" ]; then
    echo "[Startup] ERROR: Service Principal not configured"
    echo "[Startup] Missing: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, or AZURE_TENANT_ID"
    echo "[Startup] Container management will NOT work!"
    exit 1
fi

echo "[Startup] Logging in with Service Principal..."

if az login --service-principal \
    --username "$AZURE_CLIENT_ID" \
    --password "$AZURE_CLIENT_SECRET" \
    --tenant "$AZURE_TENANT_ID" \
    --output none; then
    echo "[Startup] Azure login successful!"
else
    echo "[Startup] ERROR: Azure login failed!"
    echo "[Startup] Container management will NOT work!"
    exit 1
fi

verify_azure_resource_access || exit 1

echo "[Startup] Starting Control Plane..."
exec node control-plane.js
