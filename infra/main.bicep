@description('The name of the application')
param appName string = 'cadam'

@description('The environment (dev, staging, prod)')
param environment string = 'prod'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Container image tag')
param imageTag string = 'latest'

@description('Azure Container Registry name')
param acrName string = '${appName}acr${uniqueString(resourceGroup().id)}'

@description('CPU cores for container app')
param containerCpu string = '1.0'

@description('Memory in Gi for container app')
param containerMemory string = '2.0'

@description('Minimum replicas')
param minReplicas int = 1

@description('Maximum replicas')
param maxReplicas int = 3

// Tags
var tags = {
  app: appName
  environment: environment
  managedBy: 'bicep'
}

// Unique suffix for naming
var uniqueSuffix = uniqueString(resourceGroup().id)

// Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-law-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Azure Container Registry
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// Container Apps Environment
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// User-assigned managed identity for the container app
resource containerAppIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-07-31-preview' = {
  name: '${appName}-identity-${uniqueSuffix}'
  location: location
  tags: tags
}

// Assign AcrPull role to the managed identity
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, containerAppIdentity.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: containerAppIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Container App
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-app-${uniqueSuffix}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${containerAppIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: containerAppIdentity.id
        }
      ]
      secrets: []
    }
    template: {
      revisionSuffix: imageTag
      containers: [
        {
          name: appName
          image: '${acr.properties.loginServer}/${appName}:${imageTag}'
          resources: {
            cpu: json(containerCpu)
            memory: '${containerMemory}Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'NITRO_PORT'
              value: '3000'
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: []
      }
    }
  }
  dependsOn: [
    acrPullRole
  ]
}

// Outputs
output acrLoginServer string = acr.properties.loginServer
output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppName string = containerApp.name
output acrName string = acr.name
