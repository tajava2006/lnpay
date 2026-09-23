/**
 * 운영 설정 — DB에 산다. 어드민 앱이 `config.set`으로 바꾼다.
 *
 * 저장본은 **기본값 위에 다시 적용해서** 읽는다. 새 설정 키가 추가돼도 옛 저장본이 그대로 읽히고,
 * 저장본이 망가졌으면(검증 실패) 기본값으로 돌아간다 — 반쯤 읽힌 설정으로 돌지 않는다.
 */
import { DEFAULT_SETTINGS, applySettingsPatch, type DaemonSettings } from '@sajwo-tracker/shared/core';
import type { Db } from '../db';

const KEY = 'settings';

export function loadSettings(db: Db): DaemonSettings {
  const raw = db.kvGet(KEY);
  if (!raw) return DEFAULT_SETTINGS;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  const merged = applySettingsPatch(DEFAULT_SETTINGS, stored);
  return merged.ok ? merged.settings : DEFAULT_SETTINGS;
}

export function saveSettings(db: Db, settings: DaemonSettings): void {
  db.kvSet(KEY, JSON.stringify(settings));
}
