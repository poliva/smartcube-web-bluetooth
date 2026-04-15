import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixtureSession } from './types';

function capturesDir(): string {
  // tests run from project root; be explicit to avoid cwd surprises
  return join(process.cwd(), 'captures');
}

export async function loadFixture(filename: string): Promise<FixtureSession> {
  const fullPath = join(capturesDir(), filename);
  const raw = await readFile(fullPath, 'utf8');
  const parsed = JSON.parse(raw) as FixtureSession;

  if (parsed.format !== 'smartcube-fixture' || parsed.version !== 1) {
    throw new Error(`Unsupported fixture format/version in ${filename}`);
  }
  return parsed;
}

export const FIXTURES = {
  ganGen2_small: 'fixture_GANicXXX_gan-gen2_2026-04-14T11-39-47.json',
  giiker: 'fixture_Giiker_i3SE_giiker_2026-04-14T11-42-39.json',
  gocube: 'fixture_GoCube_gocube_2026-04-14T11-43-52.json',
  rubiksConnected: 'fixture_Rubiks_Connected_gocube_2026-04-14T11-50-17.json',
  moyu32_my32: 'fixture_WCU_MY32_A388_moyu32_2026-04-15T06-43-44.json',
  moyu32_my33_noGyro: 'fixture_WCU_MY33_AF9E_moyu32_2026-04-14T11-53-23.json',
  qiyi: 'fixture_QY-QYSC-S-A0E6________qiyi_2026-04-14T11-37-22.json',
  ganGen4: 'fixture_GANi4_A26E_gan-gen4_2026-04-14T11-38-02.json',
} as const;

