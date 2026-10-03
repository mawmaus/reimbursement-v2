'use strict';

// Offline page (offline.html, served by sw.js): follow the user's saved theme
// and language (the same localStorage keys theme.js and i18n.js use). Strings
// live here rather than in i18n.js so the page works from the offline cache
// without loading the full UI bundle.
(function () {
  function get(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }

  var theme = get('reimb.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

  var STR = {
    en: ["You're offline", 'The portal needs an internet connection. Check your connection, then try again.', 'Try again'],
    id: ['Anda sedang offline', 'Portal memerlukan koneksi internet. Periksa koneksi Anda, lalu coba lagi.', 'Coba lagi'],
    th: ['คุณออฟไลน์อยู่', 'พอร์ทัลต้องใช้การเชื่อมต่ออินเทอร์เน็ต โปรดตรวจสอบการเชื่อมต่อ แล้วลองอีกครั้ง', 'ลองอีกครั้ง'],
    vi: ['Bạn đang ngoại tuyến', 'Cổng thông tin cần kết nối internet. Hãy kiểm tra kết nối rồi thử lại.', 'Thử lại'],
    km: ['អ្នកកំពុងគ្មានអ៊ីនធឺណិត', 'វិបផតថលត្រូវការការតភ្ជាប់អ៊ីនធឺណិត។ សូមពិនិត្យការតភ្ជាប់របស់អ្នក រួចព្យាយាមម្តងទៀត។', 'ព្យាយាមម្តងទៀត'],
    fil: ['Offline ka', 'Kailangan ng portal ng koneksyon sa internet. Suriin ang iyong koneksyon, saka subukang muli.', 'Subukang muli']
  };
  var lang = get('reimb.lang') || (navigator.language || 'en').toLowerCase().split('-')[0];
  if (lang === 'tl') lang = 'fil';
  var s = STR[lang];
  if (!s) return;
  document.documentElement.lang = lang;
  document.getElementById('offTitle').textContent = s[0];
  document.getElementById('offText').textContent = s[1];
  document.getElementById('offRetry').textContent = s[2];
})();
