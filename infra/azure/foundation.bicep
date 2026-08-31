targetScope = 'resourceGroup'

@description('Azure region with an Azure Container Apps A100 consumption profile.')
param location string = 'swedencentral'

@description('Lower-case prefix used for public Azure resources.')
@minLength(3)
@maxLength(16)
param prefix string = 'barnaba'

@description('Globally unique Azure Container Registry name.')
@minLength(5)
@maxLength(50)
param acrName string

@description('Azure Container Apps managed environment name.')
param environmentName string = '${prefix}-env'

@description('Friendly name of the A100 workload profile.')
param gpuProfileName string = 'gpu-a100'

@description('Region-supported A100 profile type. Verify it with az containerapp env workload-profile list-supported.')
param gpuProfileType string = 'Consumption-GPU-NC24-A100'

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

var compactPrefix = toLower(replace(prefix, '-', ''))
var storageAccountName = take('${compactPrefix}${uniqueString(subscription().id, resourceGroup().id)}', 24)
var pullIdentityName = '${prefix}-image-pull'
var controlIdentityName = '${prefix}-control-identity'
var resourceTags = {
  project: 'barnaba'
  environment: environmentTag
  owner: ownerTag
  'managed-by': 'bicep'
  system: 'oss-reference'
}
var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: resourceTags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: resourceTags
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: gpuProfileName
        workloadProfileType: gpuProfileType
      }
    ]
  }
}

resource modelStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: resourceTags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource modelShareService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: modelStorage
  name: 'default'
}

resource modelShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: modelShareService
  name: 'whisper-models'
  properties: {
    enabledProtocols: 'SMB'
  }
}

resource environmentModelStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'whisper-models'
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountName: modelStorage.name
      accountKey: modelStorage.listKeys().keys[0].value
      shareName: modelShare.name
    }
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
  tags: resourceTags
}

resource controlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: controlIdentityName
  location: location
  tags: resourceTags
}

resource pullIdentityAcrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentName string = environment.name
output environmentDefaultDomain string = environment.properties.defaultDomain
output gpuProfileName string = gpuProfileName
output pullIdentityId string = pullIdentity.id
output controlIdentityId string = controlIdentity.id
output controlIdentityClientId string = controlIdentity.properties.clientId
output modelStorageName string = modelStorage.name
output modelShareName string = modelShare.name
