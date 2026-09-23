/**
 * 런타임 무관한 코어 (PLAN-DAEMON §10)
 *
 * 데몬(Node)이 가져다 쓰는 입구다. **여기서 내보내는 것은 브라우저·Vite·React에 기대지 않는다** —
 * localStorage·IndexedDB·컴포넌트는 `@sajwo-tracker/shared` 루트에만 있다. 루트를 데몬에서 부르면
 * React까지 딸려 오고, 저장소 모듈이 로드 시점에 `localStorage`를 찾는다.
 */
export {
  APP_PUBKEY,
  SAJWO_REQUEST_KIND,
  SAJWO_REQUEST_EVENT_KIND,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  REQUEST_ACTIONS,
  ORDER_STATES,
  TERMINAL_STATES,
  isTerminalState,
} from './constants';
export type { RequestAction, OrderState } from './constants';

export { nip44Encrypt, nip44Decrypt } from './crypto';
