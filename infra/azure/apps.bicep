targetScope = 'resourceGroup'

param location string = 'swedencentral'
param prefix string = 'barnaba'
param acrName string
param environmentName string = '${prefix}-env'
param gpuProfileName string = 'gpu-a100'

@minLength(40)
@maxLength(40)
param imageTag string

param gatewayName string = '${prefix}-gateway'
param whisperName string = '${prefix}-whisper'
param controlPlaneName string = '${prefix}-control'
param pullIdentityName string = '${prefix}-image-pull'
param controlIdentityName string = '${prefix}-control-identity'

@description('Owner value used for mandatory Azure cost-allocation tags.')
@minLength(1)
param ownerTag string

@description('Environment value used for mandatory Azure cost-allocation tags.')
@allowed([
  'dev'
  'demo'
  'prod'
])
param environmentTag string = 'dev'

param azureOpenAiEndpoint string
@secure()
@minLength(1)
param azureOpenAiKey string
param azureSpeechRegion string
@secure()
@minLength(1)
param azureSpeechKey string
@secure()
@minLength(6)
@maxLength(6)
param accessPin string
@secure()
@minLength(13)
param broadcasterPassword string
@secure()
@minLength(2)
param churchesConfigJson string

param whisperModel string = 'Flurin17/whisper-large-v3-turbo-swiss-german'
param whisperModelRevision string = '34415231e554d1e7005118264f41e287922f9218'

@description('Name of this installation inside the listener-feedback share: lower-case letters, digits and hyphens, starting with a letter or digit.')
@minLength(1)
@maxLength(32)
param feedbackEnvironment string = prefix

// Pipeline and listener settings of the reference environment. See infra/azure/README.md.
var referenceSettings = loadJsonContent('reference-settings.json')
var listenerSettings = map(items(referenceSettings.listener), setting => {
  name: setting.key
  value: setting.value
})
var gatewaySettings = map(items(referenceSettings.gateway), setting => {
  name: setting.key
  value: setting.value
})
var feedbackMountPath = '/app/feedback'

var containerAppContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b24988ac-6180-42a0-ab88-20f7382dd24c'
)
var registryServer = registry.properties.loginServer
var defaultDomain = environment.properties.defaultDomain
var gatewayUrl = 'https://${gatewayName}.${defaultDomain}'
// Whisper takes internal traffic only, so its name resolves under the environment's
// internal domain, not the public one. Reading the address off the resource keeps the
// gateway and the control plane pointed at it even if the ingress mode ever changes.
var whisperUrl = 'https://${whisper.properties.configuration.ingress.fqdn}'
var controlPlaneUrl = 'https://${controlPlaneName}.${defaultDomain}'
var resourceTags = {
  project: 'barnaba'
  environment: environmentTag
  owner: ownerTag
  'managed-by': 'bicep'
  system: 'oss-reference'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: pullIdentityName
}

resource controlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: controlIdentityName
}

resource whisper 'Microsoft.App/containerApps@2024-03-01' = {
  name: whisperName
  location: location
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: gpuProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 8000
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          identity: pullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'whisper'
          image: '${registryServer}/barnaba-whisper:${imageTag}'
          resources: {
            cpu: json('24')
            memory: '220Gi'
          }
          env: [
            { name: 'PORT', value: '8000' }
            { name: 'WHISPER_MODEL', value: whisperModel }
            { name: 'WHISPER_MODEL_REVISION', value: whisperModelRevision }
            { name: 'WHISPER_ALLOW_UNVERIFIED_MODEL', value: 'false' }
            { name: 'WHISPER_DEVICE', value: 'cuda' }
            { name: 'WHISPER_COMPUTE_TYPE', value: 'float16' }
            { name: 'WHISPER_LANGUAGE', value: 'de' }
            { name: 'WHISPER_DOWNLOAD_ROOT', value: '/var/cache/whisper/transformers' }
            { name: 'HF_HOME', value: '/var/cache/whisper/transformers' }
            { name: 'TRANSFORMERS_CACHE', value: '/var/cache/whisper/transformers' }
            { name: 'WHISPER_CORS_ALLOWED_ORIGINS', value: '${gatewayUrl},${controlPlaneUrl}' }
            { name: 'HALLUCINATION_F2_PROSE_GUARD_ENABLED', value: 'true' }
            { name: 'LA_TEXT_ANCHOR_ENABLED', value: 'true' }
            { name: 'TOKEN_TIMESTAMP_PROBE_ENABLED', value: 'false' }
            { name: 'VOLUME_GATE_ENABLED', value: 'false' }
          ]
          volumeMounts: [
            {
              volumeName: 'whisper-models'
              mountPath: '/var/cache/whisper'
            }
          ]
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8000
                scheme: 'HTTP'
              }
              // Container Apps accepts initialDelaySeconds only up to 60, so the wait for the
              // model to load lives in the retries: 60 + 10 x 30 = 360 s before the replica is
              // reported unhealthy. A readiness failure only keeps the replica out of rotation.
              initialDelaySeconds: 60
              periodSeconds: 30
              timeoutSeconds: 30
              failureThreshold: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'whisper-models'
          storageType: 'AzureFile'
          storageName: 'whisper-models'
        }
      ]
    }
  }
}

resource gateway 'Microsoft.App/containerApps@2024-03-01' = {
  name: gatewayName
  location: location
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'azure-openai-key', value: azureOpenAiKey }
        { name: 'azure-speech-key', value: azureSpeechKey }
        { name: 'access-pin', value: accessPin }
        { name: 'broadcaster-password', value: broadcasterPassword }
        { name: 'churches-config', value: churchesConfigJson }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: '${registryServer}/barnaba-gateway:${imageTag}'
          resources: {
            cpu: json('1')
            memory: '2Gi'
          }
          env: concat([
            { name: 'PORT', value: '8080' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'WHISPER_SERVICE_URL', value: whisperUrl }
            { name: 'APP_URL', value: controlPlaneUrl }
            { name: 'CORS_ALLOWED_ORIGINS', value: '${gatewayUrl},${controlPlaneUrl}' }
            { name: 'CHURCHES_CONFIG_PATH', value: '/app/config/churches.json' }
            { name: 'WHISPER_AUTO_SHUTDOWN', value: 'true' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
            { name: 'AZURE_OPENAI_KEY', secretRef: 'azure-openai-key' }
            { name: 'AZURE_SPEECH_REGION', value: azureSpeechRegion }
            { name: 'AZURE_SPEECH_KEY', secretRef: 'azure-speech-key' }
            { name: 'ACCESS_PIN', secretRef: 'access-pin' }
            { name: 'BROADCASTER_PASSWORD', secretRef: 'broadcaster-password' }
            { name: 'USE_SERVER_TTS', value: 'true' }
          ], listenerSettings, gatewaySettings)
          volumeMounts: [
            {
              volumeName: 'churches-config'
              mountPath: '/app/config'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'churches-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'churches-config'
              path: 'churches.json'
            }
          ]
        }
      ]
    }
  }
}

resource controlPlane 'Microsoft.App/containerApps@2024-03-01' = {
  name: controlPlaneName
  location: location
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
      '${controlIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8090
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'broadcaster-password', value: broadcasterPassword }
        { name: 'churches-config', value: churchesConfigJson }
      ]
    }
    template: {
      containers: [
        {
          name: 'control-plane'
          image: '${registryServer}/barnaba-control-plane:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat([
            { name: 'NODE_ENV', value: 'production' }
            { name: 'CONTROL_PLANE_PORT', value: '8090' }
            { name: 'AZURE_USE_MANAGED_IDENTITY', value: 'true' }
            { name: 'AZURE_CLIENT_ID', value: controlIdentity.properties.clientId }
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'AZURE_RESOURCE_GROUP', value: resourceGroup().name }
            { name: 'WHISPER_RESOURCE_GROUP', value: resourceGroup().name }
            { name: 'WHISPER_CONTAINER_NAME', value: whisper.name }
            { name: 'GATEWAY_CONTAINER_NAME', value: gateway.name }
            { name: 'WHISPER_SERVICE_URL', value: whisperUrl }
            { name: 'GATEWAY_URL', value: gatewayUrl }
            { name: 'CHURCHES_CONFIG_PATH', value: '/app/config/churches.json' }
            { name: 'BROADCASTER_PASSWORD', secretRef: 'broadcaster-password' }
            { name: 'FEEDBACK_STORAGE_ROOT', value: feedbackMountPath }
            { name: 'FEEDBACK_ENVIRONMENT', value: feedbackEnvironment }
            { name: 'FEEDBACK_PUBLIC_ORIGIN', value: controlPlaneUrl }
          ], listenerSettings)
          volumeMounts: [
            {
              volumeName: 'churches-config'
              mountPath: '/app/config'
            }
            {
              volumeName: 'listener-feedback'
              mountPath: feedbackMountPath
            }
          ]
        }
      ]
      // One replica only: the control-plane is the single writer of the feedback files.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'churches-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'churches-config'
              path: 'churches.json'
            }
          ]
        }
        {
          name: 'listener-feedback'
          storageType: 'AzureFile'
          storageName: 'listener-feedback'
          // The image runs as the unprivileged `node` user (uid and gid 1000).
          mountOptions: 'uid=1000,gid=1000,dir_mode=0750,file_mode=0640'
        }
      ]
    }
  }
}

resource controlWhisperRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(whisper.id, controlIdentity.id, containerAppContributorRoleDefinitionId)
  scope: whisper
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppContributorRoleDefinitionId
  }
}

resource controlGatewayRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(gateway.id, controlIdentity.id, containerAppContributorRoleDefinitionId)
  scope: gateway
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppContributorRoleDefinitionId
  }
}

output gatewayUrl string = gatewayUrl
output whisperUrl string = whisperUrl
output controlPlaneUrl string = controlPlaneUrl
