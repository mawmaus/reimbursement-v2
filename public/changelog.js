'use strict';

// ---------------------------------------------------------------------------
// "What's new" — the release notes behind the top-bar ✦ button.
//
// Newest release first. Every item's `text` MUST carry all six UI languages
// (en, id, th, vi, km, fil): `node scripts/check-changelog.js` fails on a
// missing or empty one, so run it before every deploy that adds an entry. At
// runtime a missing language falls back to English rather than showing blank.
//
// `id` identifies the release for the unread dot: bump it (a new entry at the
// top) and everyone who hasn't opened the notes since sees the dot again.
// `kind` is one of 'new' | 'improved' | 'fixed' (labels translated in i18n.js).
// ---------------------------------------------------------------------------
window.CHANGELOG = [
  {
    id: '2026-10-01',
    date: '2026-10-01',
    items: [
      { kind: 'new', text: {
        en: 'A "What\'s new" button in the top bar. Open it any time to see what changed in the portal. A dot appears on it when there is something you haven\'t read yet.',
        id: 'Tombol "Yang baru" di bilah atas. Buka kapan saja untuk melihat apa yang berubah di portal. Sebuah titik muncul di tombol ini bila ada pembaruan yang belum Anda baca.',
        th: 'ปุ่ม "มีอะไรใหม่" ที่แถบด้านบน เปิดได้ทุกเมื่อเพื่อดูว่ามีอะไรเปลี่ยนแปลงในพอร์ทัล จะมีจุดแสดงบนปุ่มเมื่อมีรายการที่คุณยังไม่ได้อ่าน',
        vi: 'Nút "Có gì mới" trên thanh trên cùng. Mở bất cứ lúc nào để xem cổng thông tin đã thay đổi những gì. Một dấu chấm sẽ hiện trên nút khi có nội dung bạn chưa đọc.',
        km: 'ប៊ូតុង "មានអ្វីថ្មី" នៅលើរបារខាងលើ។ បើកវាបានគ្រប់ពេល ដើម្បីមើលអ្វីដែលបានផ្លាស់ប្ដូរនៅក្នុងវិបផតថល។ ចំណុចមួយនឹងបង្ហាញលើប៊ូតុង នៅពេលមានព័ត៌មានដែលអ្នកមិនទាន់បានអាន។',
        fil: 'Isang "Ano ang bago" na button sa itaas na bar. Buksan ito anumang oras para makita kung ano ang nagbago sa portal. May lalabas na tuldok dito kapag may hindi ka pa nababasa.'
      } }
    ]
  },
  {
    id: '2026-09-28',
    date: '2026-09-28',
    items: [
      { kind: 'new', text: {
        en: 'Night mode. Tap the moon icon in the top bar or on the sign-in screen. Until you choose, the portal follows your device\'s light or dark setting.',
        id: 'Mode malam. Ketuk ikon bulan di bilah atas atau di layar masuk. Sebelum Anda memilih, portal mengikuti pengaturan terang atau gelap perangkat Anda.',
        th: 'โหมดกลางคืน แตะไอคอนพระจันทร์ที่แถบด้านบนหรือที่หน้าจอเข้าสู่ระบบ หากคุณยังไม่ได้เลือก พอร์ทัลจะใช้การตั้งค่าสว่างหรือมืดตามอุปกรณ์ของคุณ',
        vi: 'Chế độ ban đêm. Chạm vào biểu tượng mặt trăng trên thanh trên cùng hoặc ở màn hình đăng nhập. Cho đến khi bạn chọn, cổng thông tin sẽ theo cài đặt sáng hoặc tối của thiết bị.',
        km: 'របៀបពេលយប់។ ចុចរូបព្រះច័ន្ទនៅលើរបារខាងលើ ឬនៅលើអេក្រង់ចូល។ មុនពេលអ្នកជ្រើសរើស វិបផតថលនឹងធ្វើតាមការកំណត់ភ្លឺ ឬងងឹតរបស់ឧបករណ៍អ្នក។',
        fil: 'Night mode. I-tap ang icon ng buwan sa itaas na bar o sa sign-in screen. Hangga\'t hindi ka pumipili, susundin ng portal ang light o dark setting ng iyong device.'
      } },
      { kind: 'improved', text: {
        en: 'Clearer colours and easier-to-read text and buttons in both the light and dark themes, using the Cibes palette.',
        id: 'Warna lebih jelas serta teks dan tombol yang lebih mudah dibaca di tema terang maupun gelap, dengan palet Cibes.',
        th: 'สีที่ชัดเจนขึ้น ข้อความและปุ่มอ่านง่ายขึ้นทั้งในธีมสว่างและธีมมืด โดยใช้ชุดสีของ Cibes',
        vi: 'Màu sắc rõ ràng hơn, chữ và nút dễ đọc hơn ở cả giao diện sáng và tối, theo bảng màu Cibes.',
        km: 'ពណ៌កាន់តែច្បាស់ អក្សរ និងប៊ូតុងងាយអានជាងមុន ទាំងក្នុងរចនាប័ទ្មភ្លឺ និងងងឹត ដោយប្រើពណ៌របស់ Cibes។',
        fil: 'Mas malinaw na kulay at mas madaling basahin na teksto at mga button sa light at dark theme, gamit ang palette ng Cibes.'
      } }
    ]
  },
  {
    id: '2026-09-23',
    date: '2026-09-23',
    items: [
      { kind: 'new', text: {
        en: 'The Paid claims list shows when each claim was paid, and you can filter it by payment date.',
        id: 'Daftar klaim Dibayar menampilkan kapan setiap klaim dibayar, dan Anda dapat memfilternya berdasarkan tanggal bayar.',
        th: 'รายการเบิกที่จ่ายแล้วจะแสดงวันที่จ่ายของแต่ละรายการ และคุณสามารถกรองตามวันที่จ่ายได้',
        vi: 'Danh sách yêu cầu Đã thanh toán hiển thị ngày thanh toán của từng yêu cầu, và bạn có thể lọc theo ngày thanh toán.',
        km: 'បញ្ជីសំណើដែលបានបង់ បង្ហាញថ្ងៃដែលសំណើនីមួយៗត្រូវបានបង់ ហើយអ្នកអាចតម្រងតាមថ្ងៃបង់បាន។',
        fil: 'Ipinapakita ng listahan ng mga bayad na claim kung kailan binayaran ang bawat isa, at maaari mo itong i-filter ayon sa petsa ng bayad.'
      } },
      { kind: 'improved', text: {
        en: 'Export CSV now includes the payment date.',
        id: 'Ekspor CSV kini menyertakan tanggal bayar.',
        th: 'การส่งออก CSV มีวันที่จ่ายแล้ว',
        vi: 'Xuất CSV giờ có thêm ngày thanh toán.',
        km: 'ការនាំចេញ CSV ឥឡូវនេះមានថ្ងៃបង់ផងដែរ។',
        fil: 'Kasama na ngayon sa Export CSV ang petsa ng bayad.'
      } },
      { kind: 'fixed', text: {
        en: 'Large totals no longer spill out of their summary card.',
        id: 'Total yang besar tidak lagi keluar dari kartu ringkasannya.',
        th: 'ยอดรวมจำนวนมากจะไม่ล้นออกนอกการ์ดสรุปอีกต่อไป',
        vi: 'Tổng tiền lớn không còn tràn ra ngoài thẻ tóm tắt.',
        km: 'ចំនួនសរុបធំៗ លែងហៀរចេញក្រៅកាតសង្ខេបទៀតហើយ។',
        fil: 'Hindi na lumalampas sa summary card ang malalaking kabuuan.'
      } }
    ]
  },
  {
    id: '2026-09-22',
    date: '2026-09-22',
    items: [
      { kind: 'new', text: {
        en: 'A cash advance request can carry supporting documents. They are always saved as PDF.',
        id: 'Permintaan uang muka dapat menyertakan dokumen pendukung. Dokumen selalu disimpan sebagai PDF.',
        th: 'คำขอเงินทดรองจ่ายสามารถแนบเอกสารประกอบได้ และจะบันทึกเป็น PDF เสมอ',
        vi: 'Yêu cầu tạm ứng có thể đính kèm tài liệu hỗ trợ. Tài liệu luôn được lưu dưới dạng PDF.',
        km: 'សំណើប្រាក់បុរេប្រទានអាចភ្ជាប់ឯកសារគាំទ្របាន។ ឯកសារទាំងនោះតែងតែរក្សាទុកជា PDF។',
        fil: 'Maaari nang maglakip ng mga sumusuportang dokumento sa isang cash advance request. Palagi itong sine-save bilang PDF.'
      } },
      { kind: 'improved', text: {
        en: 'While you have a cash advance that is not yet realized, New claim and New meal allowance are on hold. The home page tells you why.',
        id: 'Selama Anda memiliki uang muka yang belum direalisasikan, Klaim baru dan Tunjangan makan baru ditahan. Halaman utama menjelaskan alasannya.',
        th: 'ระหว่างที่คุณมีเงินทดรองจ่ายที่ยังไม่ได้เคลียร์ การเบิกใหม่และการเบิกค่าอาหารใหม่จะถูกระงับไว้ หน้าแรกจะแจ้งเหตุผลให้ทราบ',
        vi: 'Khi bạn còn khoản tạm ứng chưa quyết toán, Yêu cầu mới và Phụ cấp ăn mới sẽ tạm dừng. Trang chủ sẽ cho bạn biết lý do.',
        km: 'នៅពេលអ្នកមានប្រាក់បុរេប្រទានដែលមិនទាន់ទូទាត់ សំណើថ្មី និងប្រាក់ឧបត្ថម្ភអាហារថ្មី នឹងត្រូវផ្អាក។ ទំព័រដើមនឹងប្រាប់អ្នកពីមូលហេតុ។',
        fil: 'Habang may cash advance kang hindi pa nare-realize, naka-hold ang Bagong claim at Bagong meal allowance. Sasabihin sa iyo ng home page kung bakit.'
      } },
      { kind: 'improved', text: {
        en: 'Receipt photos: the portal finds the receipt\'s edges, straightens the angle, and cleans up the image for you.',
        id: 'Foto bukti: portal menemukan tepi bukti, meluruskan sudutnya, dan merapikan gambarnya untuk Anda.',
        th: 'รูปใบเสร็จ: พอร์ทัลจะหาขอบของใบเสร็จ ปรับมุมให้ตรง และทำให้ภาพสะอาดขึ้นให้คุณ',
        vi: 'Ảnh hóa đơn: cổng thông tin tự tìm mép hóa đơn, chỉnh thẳng góc và làm rõ ảnh cho bạn.',
        km: 'រូបថតវិក្កយបត្រ៖ វិបផតថលរកគែមវិក្កយបត្រ តម្រង់មុំ និងសម្អាតរូបភាពឱ្យអ្នក។',
        fil: 'Mga larawan ng resibo: hinahanap ng portal ang mga gilid ng resibo, itinutuwid ang anggulo, at nililinis ang larawan para sa iyo.'
      } }
    ]
  },
  {
    id: '2026-09-16',
    date: '2026-09-16',
    items: [
      { kind: 'improved', text: {
        en: 'Mark as paid and Revert payment work on several selected claims in one go.',
        id: 'Tandai dibayar dan Batalkan pembayaran dapat dilakukan untuk beberapa klaim terpilih sekaligus.',
        th: 'ทำเครื่องหมายว่าจ่ายแล้วและย้อนการจ่ายเงินได้กับหลายรายการที่เลือกในครั้งเดียว',
        vi: 'Đánh dấu đã thanh toán và Hoàn tác thanh toán áp dụng cho nhiều yêu cầu đã chọn cùng lúc.',
        km: 'សម្គាល់ថាបានបង់ និងត្រឡប់ការបង់ប្រាក់ អាចធ្វើលើសំណើជាច្រើនដែលបានជ្រើសរើសក្នុងពេលតែមួយ។',
        fil: 'Gumagana na ang Markahang bayad na at I-revert ang bayad sa ilang napiling claim nang sabay-sabay.'
      } },
      { kind: 'improved', text: {
        en: 'View all claims can open receipts and download PDFs for a whole selection.',
        id: 'Lihat semua klaim dapat membuka bukti dan mengunduh PDF untuk seluruh pilihan.',
        th: 'ดูรายการเบิกทั้งหมดสามารถเปิดใบเสร็จและดาวน์โหลด PDF ของรายการที่เลือกทั้งหมดได้',
        vi: 'Xem tất cả yêu cầu có thể mở hóa đơn và tải PDF cho cả nhóm đã chọn.',
        km: 'មើលសំណើទាំងអស់ អាចបើកវិក្កយបត្រ និងទាញយក PDF សម្រាប់ការជ្រើសរើសទាំងមូល។',
        fil: 'Kayang buksan ng Tingnan ang lahat ng claim ang mga resibo at i-download ang PDF ng buong napili.'
      } }
    ]
  },
  {
    id: '2026-09-10',
    date: '2026-09-10',
    items: [
      { kind: 'new', text: {
        en: 'Request change of date: if a returned claim\'s dates are locked, ask from the home menu for them to be unlocked.',
        id: 'Minta perubahan tanggal: bila tanggal klaim yang dikembalikan terkunci, ajukan permintaan dari menu utama agar dibuka.',
        th: 'ขอเปลี่ยนวันที่: หากวันที่ของรายการเบิกที่ถูกส่งกลับถูกล็อก สามารถขอปลดล็อกได้จากเมนูหน้าแรก',
        vi: 'Xin đổi ngày: nếu ngày của yêu cầu bị trả lại đã bị khóa, hãy gửi yêu cầu mở khóa từ menu trang chủ.',
        km: 'ស្នើសុំប្ដូរកាលបរិច្ឆេទ៖ ប្រសិនបើកាលបរិច្ឆេទនៃសំណើដែលត្រូវបានបញ្ជូនត្រឡប់ត្រូវបានចាក់សោ សូមស្នើសុំដោះសោពីម៉ឺនុយទំព័រដើម។',
        fil: 'Humiling na palitan ang petsa: kung naka-lock ang mga petsa ng ibinalik na claim, humiling mula sa home menu na i-unlock ang mga ito.'
      } },
      { kind: 'improved', text: {
        en: 'A rejected claim keeps its original dates when you resubmit it, even if the claim window has since closed.',
        id: 'Klaim yang ditolak tetap memakai tanggal aslinya saat dikirim ulang, meskipun periode klaim sudah ditutup.',
        th: 'รายการเบิกที่ถูกปฏิเสธจะคงวันที่เดิมไว้เมื่อส่งใหม่ แม้ช่วงเวลาการเบิกจะปิดไปแล้วก็ตาม',
        vi: 'Yêu cầu bị từ chối giữ nguyên ngày ban đầu khi bạn gửi lại, kể cả khi thời hạn yêu cầu đã đóng.',
        km: 'សំណើដែលត្រូវបានបដិសេធ រក្សាកាលបរិច្ឆេទដើមរបស់វា នៅពេលអ្នកដាក់ស្នើម្ដងទៀត ទោះបីរយៈពេលដាក់សំណើបានបិទហើយក៏ដោយ។',
        fil: 'Pinapanatili ng tinanggihang claim ang orihinal nitong mga petsa kapag isinumite mo ulit, kahit sarado na ang claim window.'
      } },
      { kind: 'fixed', text: {
        en: 'Expense dates in the future are no longer accepted.',
        id: 'Tanggal pengeluaran di masa depan tidak lagi diterima.',
        th: 'ไม่รับวันที่ค่าใช้จ่ายที่เป็นวันในอนาคตอีกต่อไป',
        vi: 'Không còn chấp nhận ngày chi tiêu trong tương lai.',
        km: 'កាលបរិច្ឆេទចំណាយនៅថ្ងៃអនាគត លែងត្រូវបានទទួលយកទៀតហើយ។',
        fil: 'Hindi na tinatanggap ang mga petsa ng gastos na nasa hinaharap.'
      } }
    ]
  },
  {
    id: '2026-08-24',
    date: '2026-08-24',
    items: [
      { kind: 'improved', text: {
        en: 'Pending review is split into Manager and FinanceAP, so you can see where each claim is waiting. This shows in the lists, the summary cards, the status filter and the CSV export.',
        id: 'Menunggu tinjauan dibagi menjadi Manager dan FinanceAP, sehingga Anda dapat melihat di mana setiap klaim menunggu. Ini tampil di daftar, kartu ringkasan, filter status, dan ekspor CSV.',
        th: 'สถานะรอตรวจสอบแยกเป็น Manager และ FinanceAP เพื่อให้เห็นว่าแต่ละรายการรออยู่ที่ใด แสดงในรายการ การ์ดสรุป ตัวกรองสถานะ และการส่งออก CSV',
        vi: 'Trạng thái chờ duyệt được tách thành Manager và FinanceAP, để bạn thấy mỗi yêu cầu đang chờ ở đâu. Áp dụng cho danh sách, thẻ tóm tắt, bộ lọc trạng thái và xuất CSV.',
        km: 'ស្ថានភាពរង់ចាំពិនិត្យ ត្រូវបានបំបែកជា Manager និង FinanceAP ដើម្បីឱ្យអ្នកឃើញថាសំណើនីមួយៗកំពុងរង់ចាំនៅឯណា។ បង្ហាញក្នុងបញ្ជី កាតសង្ខេប តម្រងស្ថានភាព និងការនាំចេញ CSV។',
        fil: 'Hinati ang Pending review sa Manager at FinanceAP, para makita mo kung saan naghihintay ang bawat claim. Makikita ito sa mga listahan, summary card, status filter at CSV export.'
      } }
    ]
  },
  {
    id: '2026-08-17',
    date: '2026-08-17',
    items: [
      { kind: 'new', text: {
        en: 'A photo editor for receipts: crop, rotate with a dial, and add a capture stamp before you attach the photo.',
        id: 'Editor foto untuk bukti: potong, putar dengan tombol putar, dan tambahkan cap waktu pengambilan sebelum melampirkan foto.',
        th: 'ตัวแก้ไขรูปใบเสร็จ: ครอบตัด หมุนด้วยแป้นหมุน และเพิ่มตราเวลาที่ถ่ายก่อนแนบรูป',
        vi: 'Trình chỉnh ảnh hóa đơn: cắt, xoay bằng vòng xoay và thêm dấu thời gian chụp trước khi đính kèm ảnh.',
        km: 'កម្មវិធីកែរូបថតវិក្កយបត្រ៖ កាត់ បង្វិលដោយប្រើឌីស និងបន្ថែមត្រាពេលថត មុនពេលភ្ជាប់រូបថត។',
        fil: 'Photo editor para sa mga resibo: i-crop, i-rotate gamit ang dial, at magdagdag ng capture stamp bago ilakip ang larawan.'
      } },
      { kind: 'improved', text: {
        en: 'A saved claim draft keeps its receipts too, so they are still there when you come back.',
        id: 'Draf klaim yang tersimpan juga menyimpan buktinya, jadi masih ada saat Anda kembali.',
        th: 'ฉบับร่างรายการเบิกที่บันทึกไว้จะเก็บใบเสร็จไว้ด้วย จึงยังอยู่ครบเมื่อคุณกลับมา',
        vi: 'Bản nháp yêu cầu đã lưu cũng giữ lại hóa đơn, nên chúng vẫn còn khi bạn quay lại.',
        km: 'សេចក្ដីព្រាងសំណើដែលបានរក្សាទុក ក៏រក្សាវិក្កយបត្ររបស់វាដែរ ដូច្នេះវានៅតែមាននៅពេលអ្នកត្រឡប់មកវិញ។',
        fil: 'Pinapanatili rin ng naka-save na draft ng claim ang mga resibo nito, kaya nandoon pa rin ang mga ito pagbalik mo.'
      } },
      { kind: 'fixed', text: {
        en: 'The crop box can be dragged from every side on phones and tablets.',
        id: 'Kotak potong dapat diseret dari setiap sisi di ponsel dan tablet.',
        th: 'ลากกรอบครอบตัดได้จากทุกด้านบนโทรศัพท์และแท็บเล็ต',
        vi: 'Khung cắt có thể kéo từ mọi cạnh trên điện thoại và máy tính bảng.',
        km: 'ប្រអប់កាត់អាចអូសពីគ្រប់ជ្រុងបាន នៅលើទូរស័ព្ទ និងថេប្លេត។',
        fil: 'Maaaring i-drag ang crop box mula sa bawat gilid sa mga phone at tablet.'
      } }
    ]
  }
];
