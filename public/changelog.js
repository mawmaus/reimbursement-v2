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
//
// `audience` (optional) limits an item to the accounts it concerns: it shows
// when the account matches ANY listed key. Leave it off only for changes that
// reach everyone. Super Admins see every item. A release none of whose items
// match is hidden whole, and never lights the dot. Keys (app.js NOTE_AUDIENCE):
//   claim / meal / advance  may raise that purpose (New claim / meal / advance)
//   pay                     may mark claims paid (Finance AP)
//   export                  may export CSV
//   view_all                may open "View all claims"
//   accounts                may manage accounts
//   settings                may open Settings
//   superadmin              Super Admins only
// ---------------------------------------------------------------------------
window.CHANGELOG_AUDIENCES = ['claim', 'meal', 'advance', 'pay', 'export', 'view_all', 'accounts', 'settings', 'superadmin'];
window.CHANGELOG = [
  {
    id: '2026-10-02.2',
    date: '2026-10-02',
    items: [
      { kind: 'improved', text: {
        en: 'The portal now opens, and loads claim lists and details, noticeably faster.',
        id: 'Portal kini terbuka, serta memuat daftar dan detail klaim, jauh lebih cepat.',
        th: 'พอร์ทัลเปิดได้เร็วขึ้น และโหลดรายการและรายละเอียดคำขอเบิกได้เร็วขึ้นอย่างเห็นได้ชัด',
        vi: 'Cổng thông tin giờ mở nhanh hơn, và tải danh sách cũng như chi tiết yêu cầu nhanh hơn rõ rệt.',
        km: 'ផតថលឥឡូវបើកបានលឿនជាងមុន ហើយផ្ទុកបញ្ជី និងព័ត៌មានលម្អិតនៃសំណើបានលឿនជាងមុនគួរឱ្យកត់សម្គាល់។',
        fil: 'Mas mabilis na ngayong magbukas ang portal, at mag-load ng mga listahan at detalye ng claim.'
      } }
    ]
  },
  {
    id: '2026-10-02.1',
    date: '2026-10-02',
    items: [
      { kind: 'improved', audience: ['advance', 'pay'], text: {
        en: 'A cash advance that was not fully spent now stays open until Finance confirms the unused balance was returned. Until then it shows as "Awaiting refund" under Unrealized cash advances, and new claims stay on hold. Finance closes it with the new "Confirm refund received" button.',
        id: 'Uang muka yang tidak terpakai seluruhnya kini tetap terbuka sampai Finance mengonfirmasi sisa dana sudah dikembalikan. Sampai saat itu statusnya "Menunggu pengembalian dana" di Uang muka belum direalisasi, dan klaim baru tetap ditahan. Finance menutupnya dengan tombol baru "Konfirmasi pengembalian diterima".',
        th: 'เงินทดรองที่ใช้ไม่หมดจะยังเปิดอยู่จนกว่าฝ่ายการเงินจะยืนยันว่าได้รับเงินส่วนที่เหลือคืนแล้ว ระหว่างนั้นจะแสดงเป็น "รอคืนเงิน" ในเงินทดรองที่ยังไม่เคลียร์ และคำขอเบิกใหม่จะยังถูกระงับ ฝ่ายการเงินปิดรายการได้ด้วยปุ่มใหม่ "ยืนยันว่าได้รับเงินคืนแล้ว"',
        vi: 'Khoản tạm ứng chưa dùng hết giờ vẫn mở cho đến khi Tài chính xác nhận số dư chưa dùng đã được hoàn trả. Trong thời gian đó, khoản này hiển thị là "Chờ hoàn trả" trong mục tạm ứng chưa quyết toán, và yêu cầu mới vẫn bị tạm giữ. Tài chính đóng khoản này bằng nút mới "Xác nhận đã nhận hoàn trả".',
        km: 'ប្រាក់បុរេប្រទានដែលមិនបានចំណាយអស់ ឥឡូវនៅតែបើករហូតដល់ផ្នែកហិរញ្ញវត្ថុបញ្ជាក់ថាសមតុល្យដែលមិនបានប្រើត្រូវបានសងវិញ។ រហូតដល់ពេលនោះ វាបង្ហាញជា "កំពុងរង់ចាំការសងប្រាក់វិញ" ក្នុងប្រាក់បុរេប្រទានមិនទាន់ទូទាត់ ហើយសំណើថ្មីនៅតែត្រូវបានផ្អាក។ ផ្នែកហិរញ្ញវត្ថុបិទវាដោយប៊ូតុងថ្មី "បញ្ជាក់ថាបានទទួលប្រាក់សងវិញ"។',
        fil: 'Ang cash advance na hindi naubos ay mananatiling bukas hanggang kumpirmahin ng Finance na naibalik ang hindi nagamit na balanse. Hanggang doon, "Naghihintay ng refund" ang status nito sa Unrealized cash advances, at naka-hold pa rin ang mga bagong claim. Isinasara ito ng Finance gamit ang bagong button na "Kumpirmahing natanggap ang refund".'
      } }
    ]
  },
  {
    id: '2026-10-01.6',
    date: '2026-10-01',
    items: [
      { kind: 'improved', text: {
        en: 'The lines of a claim now fit the claim window without scrolling sideways, so the "Reject line" button is always in view. On phones, each line is a shorter card that shows two details side by side.',
        id: 'Baris-baris klaim kini muat di jendela klaim tanpa perlu menggeser ke samping, jadi tombol "Tolak baris" selalu terlihat. Di ponsel, setiap baris menjadi kartu yang lebih pendek dengan dua keterangan berdampingan.',
        th: 'รายการในคำขอเบิกตอนนี้พอดีกับหน้าต่างคำขอโดยไม่ต้องเลื่อนไปด้านข้าง ปุ่ม "ปฏิเสธรายการ" จึงมองเห็นได้เสมอ บนโทรศัพท์ แต่ละรายการเป็นการ์ดที่สั้นลงและแสดงข้อมูลสองอย่างเคียงกัน',
        vi: 'Các dòng của yêu cầu giờ vừa với cửa sổ yêu cầu mà không cần cuộn ngang, nên nút "Từ chối dòng" luôn hiển thị. Trên điện thoại, mỗi dòng là một thẻ ngắn hơn, hiển thị hai thông tin cạnh nhau.',
        km: 'ជួរនៃការទាមទារឥឡូវសមនឹងផ្ទាំងការទាមទារដោយមិនចាំបាច់រំកិលទៅចំហៀង ដូច្នេះប៊ូតុង "បដិសេធជួរ" តែងតែមើលឃើញ។ នៅលើទូរសព្ទ ជួរនីមួយៗជាកាតខ្លីជាងមុន ដែលបង្ហាញព័ត៌មានពីរនៅក្បែរគ្នា។',
        fil: 'Kasya na ngayon ang mga linya ng claim sa window nang hindi na kailangang mag-scroll patagilid, kaya laging nakikita ang button na "Tanggihan ang linya". Sa phone, mas maikling card na ang bawat linya at magkatabi ang dalawang detalye.'
      } }
    ]
  },
  {
    id: '2026-10-01.5',
    date: '2026-10-01',
    items: [
      { kind: 'new', text: {
        en: 'Approvers can now reject single lines of a claim. Press "Reject line" on any line and give a reason. The rest of the claim is approved and paid without that line. This works for reimbursement claims, meal allowances and cash advance realizations.',
        id: 'Penyetuju kini bisa menolak baris tertentu dari sebuah klaim. Tekan "Tolak baris" pada baris mana pun dan beri alasan. Sisa klaim disetujui dan dibayar tanpa baris itu. Ini berlaku untuk klaim penggantian, uang makan, dan realisasi uang muka.',
        th: 'ผู้อนุมัติสามารถปฏิเสธบางรายการในคำขอเบิกได้แล้ว กด "ปฏิเสธรายการ" ที่รายการใดก็ได้และระบุเหตุผล ส่วนที่เหลือของคำขอจะได้รับอนุมัติและจ่ายโดยไม่มีรายการนั้น ใช้ได้กับการเบิกค่าใช้จ่าย ค่าอาหาร และการเคลียร์เงินทดรอง',
        vi: 'Người duyệt giờ có thể từ chối từng dòng của một yêu cầu. Nhấn "Từ chối dòng" trên bất kỳ dòng nào và nêu lý do. Phần còn lại của yêu cầu được duyệt và thanh toán mà không có dòng đó. Áp dụng cho yêu cầu hoàn tiền, phụ cấp ăn và quyết toán tạm ứng.',
        km: 'អ្នកអនុម័តឥឡូវអាចបដិសេធជួរនីមួយៗនៃការទាមទារបាន។ ចុច "បដិសេធជួរ" លើជួរណាមួយ ហើយផ្ដល់មូលហេតុ។ ផ្នែកដែលនៅសល់នៃការទាមទារត្រូវបានអនុម័ត និងបង់ដោយគ្មានជួរនោះ។ វាដំណើរការសម្រាប់ការទាមទារសំណង ប្រាក់អាហារ និងការទូទាត់ប្រាក់បុរេប្រទាន។',
        fil: 'Puwede na ngayong tanggihan ng mga approver ang isang linya lang ng claim. Pindutin ang "Tanggihan ang linya" sa kahit anong linya at magbigay ng dahilan. Maaaprubahan at mababayaran ang natitirang claim nang wala ang linyang iyon. Gumagana ito sa reimbursement claim, meal allowance at realization ng cash advance.'
      } },
      { kind: 'new', audience: ['claim', 'meal', 'advance'], text: {
        en: 'If a line of your claim is rejected, it stays on the claim with the reason, so you can always see what happened. To get paid for it, open the claim and press "Re-claim rejected lines". If several lines were rejected, tick the ones you want. They open in a new claim, receipts included, ready to fix and submit. The new claim follows the date window of the original claim.',
        id: 'Jika sebuah baris klaim Anda ditolak, baris itu tetap ada di klaim beserta alasannya, jadi Anda selalu bisa melihat apa yang terjadi. Agar dibayar, buka klaim dan tekan "Klaim ulang baris yang ditolak". Jika ada beberapa baris yang ditolak, centang yang Anda inginkan. Baris-baris itu terbuka di klaim baru, lengkap dengan struknya, siap diperbaiki dan diajukan. Klaim baru mengikuti batas tanggal klaim aslinya.',
        th: 'หากรายการใดในคำขอของคุณถูกปฏิเสธ รายการนั้นจะยังอยู่ในคำขอพร้อมเหตุผล คุณจึงเห็นได้เสมอว่าเกิดอะไรขึ้น หากต้องการรับเงิน ให้เปิดคำขอแล้วกด "เบิกรายการที่ถูกปฏิเสธใหม่" หากถูกปฏิเสธหลายรายการ ให้เลือกรายการที่ต้องการ รายการเหล่านั้นจะเปิดในคำขอใหม่พร้อมใบเสร็จ พร้อมให้แก้ไขและส่ง คำขอใหม่ใช้ช่วงวันที่เดียวกับคำขอเดิม',
        vi: 'Nếu một dòng trong yêu cầu của bạn bị từ chối, dòng đó vẫn nằm trong yêu cầu kèm lý do, nên bạn luôn biết chuyện gì đã xảy ra. Để được thanh toán, hãy mở yêu cầu và nhấn "Yêu cầu lại các dòng bị từ chối". Nếu có nhiều dòng bị từ chối, hãy chọn những dòng bạn muốn. Chúng mở ra trong một yêu cầu mới, kèm cả hóa đơn, sẵn sàng để sửa và gửi. Yêu cầu mới theo khoảng thời gian của yêu cầu gốc.',
        km: 'ប្រសិនបើជួរណាមួយនៃការទាមទាររបស់អ្នកត្រូវបានបដិសេធ វានៅតែស្ថិតលើការទាមទារជាមួយមូលហេតុ ដូច្នេះអ្នកតែងតែអាចមើលឃើញអ្វីដែលបានកើតឡើង។ ដើម្បីទទួលបានការបង់ប្រាក់ សូមបើកការទាមទារ ហើយចុច "ទាមទារឡើងវិញនូវជួរដែលបានបដិសេធ"។ ប្រសិនបើមានជួរជាច្រើនត្រូវបានបដិសេធ សូមជ្រើសរើសជួរដែលអ្នកចង់បាន។ ពួកវាបើកក្នុងការទាមទារថ្មី រួមទាំងបង្កាន់ដៃ ត្រៀមរួចសម្រាប់កែ និងដាក់ស្នើ។ ការទាមទារថ្មីអនុវត្តតាមចន្លោះកាលបរិច្ឆេទនៃការទាមទារដើម។',
        fil: 'Kapag tinanggihan ang isang linya ng claim mo, mananatili ito sa claim kasama ang dahilan, kaya laging makikita mo ang nangyari. Para mabayaran ito, buksan ang claim at pindutin ang "I-claim muli ang mga tinanggihang linya". Kung ilang linya ang tinanggihan, piliin ang mga gusto mo. Bubukas ang mga ito sa bagong claim, kasama ang mga resibo, handang ayusin at isumite. Susundin ng bagong claim ang palugit ng petsa ng orihinal na claim.'
      } }
    ]
  },
  {
    id: '2026-10-01.4',
    date: '2026-10-01',
    items: [
      { kind: 'improved', text: {
        en: 'On phones, the top bar is now arranged in neat rows: your name and quick settings at the top, the region and language pickers below, then "+ New" and the other buttons.',
        id: 'Di ponsel, bilah atas kini tersusun dalam baris yang rapi: nama Anda dan pengaturan cepat di atas, pilihan wilayah dan bahasa di bawahnya, lalu "+ Baru" dan tombol lainnya.',
        th: 'บนโทรศัพท์ แถบด้านบนจัดเป็นแถวอย่างเป็นระเบียบแล้ว: ชื่อของคุณและการตั้งค่าด่วนอยู่ด้านบน ตัวเลือกภูมิภาคและภาษาอยู่ถัดลงมา แล้วจึงเป็นปุ่ม "+ ใหม่" และปุ่มอื่น ๆ',
        vi: 'Trên điện thoại, thanh trên cùng giờ được sắp thành các hàng gọn gàng: tên bạn và cài đặt nhanh ở trên cùng, bộ chọn khu vực và ngôn ngữ ở dưới, rồi đến "+ Mới" và các nút khác.',
        km: 'នៅលើទូរស័ព្ទ របារខាងលើឥឡូវត្រូវបានរៀបជាជួរយ៉ាងស្អាត៖ ឈ្មោះរបស់អ្នក និងការកំណត់រហ័សនៅខាងលើ ជម្រើសតំបន់ និងភាសានៅខាងក្រោម បន្ទាប់មក "+ ថ្មី" និងប៊ូតុងផ្សេងទៀត។',
        fil: 'Sa telepono, nakaayos na ngayon sa malilinis na hanay ang itaas na bar: ang pangalan mo at mabilis na settings sa itaas, ang pagpili ng rehiyon at wika sa ilalim nito, at saka ang "+ Bago" at iba pang button.'
      } },
      { kind: 'improved', text: {
        en: 'Sign out now opens a small window in the middle of the screen asking you to confirm, so a mistaken tap no longer logs you out.',
        id: 'Keluar kini membuka jendela kecil di tengah layar untuk meminta konfirmasi, jadi ketukan yang tidak sengaja tidak lagi membuat Anda keluar.',
        th: 'การออกจากระบบจะเปิดหน้าต่างเล็ก ๆ กลางหน้าจอเพื่อถามยืนยันก่อน การแตะพลาดจึงไม่ทำให้คุณออกจากระบบอีกต่อไป',
        vi: 'Đăng xuất giờ sẽ mở một cửa sổ nhỏ ở giữa màn hình để hỏi xác nhận trước, nên lỡ chạm nhầm sẽ không làm bạn bị đăng xuất nữa.',
        km: 'ការចាកចេញឥឡូវបើកផ្ទាំងតូចមួយនៅកណ្តាលអេក្រង់ ដើម្បីសួរឱ្យអ្នកបញ្ជាក់ជាមុនសិន ដូច្នេះការចុចខុសនឹងមិនធ្វើឱ្យអ្នកចាកចេញទៀតទេ។',
        fil: 'Magbubukas na ngayon ang Sign out ng maliit na window sa gitna ng screen para magtanong muna bago ka i-log out, kaya hindi ka na mala-log out dahil sa maling pindot.'
      } }
    ]
  },
  {
    id: '2026-10-01.3',
    date: '2026-10-01',
    items: [
      { kind: 'improved', text: {
        en: 'A tidier top bar. New claim, New meal allowance and New cash advance are now under one "+ New" button, and Export CSV, Profile, Manage accounts, Settings and Sign out are icons. Hover over an icon to see its name.',
        id: 'Bilah atas yang lebih rapi. Klaim baru, Uang makan baru, dan Uang muka baru kini ada di bawah satu tombol "+ Baru", sedangkan Ekspor CSV, Profil, Kelola akun, Pengaturan, dan Keluar menjadi ikon. Arahkan kursor ke ikon untuk melihat namanya.',
        th: 'แถบด้านบนที่เป็นระเบียบขึ้น การสร้างการเบิกใหม่ ค่าอาหารใหม่ และเงินทดรองใหม่ รวมอยู่ในปุ่ม "+ ใหม่" ปุ่มเดียว ส่วนส่งออก CSV โปรไฟล์ จัดการบัญชี การตั้งค่า และออกจากระบบ เปลี่ยนเป็นไอคอน วางเมาส์บนไอคอนเพื่อดูชื่อ',
        vi: 'Thanh trên cùng gọn gàng hơn. Yêu cầu mới, Phụ cấp ăn mới và Tạm ứng mới giờ nằm chung trong một nút "+ Mới", còn Xuất CSV, Hồ sơ, Quản lý tài khoản, Cài đặt và Đăng xuất trở thành biểu tượng. Di chuột lên biểu tượng để xem tên.',
        km: 'របារខាងលើកាន់តែស្អាត។ សំណើថ្មី ប្រាក់អាហារថ្មី និងប្រាក់បុរេប្រទានថ្មី ឥឡូវនៅក្រោមប៊ូតុង "+ ថ្មី" តែមួយ ហើយនាំចេញ CSV ប្រវត្តិរូប គ្រប់គ្រងគណនី ការកំណត់ និងចាកចេញ ក្លាយជារូបតំណាង។ ដាក់ទស្សន៍ទ្រនិចលើរូបតំណាង ដើម្បីមើលឈ្មោះ។',
        fil: 'Mas maayos na itaas na bar. Ang Bagong claim, Bagong meal allowance at Bagong cash advance ay nasa iisang "+ Bago" na button na, at ang Export CSV, Profile, Pamahalaan ang mga account, Settings at Sign out ay mga icon na. I-hover ang icon para makita ang pangalan nito.'
      } }
    ]
  },
  {
    id: '2026-10-01.2',
    date: '2026-10-01',
    items: [
      { kind: 'improved', audience: ['claim', 'meal', 'advance'], text: {
        en: 'Got a claim sent back to you? Now you can fix its dates yourself — no need to ask anyone. The rule is simple: if a date was allowed on the day you first sent the claim, it is still allowed now. If it was already too old back then, it can\'t be used.',
        id: 'Klaim Anda dikembalikan? Sekarang Anda bisa memperbaiki tanggalnya sendiri — tidak perlu minta izin siapa pun. Aturannya mudah: jika sebuah tanggal boleh dipakai pada hari Anda pertama kali mengirim klaim, tanggal itu tetap boleh dipakai sekarang. Jika saat itu tanggalnya sudah terlalu lama, tanggal itu tidak bisa dipakai.',
        th: 'รายการเบิกของคุณถูกส่งกลับมาใช่ไหม ตอนนี้คุณแก้วันที่เองได้เลย ไม่ต้องขอใคร กฎง่ายมาก: ถ้าวันที่นั้นใช้ได้ในวันที่คุณส่งรายการเบิกครั้งแรก ตอนนี้ก็ยังใช้ได้ แต่ถ้าตอนนั้นวันที่นั้นเก่าเกินไปแล้ว ก็จะใช้ไม่ได้',
        vi: 'Yêu cầu của bạn bị trả lại? Giờ bạn có thể tự sửa ngày — không cần xin ai cả. Quy tắc rất đơn giản: nếu một ngày được phép vào hôm bạn gửi yêu cầu lần đầu, thì bây giờ ngày đó vẫn được phép. Nếu khi đó ngày ấy đã quá cũ, thì không dùng được.',
        km: 'សំណើរបស់អ្នកត្រូវបានបញ្ជូនត្រឡប់មកវិញមែនទេ? ឥឡូវនេះ អ្នកអាចកែកាលបរិច្ឆេទដោយខ្លួនឯងបាន — មិនចាំបាច់សុំនរណាម្នាក់ទេ។ ច្បាប់គឺសាមញ្ញ៖ ប្រសិនបើកាលបរិច្ឆេទមួយត្រូវបានអនុញ្ញាតនៅថ្ងៃដែលអ្នកផ្ញើសំណើលើកដំបូង វានៅតែត្រូវបានអនុញ្ញាតឥឡូវនេះ។ ប្រសិនបើនៅពេលនោះវាចាស់ពេកហើយ វាមិនអាចប្រើបានទេ។',
        fil: 'Ibinalik ba sa iyo ang claim mo? Ikaw na mismo ang puwedeng mag-ayos ng mga petsa nito — hindi mo na kailangang humingi ng pahintulot. Simple lang ang patakaran: kung puwede ang isang petsa noong araw na una mong ipinadala ang claim, puwede pa rin ito ngayon. Kung masyado na itong luma noon pa, hindi na ito magagamit.'
      } }
    ]
  },
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
      { kind: 'new', audience: ['pay'], text: {
        en: 'The Paid claims list shows when each claim was paid, and you can filter it by payment date.',
        id: 'Daftar klaim Dibayar menampilkan kapan setiap klaim dibayar, dan Anda dapat memfilternya berdasarkan tanggal bayar.',
        th: 'รายการเบิกที่จ่ายแล้วจะแสดงวันที่จ่ายของแต่ละรายการ และคุณสามารถกรองตามวันที่จ่ายได้',
        vi: 'Danh sách yêu cầu Đã thanh toán hiển thị ngày thanh toán của từng yêu cầu, và bạn có thể lọc theo ngày thanh toán.',
        km: 'បញ្ជីសំណើដែលបានបង់ បង្ហាញថ្ងៃដែលសំណើនីមួយៗត្រូវបានបង់ ហើយអ្នកអាចតម្រងតាមថ្ងៃបង់បាន។',
        fil: 'Ipinapakita ng listahan ng mga bayad na claim kung kailan binayaran ang bawat isa, at maaari mo itong i-filter ayon sa petsa ng bayad.'
      } },
      { kind: 'improved', audience: ['export'], text: {
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
      { kind: 'new', audience: ['advance'], text: {
        en: 'A cash advance request can carry supporting documents. They are always saved as PDF.',
        id: 'Permintaan uang muka dapat menyertakan dokumen pendukung. Dokumen selalu disimpan sebagai PDF.',
        th: 'คำขอเงินทดรองจ่ายสามารถแนบเอกสารประกอบได้ และจะบันทึกเป็น PDF เสมอ',
        vi: 'Yêu cầu tạm ứng có thể đính kèm tài liệu hỗ trợ. Tài liệu luôn được lưu dưới dạng PDF.',
        km: 'សំណើប្រាក់បុរេប្រទានអាចភ្ជាប់ឯកសារគាំទ្របាន។ ឯកសារទាំងនោះតែងតែរក្សាទុកជា PDF។',
        fil: 'Maaari nang maglakip ng mga sumusuportang dokumento sa isang cash advance request. Palagi itong sine-save bilang PDF.'
      } },
      { kind: 'improved', audience: ['advance'], text: {
        en: 'While you have a cash advance that is not yet realized, New claim and New meal allowance are on hold. The home page tells you why.',
        id: 'Selama Anda memiliki uang muka yang belum direalisasikan, Klaim baru dan Tunjangan makan baru ditahan. Halaman utama menjelaskan alasannya.',
        th: 'ระหว่างที่คุณมีเงินทดรองจ่ายที่ยังไม่ได้เคลียร์ การเบิกใหม่และการเบิกค่าอาหารใหม่จะถูกระงับไว้ หน้าแรกจะแจ้งเหตุผลให้ทราบ',
        vi: 'Khi bạn còn khoản tạm ứng chưa quyết toán, Yêu cầu mới và Phụ cấp ăn mới sẽ tạm dừng. Trang chủ sẽ cho bạn biết lý do.',
        km: 'នៅពេលអ្នកមានប្រាក់បុរេប្រទានដែលមិនទាន់ទូទាត់ សំណើថ្មី និងប្រាក់ឧបត្ថម្ភអាហារថ្មី នឹងត្រូវផ្អាក។ ទំព័រដើមនឹងប្រាប់អ្នកពីមូលហេតុ។',
        fil: 'Habang may cash advance kang hindi pa nare-realize, naka-hold ang Bagong claim at Bagong meal allowance. Sasabihin sa iyo ng home page kung bakit.'
      } },
      { kind: 'improved', audience: ['claim'], text: {
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
      { kind: 'improved', audience: ['pay'], text: {
        en: 'Mark as paid and Revert payment work on several selected claims in one go.',
        id: 'Tandai dibayar dan Batalkan pembayaran dapat dilakukan untuk beberapa klaim terpilih sekaligus.',
        th: 'ทำเครื่องหมายว่าจ่ายแล้วและย้อนการจ่ายเงินได้กับหลายรายการที่เลือกในครั้งเดียว',
        vi: 'Đánh dấu đã thanh toán và Hoàn tác thanh toán áp dụng cho nhiều yêu cầu đã chọn cùng lúc.',
        km: 'សម្គាល់ថាបានបង់ និងត្រឡប់ការបង់ប្រាក់ អាចធ្វើលើសំណើជាច្រើនដែលបានជ្រើសរើសក្នុងពេលតែមួយ។',
        fil: 'Gumagana na ang Markahang bayad na at I-revert ang bayad sa ilang napiling claim nang sabay-sabay.'
      } },
      { kind: 'improved', audience: ['view_all'], text: {
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
      { kind: 'new', audience: ['superadmin'], text: {
        en: 'Request change of date: if a returned claim\'s dates are locked, ask from the home menu for them to be unlocked.',
        id: 'Minta perubahan tanggal: bila tanggal klaim yang dikembalikan terkunci, ajukan permintaan dari menu utama agar dibuka.',
        th: 'ขอเปลี่ยนวันที่: หากวันที่ของรายการเบิกที่ถูกส่งกลับถูกล็อก สามารถขอปลดล็อกได้จากเมนูหน้าแรก',
        vi: 'Xin đổi ngày: nếu ngày của yêu cầu bị trả lại đã bị khóa, hãy gửi yêu cầu mở khóa từ menu trang chủ.',
        km: 'ស្នើសុំប្ដូរកាលបរិច្ឆេទ៖ ប្រសិនបើកាលបរិច្ឆេទនៃសំណើដែលត្រូវបានបញ្ជូនត្រឡប់ត្រូវបានចាក់សោ សូមស្នើសុំដោះសោពីម៉ឺនុយទំព័រដើម។',
        fil: 'Humiling na palitan ang petsa: kung naka-lock ang mga petsa ng ibinalik na claim, humiling mula sa home menu na i-unlock ang mga ito.'
      } },
      { kind: 'improved', audience: ['claim', 'meal', 'advance'], text: {
        en: 'A rejected claim keeps its original dates when you resubmit it, even if the claim window has since closed.',
        id: 'Klaim yang ditolak tetap memakai tanggal aslinya saat dikirim ulang, meskipun periode klaim sudah ditutup.',
        th: 'รายการเบิกที่ถูกปฏิเสธจะคงวันที่เดิมไว้เมื่อส่งใหม่ แม้ช่วงเวลาการเบิกจะปิดไปแล้วก็ตาม',
        vi: 'Yêu cầu bị từ chối giữ nguyên ngày ban đầu khi bạn gửi lại, kể cả khi thời hạn yêu cầu đã đóng.',
        km: 'សំណើដែលត្រូវបានបដិសេធ រក្សាកាលបរិច្ឆេទដើមរបស់វា នៅពេលអ្នកដាក់ស្នើម្ដងទៀត ទោះបីរយៈពេលដាក់សំណើបានបិទហើយក៏ដោយ។',
        fil: 'Pinapanatili ng tinanggihang claim ang orihinal nitong mga petsa kapag isinumite mo ulit, kahit sarado na ang claim window.'
      } },
      { kind: 'fixed', audience: ['claim', 'meal', 'advance'], text: {
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
      { kind: 'new', audience: ['claim'], text: {
        en: 'A photo editor for receipts: crop, rotate with a dial, and add a capture stamp before you attach the photo.',
        id: 'Editor foto untuk bukti: potong, putar dengan tombol putar, dan tambahkan cap waktu pengambilan sebelum melampirkan foto.',
        th: 'ตัวแก้ไขรูปใบเสร็จ: ครอบตัด หมุนด้วยแป้นหมุน และเพิ่มตราเวลาที่ถ่ายก่อนแนบรูป',
        vi: 'Trình chỉnh ảnh hóa đơn: cắt, xoay bằng vòng xoay và thêm dấu thời gian chụp trước khi đính kèm ảnh.',
        km: 'កម្មវិធីកែរូបថតវិក្កយបត្រ៖ កាត់ បង្វិលដោយប្រើឌីស និងបន្ថែមត្រាពេលថត មុនពេលភ្ជាប់រូបថត។',
        fil: 'Photo editor para sa mga resibo: i-crop, i-rotate gamit ang dial, at magdagdag ng capture stamp bago ilakip ang larawan.'
      } },
      { kind: 'improved', audience: ['claim'], text: {
        en: 'A saved claim draft keeps its receipts too, so they are still there when you come back.',
        id: 'Draf klaim yang tersimpan juga menyimpan buktinya, jadi masih ada saat Anda kembali.',
        th: 'ฉบับร่างรายการเบิกที่บันทึกไว้จะเก็บใบเสร็จไว้ด้วย จึงยังอยู่ครบเมื่อคุณกลับมา',
        vi: 'Bản nháp yêu cầu đã lưu cũng giữ lại hóa đơn, nên chúng vẫn còn khi bạn quay lại.',
        km: 'សេចក្ដីព្រាងសំណើដែលបានរក្សាទុក ក៏រក្សាវិក្កយបត្ររបស់វាដែរ ដូច្នេះវានៅតែមាននៅពេលអ្នកត្រឡប់មកវិញ។',
        fil: 'Pinapanatili rin ng naka-save na draft ng claim ang mga resibo nito, kaya nandoon pa rin ang mga ito pagbalik mo.'
      } },
      { kind: 'fixed', audience: ['claim'], text: {
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
