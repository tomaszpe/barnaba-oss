import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const guide = read('../../docs/GETTING_STARTED.md');
const readme = read('../../README.md');
const deploymentReadme = read('../../infra/azure/README.md');
const apps = read('../../infra/azure/apps.bicep');
const starterPassword = JSON.parse(read('../../infra/azure/parameters.example.json'))
  .parameters.broadcasterPassword.value;

describe('getting-started guide', () => {
  it('is linked from the README and the deployment README', () => {
    expect(readme).toContain('[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)');
    expect(deploymentReadme).toContain('(../../docs/GETTING_STARTED.md#8-change-the-broadcaster-password)');
  });

  it('prints the starter password that the example parameters file contains', () => {
    // An unreplaced release placeholder must fail here, before anyone deploys it.
    for (const text of [guide, readme, deploymentReadme, starterPassword]) {
      expect(text).not.toMatch(/__[A-Z_]+__/);
    }
    expect(guide).toContain(`**Starter broadcaster password: \`${starterPassword}\`**`);
    expect(guide).toContain(`| \`broadcasterPassword\` | leave \`${starterPassword}\` for the first start |`);
    expect(guide).toContain(`"broadcasterPassword": { "value": "${starterPassword}" },`);
    expect(guide).toContain(`On a new installation it is\n\`${starterPassword}\`.`);
    expect(readme).toContain(`starter broadcaster password \`${starterPassword}\``);
    expect(deploymentReadme).toContain(`starter broadcaster password \`${starterPassword}\``);
  });

  it('states the minimum password length that the template enforces', () => {
    const minimum = Number(/@minLength\((\d+)\)\nparam broadcasterPassword string/.exec(apps)?.[1]);

    expect(minimum).toBe(13);
    expect(starterPassword.length).toBeGreaterThanOrEqual(minimum);
    expect(guide).toContain(`of at least ${minimum} characters`);
    expect(deploymentReadme).toContain(`a broadcaster password shorter than\n${minimum} characters`);
  });

  it('shows only screenshots that exist in the repository', () => {
    const images = [...guide.matchAll(/(?:\]\(|src=")(images\/getting-started\/[^")]+\.png)/g)]
      .map((match) => match[1]);

    expect(images).toHaveLength(11);
    for (const image of images) {
      expect(existsSync(new URL(`../../docs/${image}`, import.meta.url)), image).toBe(true);
    }
  });

  it('quotes the control-panel messages that the panel actually shows', () => {
    const panel = read('../public-control/admin.html');
    const controlPlane = read('../control-plane.js');

    expect(guide).toContain('`Control login failed: Invalid password`');
    expect(guide).toContain('`Control login failed: Too many requests. Please try again later.`');
    expect(panel).toContain("showToast('Control login failed: ' + error.message, 'error', 7000);");
    expect(controlPlane).toContain("error: 'Too many requests. Please try again later.',");
    expect(controlPlane).toContain('maxRequests: 10, windowMs: 60000');
    expect(guide).toContain('at most 10 requests per minute');

    expect(guide).toContain('model warm-up timed out after 720s');
    expect(panel).toContain('const WHISPER_STARTUP_WAIT_MS = 720000;');
  });
});
