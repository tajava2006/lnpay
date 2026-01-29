// Background Service Worker
// Handles extension lifecycle events and message passing

chrome.runtime.onInstalled.addListener(() => {
  console.log('Web Parser extension installed');
});
