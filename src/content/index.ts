// Content Script
// 쿠팡 주문 상세 페이지에서 JSON API를 직접 호출하여 데이터 추출

async function fetchOrderData() {
  // 1. 현재 URL에서 orderId 추출
  const match = window.location.pathname.match(/\/order\/(\d+)/);
  if (!match) {
    console.log('[Web Parser] Not an order page');
    return;
  }
  const orderId = match[1];
  console.log('[Web Parser] Order ID:', orderId);

  // 2. __NEXT_DATA__에서 buildId 추출
  const nextDataScript = document.getElementById('__NEXT_DATA__');
  if (!nextDataScript) {
    console.error('[Web Parser] __NEXT_DATA__ not found');
    return;
  }

  let buildId: string;
  try {
    const nextData = JSON.parse(nextDataScript.textContent || '');
    buildId = nextData.buildId;
    console.log('[Web Parser] Build ID:', buildId);
  } catch (e) {
    console.error('[Web Parser] Failed to parse __NEXT_DATA__:', e);
    return;
  }

  // 3. JSON API URL 구성
  const jsonUrl = `https://mc.coupang.com/ssr/_next/data/${buildId}/desktop/order/${orderId}.json?orderId=${orderId}`;
  console.log('[Web Parser] Fetching:', jsonUrl);

  // 4. fetch로 호출
  try {
    const response = await fetch(jsonUrl, {
      credentials: 'include', // 쿠키 포함
    });

    if (!response.ok) {
      console.error('[Web Parser] Fetch failed:', response.status, response.statusText);
      return;
    }

    const data = await response.json();
    console.log('[Web Parser] Order JSON captured:', data);
  } catch (e) {
    console.error('[Web Parser] Fetch error:', e);
  }
}

// 페이지 로드 완료 후 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fetchOrderData);
} else {
  fetchOrderData();
}

console.log('[Web Parser] Content script loaded on:', window.location.href);
