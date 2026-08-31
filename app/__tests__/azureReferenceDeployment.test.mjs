import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const foundation = read('../../infra/azure/foundation.bicep');
const apps = read('../../infra/azure/apps.bicep');
const buildImages = read('../../infra/azure/build-images.ps1');
const smokeTest = read('../../infra/azure/smoke-test.ps1');
const exampleParameters = JSON.parse(read('../../infra/azure/parameters.example.json'));
const readme = read('../../README.md');
const contributing = read('../../CONTRIBUTING.md');
const controlPlane = read('../control-plane.js');
const startup = read('../startup.sh');

describe('Azure reference deployment contract', () => {
  it('uses ACR with managed identity and no registry admin credentials', () => {
    expect(foundation).toContain("adminUserEnabled: false");
    expect(foundation).toContain("roleDefinitionId: acrPullRoleDefinitionId");
    expect(foundation).toContain("resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@");
    expect(foundation).toContain("resource controlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@");
    expect(apps).toContain('identity: pullIdentity.id');
    expect(apps).not.toContain('registry-password');
  });

  it('pins the supported Azure GPU topology and persists the model cache', () => {
    expect(foundation).toContain("gpuProfileType string = 'Consumption-GPU-NC24-A100'");
    expect(foundation).toContain("name: 'whisper-models'");
    expect(apps).toContain('workloadProfileName: gpuProfileName');
    expect(apps).toContain("storageType: 'AzureFile'");
    expect(apps).toContain("mountPath: '/var/cache/whisper'");
  });

  it('applies mandatory cost-allocation tags to every taggable resource', () => {
    for (const template of [foundation, apps]) {
      expect(template).toContain("project: 'barnaba'");
      expect(template).toContain('environment: environmentTag');
      expect(template).toContain('owner: ownerTag');
      expect(template).toContain("'managed-by': 'bicep'");
    }
    expect(foundation.match(/tags: resourceTags/g)).toHaveLength(5);
    expect(apps.match(/tags: resourceTags/g)).toHaveLength(3);
  });

  it('keeps Whisper internal while exposing gateway and control-plane over HTTPS', () => {
    const whisperSection = apps.split("resource gateway '")[0];
    const gatewaySection = apps.split("resource gateway '")[1].split("resource controlPlane '")[0];
    const controlSection = apps.split("resource controlPlane '")[1];

    expect(whisperSection).toContain('external: false');
    expect(gatewaySection).toContain('external: true');
    expect(controlSection).toContain('external: true');
    expect(apps).toContain("allowInsecure: false");
  });

  it('builds all images remotely and rejects abbreviated source tags', () => {
    expect(buildImages).toContain("[ValidatePattern('^[0-9a-f]{40}$')]");
    expect(buildImages.match(/'acr', 'build'/g)).toHaveLength(4);
    expect(buildImages).toContain('WHISPER_BASE_IMAGE=$baseImage');
    expect(buildImages).toContain('status --porcelain --untracked-files=all');
    expect(buildImages).toContain('$sourceHead -cne $ImageTag');
    expect(buildImages).not.toContain('$LASTEXITCODE:');
    expect(buildImages).not.toMatch(/\bdocker\s+(build|compose|run)\b/i);
  });

  it('ships no deployable example credentials', () => {
    const parameters = exampleParameters.parameters;
    for (const name of [
      'azureOpenAiKey',
      'azureSpeechKey',
      'accessPin',
      'broadcasterPassword',
      'churchesConfigJson',
    ]) {
      expect(parameters[name].value, name).toBe('');
    }
    expect(apps).toContain('@minLength(6)');
    expect(apps).toContain('@maxLength(6)');
    expect(apps).toContain('@minLength(16)');
  });

  it('has no supported local runtime or CLA gate', () => {
    const publicPolicy = `${readme}\n${contributing}`;
    expect(publicPolicy).not.toMatch(/\bcompose\b/i);
    expect(publicPolicy).toContain('There is no Contributor License Agreement');
    expect(publicPolicy).not.toContain('[CLA.md]');
    expect(publicPolicy).not.toContain('CLA Assistant');
    expect(controlPlane).not.toContain('LOCAL_MODE');
    expect(startup).not.toContain('LOCAL_MODE');
    const missingCredentials = startup
      .split('# Check if Service Principal credentials are configured')[1]
      .split('echo "[Startup] Logging in with Service Principal..."')[0];
    expect(missingCredentials).toContain('exit 1');
    expect(missingCredentials).not.toContain('exec node control-plane.js');
  });

  it('documents the full AGPL terms with an external link', () => {
    expect(readme).toContain('https://www.gnu.org/licenses/agpl-3.0.html');
  });

  it('ships an automated fail-closed smoke test that always requests shutdown', () => {
    expect(smokeTest).toContain("Get-RequiredEnvironmentValue 'BROADCASTER_PASSWORD'");
    expect(smokeTest).toContain("Get-RequiredEnvironmentValue 'AZURE_SPEECH_KEY'");
    expect(smokeTest).toContain("'/api/control/start-system'");
    expect(smokeTest).toContain('/api/transcribe');
    expect(smokeTest).toContain('finally');
    expect(smokeTest).toContain("'/api/control/stop-all'");
    expect(smokeTest).toContain('Wait-ForStoppedApps');
    expect(smokeTest).toContain('shutdownConfirmed = $shutdownConfirmed');
    expect(smokeTest).toContain("'barnaba-whisper-base'");
    expect(smokeTest).toContain('publicCommit = $sourceCommit');
    const smokeParameters = smokeTest.split('Set-StrictMode')[0];
    expect(smokeParameters).not.toMatch(/BroadcasterPassword|AzureSpeechKey/);
  });
});
