import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const controlPlaneDockerfile = read('../Dockerfile.control-plane');
const referenceSettings = JSON.parse(read('../../infra/azure/reference-settings.json'));

// Server-side sources of the gateway, used to prove that every reference setting is read by
// the code it is passed to. A misspelt or retired name would look configured and change nothing.
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const skippedDirectories = new Set(['node_modules', '__tests__', 'public', 'public-control', 'stress-test', 'scripts']);
const serverSources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : serverSources(full);
  return entry.isFile() && /\.m?js$/.test(entry.name) ? [full] : [];
});
const gatewayRuntime = serverSources(appRoot)
  .filter((file) => path.resolve(file) !== path.resolve(appRoot, 'control-plane.js'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const readsSetting = (source, name) => new RegExp(`\\b${name}\\b`).test(source);

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

  it('ships no example credentials except the documented starter password', () => {
    const parameters = exampleParameters.parameters;
    for (const name of [
      'azureOpenAiKey',
      'azureSpeechKey',
      'accessPin',
      'sessionSecret',
      'churchesConfigJson',
    ]) {
      expect(parameters[name].value, name).toBe('');
    }
    // The starter password is public: docs/GETTING_STARTED.md prints it and tells the
    // operator to change it after the first start. The template must still accept it.
    // gettingStartedGuide.test.mjs checks that the guide prints this same value.
    expect(parameters.broadcasterPassword.value.length).toBeGreaterThanOrEqual(13);
    expect(parameters.broadcasterPassword.value).not.toMatch(/^__[A-Z_]+__$/);
    expect(apps).toContain('@minLength(6)');
    expect(apps).toContain('@maxLength(6)');
    expect(apps).toContain('@minLength(13)');
  });

  /**
   * Without a dedicated signing key the gateway derives one from the PIN and the broadcaster
   * password, so changing either one invalidates every listener session and sends every phone
   * back to the PIN screen. docs/GETTING_STARTED.md promises that this does not happen.
   */
  it('signs listener sessions with a dedicated secret, not with the PIN and password', () => {
    const gatewaySection = apps.split("resource gateway '")[1].split("resource controlPlane '")[0];
    expect(apps).toContain('param sessionSecret string');
    expect(apps).toContain('@minLength(32)');
    expect(gatewaySection).toContain("{ name: 'session-secret', value: sessionSecret }");
    expect(gatewaySection).toContain("{ name: 'SESSION_SECRET', secretRef: 'session-secret' }");
  });

  it('keeps listener feedback on its own Azure Files share with a single control-plane writer', () => {
    const controlSection = apps.split("resource controlPlane '")[1];

    expect(foundation).toContain("resource feedbackShare 'Microsoft.Storage/storageAccounts/fileServices/shares@");
    expect(foundation).toMatch(/resource environmentFeedbackStorage [^{]+\{\s+parent: environment\s+name: 'listener-feedback'/);
    expect(controlSection).toContain("{ name: 'FEEDBACK_STORAGE_ROOT', value: feedbackMountPath }");
    expect(controlSection).toContain("{ name: 'FEEDBACK_ENVIRONMENT', value: feedbackEnvironment }");
    expect(controlSection).toContain("{ name: 'FEEDBACK_PUBLIC_ORIGIN', value: controlPlaneUrl }");
    expect(controlSection).toContain("storageName: 'listener-feedback'");
    expect(controlSection).toContain('mountPath: feedbackMountPath');
    expect(controlSection).toMatch(/minReplicas: 1\s+maxReplicas: 1/);
    // The image drops to `node`; without these options the share is owned by root and every
    // report fails to save.
    expect(controlPlaneDockerfile).toContain('USER node');
    expect(controlSection).toContain("mountOptions: 'uid=1000,gid=1000,");
    // The control-plane refuses to save a report unless the storage root is itself the mount.
    expect(apps).toContain("var feedbackMountPath = '/app/feedback'");
    expect(controlPlane).toContain('requireMount: true');
  });

  it('passes the reference settings to the code that reads them', () => {
    const gatewaySection = apps.split("resource gateway '")[1].split("resource controlPlane '")[0];
    const controlSection = apps.split("resource controlPlane '")[1];

    expect(apps).toContain("var referenceSettings = loadJsonContent('reference-settings.json')");
    expect(gatewaySection).toContain('], listenerSettings, gatewaySettings)');
    expect(controlSection).toContain('], listenerSettings)');
    expect(Object.keys(referenceSettings.gateway).length).toBeGreaterThan(0);

    for (const [name, value] of Object.entries(referenceSettings.gateway)) {
      expect(typeof value, name).toBe('string');
      expect(readsSetting(gatewayRuntime, name), `gateway code does not read ${name}`).toBe(true);
    }
    // The listener app reads its features from whichever surface served it, so both
    // surfaces receive the same group.
    for (const [name, value] of Object.entries(referenceSettings.listener)) {
      expect(typeof value, name).toBe('string');
      expect(readsSetting(gatewayRuntime, name), `gateway code does not read ${name}`).toBe(true);
      expect(readsSetting(controlPlane, name), `control-plane does not read ${name}`).toBe(true);
    }
    expect(referenceSettings.gateway).not.toHaveProperty('EVAL_LOGGING_ENABLED');
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
