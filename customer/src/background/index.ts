// Background Service Worker
// Handles extension lifecycle events and message passing

chrome.runtime.onInstalled.addListener(() => {
  console.log('Web Parser extension installed');
});

// SPA 네비게이션 감지 - history.pushState/replaceState 호출 시 발생
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    // 쿠팡 주문 상세 페이지인 경우에만 Content Script에 알림
    if (details.url.includes('/order/')) {
      console.log('[Web Parser] SPA navigation detected:', details.url);

      chrome.tabs.sendMessage(details.tabId, {
        type: 'URL_CHANGED',
        url: details.url,
      });
    }
  },
  { url: [{ hostContains: 'mc.coupang.com' }] }
);
