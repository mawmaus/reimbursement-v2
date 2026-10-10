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
//   insights                may open Insights
//   superadmin              Super Admins only
// ---------------------------------------------------------------------------
window.CHANGELOG_AUDIENCES = ['claim', 'meal', 'advance', 'pay', 'export', 'view_all', 'accounts', 'settings', 'insights', 'superadmin'];
window.CHANGELOG = [
  {
    id: '2026-10-10.4',
    date: '2026-10-10',
    items: [
      { kind: 'improved', audience: ['settings'], text: {
        en: 'Settings → Expense types shows how often each type has been used on claims and cash advances, and when it was last used. Sort by name, most used or recently used; paste a list (one per line) to add several at once; and deleting or renaming a type that is in use tells you what happens to claims already filed.',
        id: 'Pengaturan → Jenis biaya kini menunjukkan seberapa sering setiap jenis dipakai pada klaim dan uang muka, serta kapan terakhir dipakai. Urutkan menurut nama, paling sering, atau terakhir dipakai; tempel daftar (satu per baris) untuk menambahkan beberapa sekaligus; dan saat menghapus atau mengganti nama jenis yang sedang dipakai, Anda diberi tahu dampaknya pada klaim yang sudah diajukan.',
        th: 'การตั้งค่า → ประเภทค่าใช้จ่าย แสดงว่าแต่ละประเภทถูกใช้ในเคลมและเงินทดรองบ่อยแค่ไหน และใช้ล่าสุดเมื่อใด เรียงตามชื่อ ใช้บ่อยที่สุด หรือใช้ล่าสุดได้ วางรายการ (บรรทัดละหนึ่งชื่อ) เพื่อเพิ่มหลายรายการพร้อมกัน และเมื่อลบหรือเปลี่ยนชื่อประเภทที่มีการใช้งาน ระบบจะบอกว่าเกิดอะไรกับเคลมที่ยื่นแล้ว',
        vi: 'Cài đặt → Loại chi phí giờ cho biết mỗi loại đã được dùng bao nhiêu lần trong yêu cầu và tạm ứng, và lần dùng gần nhất. Sắp xếp theo tên, dùng nhiều nhất hoặc dùng gần đây; dán một danh sách (mỗi dòng một mục) để thêm nhiều mục cùng lúc; và khi xóa hoặc đổi tên một loại đang được dùng, bạn sẽ được cho biết điều gì xảy ra với các yêu cầu đã nộp.',
        km: 'ការកំណត់ → ប្រភេទចំណាយ ឥឡូវបង្ហាញថាប្រភេទនីមួយៗត្រូវបានប្រើលើការទាមទារ និងប្រាក់បុរេប្រទានប៉ុន្មានដង និងប្រើចុងក្រោយពេលណា។ តម្រៀបតាមឈ្មោះ ប្រើច្រើនបំផុត ឬប្រើថ្មីៗ បិទភ្ជាប់បញ្ជី (មួយបន្ទាត់មួយ) ដើម្បីបន្ថែមច្រើនក្នុងពេលតែមួយ ហើយពេលលុប ឬប្តូរឈ្មោះប្រភេទដែលកំពុងប្រើ អ្នកនឹងដឹងថាមានអ្វីកើតឡើងចំពោះការទាមទារដែលបានដាក់រួច។',
        fil: 'Ipinapakita na ng Settings → Expense types kung gaano kadalas nagamit ang bawat uri sa mga claim at cash advance, at kung kailan ito huling ginamit. Ayusin ayon sa pangalan, pinakamadalas, o kamakailang ginamit; mag-paste ng listahan (isa bawat linya) para magdagdag ng marami nang sabay; at kapag binura o pinalitan ang pangalan ng uring ginagamit, sasabihin sa iyo kung ano ang mangyayari sa mga naisumiteng claim.'
      } },
      { kind: 'fixed', audience: ['settings'], text: {
        en: 'Renaming a department or job position now moves the accounts in it to the new name. Before, those accounts kept the old name and could lose the ability to raise claims.',
        id: 'Mengganti nama departemen atau jabatan kini ikut memindahkan akun di dalamnya ke nama baru. Sebelumnya, akun tersebut tetap memakai nama lama dan bisa kehilangan kemampuan mengajukan klaim.',
        th: 'การเปลี่ยนชื่อแผนกหรือตำแหน่งงานจะย้ายบัญชีที่อยู่ในนั้นไปใช้ชื่อใหม่ด้วย ก่อนหน้านี้บัญชีเหล่านั้นยังใช้ชื่อเดิมและอาจยื่นเคลมไม่ได้',
        vi: 'Đổi tên phòng ban hoặc chức vụ giờ sẽ chuyển các tài khoản trong đó sang tên mới. Trước đây, các tài khoản đó giữ tên cũ và có thể mất quyền tạo yêu cầu.',
        km: 'ការប្តូរឈ្មោះនាយកដ្ឋាន ឬមុខតំណែង ឥឡូវផ្លាស់គណនីក្នុងនោះទៅឈ្មោះថ្មីផងដែរ។ ពីមុន គណនីទាំងនោះនៅរក្សាឈ្មោះចាស់ ហើយអាចបាត់បង់សិទ្ធិដាក់ការទាមទារ។',
        fil: 'Kapag pinalitan ang pangalan ng department o job position, inililipat na rin sa bagong pangalan ang mga account na nasa loob nito. Dati, nananatili sa lumang pangalan ang mga account na iyon at maaaring hindi na sila makapag-claim.'
      } }
    ]
  },
  {
    id: '2026-10-10.3',
    date: '2026-10-10',
    items: [
      { kind: 'improved', audience: ['settings'], text: {
        en: 'Settings → Job positions shows where the ladder unlocks more access — lines mark which positions manage accounts in every department, see company-wide Insights, or can open Insights — and they move as you reorder. Reordering is now instant with numbered ranks and larger arrows, saves automatically, and the ⋯ menu adds Move to top and Move to bottom.',
        id: 'Pengaturan → Jabatan kini menunjukkan di mana urutan jabatan membuka akses lebih — garis menandai jabatan mana yang mengelola akun di semua departemen, melihat Insight seluruh perusahaan, atau dapat membuka Insight — dan garis ikut bergeser saat Anda mengubah urutan. Mengubah urutan kini langsung, dengan nomor peringkat dan tombol panah lebih besar, tersimpan otomatis, dan menu ⋯ menambahkan Pindah ke atas dan Pindah ke bawah.',
        th: 'การตั้งค่า → ตำแหน่งงาน แสดงจุดที่ลำดับตำแหน่งปลดล็อกสิทธิ์เพิ่มขึ้น — มีเส้นบอกว่าตำแหน่งใดจัดการบัญชีได้ทุกแผนก ดู Insight ทั้งบริษัท หรือเปิด Insight ได้ — และเส้นจะเลื่อนตามเมื่อคุณจัดลำดับใหม่ การจัดลำดับเกิดขึ้นทันทีพร้อมหมายเลขลำดับและปุ่มลูกศรที่ใหญ่ขึ้น บันทึกอัตโนมัติ และเมนู ⋯ มีย้ายไปบนสุดและย้ายไปล่างสุด',
        vi: 'Cài đặt → Chức vụ giờ cho thấy chỗ thứ bậc mở thêm quyền — các đường kẻ đánh dấu chức vụ nào quản lý tài khoản ở mọi phòng ban, xem Insight toàn công ty, hoặc có thể mở Insight — và chúng di chuyển khi bạn sắp xếp lại. Sắp xếp giờ diễn ra ngay, có số thứ hạng và mũi tên lớn hơn, tự động lưu, và menu ⋯ có thêm Chuyển lên đầu và Chuyển xuống cuối.',
        km: 'ការកំណត់ → មុខតំណែង ឥឡូវបង្ហាញកន្លែងដែលលំដាប់មុខតំណែងបើកសិទ្ធិបន្ថែម — បន្ទាត់សម្គាល់មុខតំណែងណាដែលគ្រប់គ្រងគណនីគ្រប់នាយកដ្ឋាន មើល Insight ទូទាំងក្រុមហ៊ុន ឬអាចបើក Insight — ហើយវាផ្លាស់ទីពេលអ្នកតម្រៀបឡើងវិញ។ ការតម្រៀបឥឡូវភ្លាមៗ មានលេខលំដាប់ និងព្រួញធំជាងមុន រក្សាទុកដោយស្វ័យប្រវត្តិ ហើយម៉ឺនុយ ⋯ បន្ថែម ផ្លាស់ទៅខាងលើបំផុត និង ផ្លាស់ទៅខាងក្រោមបំផុត។',
        fil: 'Ipinapakita na ng Settings → Job positions kung saan nagbubukas ng mas maraming access ang ranggo — may mga linyang nagmamarka kung aling posisyon ang namamahala ng account sa lahat ng department, nakakakita ng Insights ng buong kumpanya, o makakapagbukas ng Insights — at gumagalaw ang mga ito habang nag-aayos ka. Agaran na ang pag-aayos ng pagkakasunod, may numero ng ranggo at mas malalaking arrow, awtomatikong nase-save, at may Ilipat sa itaas at Ilipat sa ibaba na sa ⋯ menu.'
      } }
    ]
  },
  {
    id: '2026-10-10.2',
    date: '2026-10-10',
    items: [
      { kind: 'improved', audience: ['settings'], text: {
        en: 'Settings → Departments and Job positions show how many active accounts use each entry, warn when its members can’t raise any claims, and say how many accounts are affected before you delete one. Departments, job positions and expense types can be filtered by All / Active / Disabled, and on phones each entry is a tidy row with labelled toggles.',
        id: 'Pengaturan → Departemen dan Jabatan kini menampilkan berapa akun aktif yang memakai setiap entri, memberi peringatan jika anggotanya tidak bisa mengajukan klaim apa pun, dan menyebutkan berapa akun yang terdampak sebelum Anda menghapusnya. Departemen, jabatan, dan jenis biaya bisa disaring Semua / Aktif / Nonaktif, dan di ponsel setiap entri tampil rapi dengan tombol berlabel.',
        th: 'การตั้งค่า → แผนกและตำแหน่งงาน แสดงจำนวนบัญชีที่ใช้งานอยู่ของแต่ละรายการ เตือนเมื่อสมาชิกยื่นเคลมอะไรไม่ได้เลย และบอกจำนวนบัญชีที่ได้รับผลกระทบก่อนลบ แผนก ตำแหน่งงาน และประเภทค่าใช้จ่ายกรองได้ด้วย ทั้งหมด / ใช้งาน / ปิดใช้งาน และบนโทรศัพท์แต่ละรายการแสดงเป็นแถวที่เป็นระเบียบพร้อมสวิตช์ที่มีป้ายกำกับ',
        vi: 'Cài đặt → Phòng ban và Chức vụ giờ cho biết số tài khoản đang hoạt động dùng từng mục, cảnh báo khi thành viên không thể tạo yêu cầu nào, và cho biết số tài khoản bị ảnh hưởng trước khi bạn xóa. Phòng ban, chức vụ và loại chi phí có thể lọc theo Tất cả / Đang hoạt động / Đã vô hiệu hóa, và trên điện thoại mỗi mục là một hàng gọn gàng với các nút bật có nhãn.',
        km: 'ការកំណត់ → នាយកដ្ឋាន និងមុខតំណែង ឥឡូវបង្ហាញចំនួនគណនីសកម្មដែលប្រើធាតុនីមួយៗ ព្រមានពេលសមាជិកមិនអាចដាក់ការទាមទារណាមួយបាន ហើយប្រាប់ចំនួនគណនីដែលរងផលប៉ះពាល់មុនពេលអ្នកលុប។ នាយកដ្ឋាន មុខតំណែង និងប្រភេទចំណាយ អាចត្រងតាម ទាំងអស់ / សកម្ម / បានបិទ ហើយនៅលើទូរស័ព្ទ ធាតុនីមួយៗជាជួរដែលមានសណ្តាប់ធ្នាប់ជាមួយប៊ូតុងបិទបើកមានស្លាក។',
        fil: 'Ipinapakita na ng Settings → Departments at Job positions kung ilang aktibong account ang gumagamit ng bawat isa, nagbababala kapag hindi makapag-claim ang mga miyembro nito, at sinasabi kung ilang account ang maaapektuhan bago mo ito burahin. Maaaring i-filter ang departments, job positions at expense types ayon sa Lahat / Aktibo / Naka-disable, at sa phone, maayos na hanay ang bawat isa na may mga toggle na may label.'
      } },
      { kind: 'fixed', audience: ['settings'], text: {
        en: 'Country Managers and others who manage settings can now see disabled departments, job positions and expense types, so they can enable them again.',
        id: 'Country Manager dan pengelola pengaturan lainnya kini dapat melihat departemen, jabatan, dan jenis biaya yang dinonaktifkan, sehingga bisa mengaktifkannya kembali.',
        th: 'ผู้จัดการประเทศและผู้ที่จัดการการตั้งค่าอื่น ๆ มองเห็นแผนก ตำแหน่งงาน และประเภทค่าใช้จ่ายที่ปิดใช้งานแล้ว จึงเปิดใช้งานอีกครั้งได้',
        vi: 'Quản lý quốc gia và những người quản lý cài đặt khác giờ có thể thấy phòng ban, chức vụ và loại chi phí đã vô hiệu hóa để bật lại.',
        km: 'អ្នកគ្រប់គ្រងប្រទេស និងអ្នកគ្រប់គ្រងការកំណត់ផ្សេងទៀត ឥឡូវអាចឃើញនាយកដ្ឋាន មុខតំណែង និងប្រភេទចំណាយដែលបានបិទ ដើម្បីបើកវាឡើងវិញបាន។',
        fil: 'Nakikita na ng mga Country Manager at iba pang namamahala ng settings ang mga naka-disable na department, job position at expense type, kaya maaari na nilang i-enable muli ang mga ito.'
      } }
    ]
  },
  {
    id: '2026-10-10.1',
    date: '2026-10-10',
    items: [
      { kind: 'improved', audience: ['settings'], text: {
        en: 'Settings → Roles no longer scrolls sideways. On a wide screen the whole grid fits; on phones, tablets and small laptops each permission becomes a card with every role listed as a labelled checkbox, and roles you cannot change are marked "Locked".',
        id: 'Pengaturan → Peran tidak lagi bergulir ke samping. Di layar lebar seluruh tabel muat; di ponsel, tablet, dan laptop kecil setiap izin menjadi kartu dengan setiap peran sebagai kotak centang berlabel, dan peran yang tidak dapat Anda ubah ditandai "Terkunci".',
        th: 'การตั้งค่า → บทบาท ไม่ต้องเลื่อนไปด้านข้างอีกต่อไป บนจอกว้างตารางทั้งหมดแสดงได้พอดี บนโทรศัพท์ แท็บเล็ต และแล็ปท็อปขนาดเล็ก แต่ละสิทธิ์จะเป็นการ์ดที่แสดงทุกบทบาทเป็นช่องทำเครื่องหมายพร้อมชื่อ และบทบาทที่คุณเปลี่ยนไม่ได้จะมีป้าย "ถูกล็อก"',
        vi: 'Cài đặt → Vai trò không còn phải cuộn ngang. Trên màn hình rộng, toàn bộ bảng vừa khít; trên điện thoại, máy tính bảng và laptop nhỏ, mỗi quyền thành một thẻ liệt kê từng vai trò dưới dạng ô đánh dấu có tên, và các vai trò bạn không thể thay đổi được đánh dấu "Đã khóa".',
        km: 'ការកំណត់ → តួនាទី លែងរំកិលទៅចំហៀងទៀតហើយ។ នៅលើអេក្រង់ធំ តារាងទាំងមូលសមល្មម។ នៅលើទូរស័ព្ទ ថេប្លេត និងកុំព្យូទ័រយួរដៃតូច សិទ្ធិនីមួយៗក្លាយជាកាតដែលបង្ហាញតួនាទីនីមួយៗជាប្រអប់ធីកមានឈ្មោះ ហើយតួនាទីដែលអ្នកមិនអាចប្តូរបាន ត្រូវបានសម្គាល់ថា "បានចាក់សោ"។',
        fil: 'Hindi na kailangang mag-scroll patagilid sa Settings → Roles. Sa malapad na screen, kasya ang buong grid; sa phone, tablet at maliit na laptop, nagiging card ang bawat pahintulot na may bawat role bilang checkbox na may pangalan, at may markang "Naka-lock" ang mga role na hindi mo mababago.'
      } }
    ]
  },
  {
    id: '2026-10-09.11',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'Sign-in and passwords: the sign-in page is centred and easier to read, shows "Signing in…" while it works, and warns you when Caps Lock is on. Changing your password (in My profile) now asks you to type the new password twice and shows how strong it is, and the show-password eye is a proper icon everywhere.',
        id: 'Masuk dan kata sandi: halaman masuk kini berada di tengah dan lebih mudah dibaca, menampilkan "Sedang masuk…" saat diproses, dan memperingatkan jika Caps Lock aktif. Mengganti kata sandi (di Profil saya) kini meminta Anda mengetik kata sandi baru dua kali dan menunjukkan seberapa kuat kata sandi tersebut, dan ikon mata untuk menampilkan kata sandi kini berupa ikon yang rapi di semua tempat.',
        th: 'การเข้าสู่ระบบและรหัสผ่าน: หน้าเข้าสู่ระบบอยู่กึ่งกลางและอ่านง่ายขึ้น แสดง "กำลังเข้าสู่ระบบ…" ระหว่างดำเนินการ และเตือนเมื่อ Caps Lock เปิดอยู่ การเปลี่ยนรหัสผ่าน (ในโปรไฟล์ของฉัน) จะให้พิมพ์รหัสผ่านใหม่สองครั้งและแสดงความแข็งแรงของรหัสผ่าน และปุ่มรูปตาสำหรับแสดงรหัสผ่านเป็นไอคอนที่เรียบร้อยในทุกที่',
        vi: 'Đăng nhập và mật khẩu: trang đăng nhập được căn giữa và dễ đọc hơn, hiển thị "Đang đăng nhập…" khi đang xử lý, và cảnh báo khi Caps Lock đang bật. Đổi mật khẩu (trong Hồ sơ của tôi) giờ yêu cầu nhập mật khẩu mới hai lần và cho biết độ mạnh của mật khẩu, và nút con mắt để hiện mật khẩu giờ là biểu tượng gọn gàng ở mọi nơi.',
        km: 'ការចូល និងពាក្យសម្ងាត់៖ ទំព័រចូលឥឡូវនៅកណ្តាល និងងាយអានជាងមុន បង្ហាញ "កំពុងចូល…" ពេលកំពុងដំណើរការ ហើយព្រមានពេល Caps Lock កំពុងបើក។ ការប្តូរពាក្យសម្ងាត់ (ក្នុងប្រវត្តិរូបរបស់ខ្ញុំ) ឥឡូវស្នើឱ្យវាយពាក្យសម្ងាត់ថ្មីពីរដង និងបង្ហាញថាវារឹងមាំប៉ុណ្ណា ហើយប៊ូតុងភ្នែកសម្រាប់បង្ហាញពាក្យសម្ងាត់ជារូបតំណាងដែលមានសណ្តាប់ធ្នាប់គ្រប់កន្លែង។',
        fil: 'Pag-sign in at password: nasa gitna na at mas madaling basahin ang sign-in page, nagpapakita ng "Nagsa-sign in…" habang gumagana, at nagbababala kapag naka-on ang Caps Lock. Ang pagpapalit ng password (sa Aking profile) ay humihiling na ngayong i-type nang dalawang beses ang bagong password at ipinapakita kung gaano ito katibay, at maayos nang icon ang mata para ipakita ang password saanman.'
      } },
      { kind: 'improved', text: {
        en: 'My profile is organised into cards — Appearance, Contact & bank details, and Change password — each with its own Save button.',
        id: 'Profil saya kini tersusun dalam kartu — Tampilan, Kontak & detail bank, dan Ganti kata sandi — masing-masing dengan tombol Simpan sendiri.',
        th: 'โปรไฟล์ของฉันจัดเป็นการ์ดแล้ว — รูปลักษณ์ ข้อมูลติดต่อและบัญชีธนาคาร และเปลี่ยนรหัสผ่าน — แต่ละการ์ดมีปุ่มบันทึกของตัวเอง',
        vi: 'Hồ sơ của tôi được sắp thành các thẻ — Giao diện, Liên hệ & thông tin ngân hàng, và Đổi mật khẩu — mỗi thẻ có nút Lưu riêng.',
        km: 'ប្រវត្តិរូបរបស់ខ្ញុំត្រូវបានរៀបជាកាត — រូបរាង ទំនាក់ទំនង និងព័ត៌មានធនាគារ និងប្តូរពាក្យសម្ងាត់ — ដោយកាតនីមួយៗមានប៊ូតុងរក្សាទុកផ្ទាល់ខ្លួន។',
        fil: 'Nakaayos na sa mga card ang Aking profile — Itsura, Contact at detalye ng bangko, at Palitan ang password — na may kanya-kanyang Save button.'
      } },
      { kind: 'improved', text: {
        en: 'Export claims to CSV is split into Date range, What to include and Users, the date shortcuts stay highlighted while they apply, the user list shows how many are selected, and a summary of what you are about to download sits next to the Download button.',
        id: 'Ekspor klaim ke CSV kini dibagi menjadi Rentang tanggal, Yang disertakan, dan Pengguna; pintasan tanggal tetap tersorot selama berlaku, daftar pengguna menampilkan berapa yang dipilih, dan ringkasan isi unduhan berada di samping tombol Unduh.',
        th: 'การส่งออกรายการเบิกเป็น CSV แบ่งเป็นช่วงวันที่ สิ่งที่จะรวม และผู้ใช้ ปุ่มลัดวันที่จะยังคงไฮไลต์ขณะใช้งาน รายชื่อผู้ใช้แสดงจำนวนที่เลือก และสรุปสิ่งที่กำลังจะดาวน์โหลดอยู่ข้างปุ่มดาวน์โหลด',
        vi: 'Xuất yêu cầu ra CSV được chia thành Khoảng ngày, Nội dung xuất và Người dùng; các phím tắt ngày luôn được làm nổi bật khi đang áp dụng, danh sách người dùng hiển thị số đã chọn, và phần tóm tắt nội dung sắp tải nằm cạnh nút Tải xuống.',
        km: 'ការនាំចេញសំណើទៅ CSV ត្រូវបានបែងចែកជា ចន្លោះកាលបរិច្ឆេទ អ្វីដែលត្រូវរួមបញ្ចូល និងអ្នកប្រើ ផ្លូវកាត់កាលបរិច្ឆេទនៅតែរំលេចពេលកំពុងអនុវត្ត បញ្ជីអ្នកប្រើបង្ហាញចំនួនដែលបានជ្រើស ហើយសេចក្តីសង្ខេបនៃអ្វីដែលអ្នកនឹងទាញយកនៅក្បែរប៊ូតុងទាញយក។',
        fil: 'Nahahati na ang Export claims to CSV sa Saklaw ng petsa, Mga isasama at Mga user; nananatiling naka-highlight ang mga shortcut ng petsa habang ginagamit, ipinapakita ng listahan ng user kung ilan ang napili, at nasa tabi ng Download button ang buod ng ida-download mo.'
      }, audience: ['export'] },
      { kind: 'fixed', text: {
        en: 'The page you reach from a password-reset email now appears in your language instead of always in English.',
        id: 'Halaman yang Anda buka dari email reset kata sandi kini tampil dalam bahasa Anda, bukan selalu dalam bahasa Inggris.',
        th: 'หน้าที่เปิดจากอีเมลรีเซ็ตรหัสผ่านแสดงเป็นภาษาของคุณแล้ว แทนที่จะเป็นภาษาอังกฤษเสมอ',
        vi: 'Trang bạn mở từ email đặt lại mật khẩu giờ hiển thị bằng ngôn ngữ của bạn thay vì luôn là tiếng Anh.',
        km: 'ទំព័រដែលអ្នកបើកពីអ៊ីមែលកំណត់ពាក្យសម្ងាត់ឡើងវិញឥឡូវបង្ហាញជាភាសារបស់អ្នក ជំនួសឱ្យភាសាអង់គ្លេសជានិច្ច។',
        fil: 'Lumalabas na sa iyong wika ang pahinang naaabot mula sa password-reset email, sa halip na laging nasa Ingles.'
      } }
    ]
  },
  {
    id: '2026-10-09.10',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'The home menu is organised into groups — Your claims, Approvals, Finance, Cash advances and Overview — with an icon and a clear count on every tile. A line under the greeting tells you how many claims are waiting for your approval, and that tile is highlighted while anything is waiting. On phones the tiles become a compact list.',
        id: 'Menu beranda kini dikelompokkan — Klaim Anda, Persetujuan, Keuangan, Uang muka, dan Ikhtisar — dengan ikon dan jumlah yang jelas di setiap kotak. Satu baris di bawah sapaan memberi tahu berapa klaim yang menunggu persetujuan Anda, dan kotak itu disorot selama ada yang menunggu. Di ponsel, kotak-kotak menjadi daftar yang ringkas.',
        th: 'เมนูหน้าแรกจัดเป็นกลุ่มแล้ว — รายการเบิกของคุณ การอนุมัติ การเงิน เงินทดรองจ่าย และภาพรวม — พร้อมไอคอนและตัวเลขที่ชัดเจนในทุกช่อง บรรทัดใต้คำทักทายบอกว่ามีรายการเบิกรอการอนุมัติจากคุณกี่รายการ และช่องนั้นจะถูกเน้นตราบที่ยังมีรายการรออยู่ บนมือถือช่องต่างๆ จะเป็นรายการแบบกะทัดรัด',
        vi: 'Menu trang chủ được chia nhóm — Yêu cầu của bạn, Phê duyệt, Tài chính, Tạm ứng và Tổng quan — với biểu tượng và con số rõ ràng trên mỗi ô. Một dòng dưới lời chào cho biết có bao nhiêu yêu cầu đang chờ bạn phê duyệt, và ô đó được làm nổi bật khi còn yêu cầu đang chờ. Trên điện thoại, các ô trở thành danh sách gọn.',
        km: 'ម៉ឺនុយទំព័រដើមត្រូវបានរៀបជាក្រុម — សំណើរបស់អ្នក ការអនុម័ត ហិរញ្ញវត្ថុ ប្រាក់បុរេប្រទាន និងទិដ្ឋភាពទូទៅ — ដោយមានរូបតំណាង និងចំនួនច្បាស់លាស់លើប្រអប់នីមួយៗ។ បន្ទាត់មួយនៅក្រោមការស្វាគមន៍ប្រាប់ថាមានសំណើប៉ុន្មានកំពុងរង់ចាំការអនុម័តរបស់អ្នក ហើយប្រអប់នោះត្រូវបានរំលេចដរាបណានៅមានសំណើរង់ចាំ។ នៅលើទូរសព្ទ ប្រអប់ទាំងនោះក្លាយជាបញ្ជីបង្រួម។',
        fil: 'Nakaayos na sa mga grupo ang home menu — Iyong mga claim, Mga pag-apruba, Pananalapi, Mga cash advance at Pangkalahatang-tanaw — na may icon at malinaw na bilang sa bawat tile. Sinasabi ng isang linya sa ilalim ng pagbati kung ilang claim ang naghihintay ng iyong pag-apruba, at naka-highlight ang tile na iyon habang may naghihintay. Sa phone, nagiging siksik na listahan ang mga tile.'
      } },
      { kind: 'improved', text: {
        en: 'Insights: the header now says exactly what the figures cover (scope, period and statuses), a Reset filters button clears every filter at once, each expense type shows its share of the total, and the trend chart names its peak with readable month labels. On phones the filters fold behind a Filters button, so the figures and charts come first.',
        id: 'Wawasan: bagian atas kini menyebutkan dengan tepat cakupan angka (lingkup, periode, dan status), tombol Atur ulang filter menghapus semua filter sekaligus, setiap jenis pengeluaran menampilkan porsinya dari total, dan grafik tren menyebutkan puncaknya dengan label bulan yang mudah dibaca. Di ponsel, filter dilipat di balik tombol Filter sehingga angka dan grafik tampil lebih dulu.',
        th: 'ข้อมูลเชิงลึก: ส่วนหัวบอกชัดเจนว่าตัวเลขครอบคลุมอะไร (ขอบเขต ช่วงเวลา และสถานะ) ปุ่มล้างตัวกรองล้างตัวกรองทั้งหมดในครั้งเดียว ประเภทค่าใช้จ่ายแต่ละประเภทแสดงสัดส่วนจากยอดรวม และกราฟแนวโน้มบอกจุดสูงสุดพร้อมชื่อเดือนที่อ่านง่าย บนมือถือ ตัวกรองจะพับอยู่หลังปุ่มตัวกรอง ตัวเลขและกราฟจึงแสดงก่อน',
        vi: 'Thông tin chi tiết: phần đầu giờ nêu rõ các số liệu bao gồm những gì (phạm vi, kỳ và trạng thái), nút Đặt lại bộ lọc xóa mọi bộ lọc cùng lúc, mỗi loại chi phí hiển thị tỷ trọng trong tổng, và biểu đồ xu hướng nêu điểm cao nhất với nhãn tháng dễ đọc. Trên điện thoại, bộ lọc được gấp sau nút Bộ lọc để số liệu và biểu đồ hiện ra trước.',
        km: 'ការយល់ដឹង៖ ផ្នែកខាងលើឥឡូវប្រាប់ច្បាស់ថាតួលេខគ្របដណ្តប់អ្វី (វិសាលភាព រយៈពេល និងស្ថានភាព) ប៊ូតុងកំណត់តម្រងឡើងវិញ សម្អាតតម្រងទាំងអស់ក្នុងពេលតែមួយ ប្រភេទការចំណាយនីមួយៗបង្ហាញភាគរយនៃសរុប ហើយក្រាហ្វនិន្នាការប្រាប់ចំណុចខ្ពស់បំផុត ដោយមានស្លាកខែដែលងាយអាន។ នៅលើទូរសព្ទ តម្រងត្រូវបានបត់នៅពីក្រោយប៊ូតុងតម្រង ដូច្នេះតួលេខ និងក្រាហ្វបង្ហាញមុន។',
        fil: 'Insights: sinasabi na ng header kung ano mismo ang saklaw ng mga numero (saklaw, panahon at mga status), nililinis ng I-reset ang mga filter na button ang lahat ng filter nang sabay, ipinapakita ng bawat uri ng gastos ang bahagi nito sa kabuuan, at pinapangalanan ng trend chart ang pinakamataas na buwan gamit ang madaling basahing mga label ng buwan. Sa phone, nakatupi ang mga filter sa likod ng Filters na button kaya nauuna ang mga numero at chart.'
      }, audience: ['insights'] }
    ]
  },
  {
    id: '2026-10-09.9',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'The claim, meal allowance and cash advance forms are tidier: your name, department and currency show under the title, "+ Add another line" now sits right under the lines, Approver 1 has its own section, and the total with a count of lines stays at the bottom next to Submit. On phones each line is a numbered card and Submit is a full-width button at the bottom.',
        id: 'Formulir klaim, tunjangan makan, dan uang muka kini lebih rapi: nama, departemen, dan mata uang Anda tampil di bawah judul, "+ Tambah baris lagi" kini berada tepat di bawah baris-baris, Approver 1 memiliki bagiannya sendiri, dan total beserta jumlah baris tetap di bawah di samping tombol Kirim. Di ponsel, setiap baris menjadi kartu bernomor dan tombol Kirim selebar layar di bagian bawah.',
        th: 'ฟอร์มเบิกค่าใช้จ่าย เบี้ยเลี้ยงค่าอาหาร และเงินทดรองจ่ายเป็นระเบียบขึ้น: ชื่อ แผนก และสกุลเงินของคุณแสดงใต้หัวเรื่อง ปุ่ม "+ เพิ่มอีกรายการ" อยู่ใต้รายการทันที Approver 1 มีส่วนของตัวเอง และยอดรวมพร้อมจำนวนรายการอยู่ด้านล่างข้างปุ่มส่ง บนมือถือแต่ละรายการเป็นการ์ดที่มีหมายเลข และปุ่มส่งเต็มความกว้างอยู่ด้านล่าง',
        vi: 'Các biểu mẫu yêu cầu hoàn ứng, phụ cấp ăn và tạm ứng gọn gàng hơn: tên, phòng ban và tiền tệ của bạn hiện dưới tiêu đề, "+ Thêm dòng" nằm ngay dưới các dòng, Approver 1 có phần riêng, và tổng tiền cùng số dòng luôn ở cuối cạnh nút Gửi. Trên điện thoại, mỗi dòng là một thẻ có đánh số và nút Gửi rộng hết màn hình ở cuối.',
        km: 'ទម្រង់ស្នើសុំសំណង ប្រាក់ឧបត្ថម្ភអាហារ និងប្រាក់បុរេប្រទានមានសណ្តាប់ធ្នាប់ជាងមុន៖ ឈ្មោះ នាយកដ្ឋាន និងរូបិយប័ណ្ណរបស់អ្នកបង្ហាញនៅក្រោមចំណងជើង "+ បន្ថែមបន្ទាត់ទៀត" ឥឡូវនៅក្រោមបន្ទាត់ផ្ទាល់ Approver 1 មានផ្នែកផ្ទាល់ខ្លួន ហើយសរុបជាមួយចំនួនបន្ទាត់នៅខាងក្រោមក្បែរប៊ូតុងដាក់ស្នើ។ នៅលើទូរសព្ទ បន្ទាត់នីមួយៗជាកាតមានលេខ ហើយប៊ូតុងដាក់ស្នើពេញទទឹងនៅខាងក្រោម។',
        fil: 'Mas maayos na ang mga form ng claim, meal allowance at cash advance: lumalabas sa ilalim ng pamagat ang iyong pangalan, departamento at currency, nasa ilalim na mismo ng mga linya ang "+ Magdagdag ng linya", may sariling seksyon ang Approver 1, at nasa ibaba katabi ng Submit ang kabuuan at bilang ng mga linya. Sa phone, may numero ang bawat linya bilang card at buong lapad ang Submit sa ibaba.'
      }, audience: ['claim', 'meal', 'advance'] },
      { kind: 'fixed', text: {
        en: 'The required-field star (*) on Approver 1, the advance purpose and the advance amount no longer drops onto a line of its own, and the meal form no longer repeats its example text ("Surabaya") in every empty row.',
        id: 'Tanda wajib (*) pada Approver 1, tujuan uang muka, dan jumlah uang muka tidak lagi turun ke baris sendiri, dan formulir tunjangan makan tidak lagi mengulang contoh teksnya ("Surabaya") di setiap baris kosong.',
        th: 'เครื่องหมายช่องบังคับ (*) ของ Approver 1 วัตถุประสงค์ และจำนวนเงินทดรองจ่าย ไม่ตกไปอยู่บรรทัดของตัวเองอีกต่อไป และฟอร์มเบี้ยเลี้ยงค่าอาหารไม่แสดงข้อความตัวอย่าง ("Surabaya") ซ้ำในทุกแถวว่างแล้ว',
        vi: 'Dấu bắt buộc (*) ở Approver 1, mục đích và số tiền tạm ứng không còn rơi xuống một dòng riêng, và biểu mẫu phụ cấp ăn không còn lặp lại chữ mẫu ("Surabaya") ở mọi dòng trống.',
        km: 'សញ្ញាចាំបាច់ (*) នៅលើ Approver 1 គោលបំណង និងចំនួនប្រាក់បុរេប្រទាន លែងធ្លាក់ទៅបន្ទាត់ដាច់ដោយឡែកហើយ ហើយទម្រង់ប្រាក់ឧបត្ថម្ភអាហារលែងបង្ហាញអត្ថបទគំរូ ("Surabaya") ម្តងទៀតក្នុងគ្រប់ជួរទទេ។',
        fil: 'Hindi na bumababa sa sariling linya ang required na bituin (*) sa Approver 1, layunin at halaga ng cash advance, at hindi na inuulit ng meal form ang halimbawang teksto ("Surabaya") sa bawat bakanteng hanay.'
      }, audience: ['claim', 'meal', 'advance'] }
    ]
  },
  {
    id: '2026-10-09.8',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'On phones the top bar is now a single slim row — logo, New, What\'s new and your initials. Tap your initials for everything else: region, language, dark mode, Export, Profile, Settings and Sign out.',
        id: 'Di ponsel, bilah atas kini hanya satu baris ramping — logo, Baru, Yang baru, dan inisial Anda. Ketuk inisial Anda untuk semua hal lainnya: wilayah, bahasa, mode gelap, Ekspor, Profil, Pengaturan, dan Keluar.',
        th: 'บนมือถือ แถบด้านบนเหลือเพียงแถวเดียวที่บางลง — โลโก้ ใหม่ มีอะไรใหม่ และอักษรย่อชื่อของคุณ แตะอักษรย่อเพื่อเข้าถึงทุกอย่างที่เหลือ: ภูมิภาค ภาษา โหมดมืด ส่งออก โปรไฟล์ การตั้งค่า และออกจากระบบ',
        vi: 'Trên điện thoại, thanh trên cùng giờ chỉ còn một hàng gọn — logo, Mới, Có gì mới và chữ viết tắt tên bạn. Chạm vào chữ viết tắt để mở mọi thứ còn lại: khu vực, ngôn ngữ, chế độ tối, Xuất, Hồ sơ, Cài đặt và Đăng xuất.',
        km: 'នៅលើទូរសព្ទ របារខាងលើឥឡូវជាជួរតែមួយស្តើង — ឡូហ្គោ ថ្មី អ្វីថ្មី និងអក្សរកាត់ឈ្មោះរបស់អ្នក។ ចុចអក្សរកាត់ដើម្បីបើកអ្វីៗផ្សេងទៀត៖ តំបន់ ភាសា មុខងារងងឹត នាំចេញ ប្រវត្តិរូប ការកំណត់ និងចាកចេញ។',
        fil: 'Sa phone, iisang manipis na hanay na lang ang top bar — logo, Bago, Ano ang bago at ang iyong mga inisyal. I-tap ang iyong mga inisyal para sa lahat ng iba pa: rehiyon, wika, dark mode, Export, Profile, Settings at Sign out.'
      } },
      { kind: 'improved', text: {
        en: 'A claim\'s detail panel now opens with what matters at a glance — the type, the amount, its status and whose it is — shows the payment details in one card with a Copy button for the account number, and keeps Approve, Reject and the other actions pinned at the bottom so you never have to scroll to them.',
        id: 'Panel detail klaim kini langsung menampilkan hal terpenting — jenis, jumlah, status, dan pemiliknya — menampilkan detail pembayaran dalam satu kartu dengan tombol Salin untuk nomor rekening, dan menyematkan Setujui, Tolak, serta tindakan lainnya di bagian bawah sehingga Anda tidak perlu menggulir untuk mencapainya.',
        th: 'หน้ารายละเอียดรายการเบิกเปิดมาพร้อมข้อมูลสำคัญในทันที — ประเภท จำนวนเงิน สถานะ และเจ้าของรายการ — แสดงรายละเอียดการจ่ายเงินในการ์ดเดียวพร้อมปุ่มคัดลอกเลขบัญชี และตรึงปุ่มอนุมัติ ปฏิเสธ และการดำเนินการอื่นๆ ไว้ด้านล่าง จึงไม่ต้องเลื่อนหา',
        vi: 'Bảng chi tiết yêu cầu giờ hiển thị ngay những điều quan trọng — loại, số tiền, trạng thái và người gửi — gom thông tin thanh toán vào một thẻ kèm nút Sao chép số tài khoản, và ghim Phê duyệt, Từ chối cùng các thao tác khác ở cuối nên bạn không cần cuộn để tìm.',
        km: 'ផ្ទាំងព័ត៌មានលម្អិតសំណើឥឡូវបើកដោយបង្ហាញអ្វីសំខាន់ភ្លាមៗ — ប្រភេទ ចំនួនទឹកប្រាក់ ស្ថានភាព និងម្ចាស់ — បង្ហាញព័ត៌មានការទូទាត់ក្នុងកាតតែមួយ ដោយមានប៊ូតុងចម្លងលេខគណនី ហើយភ្ជាប់ប៊ូតុងអនុម័ត បដិសេធ និងសកម្មភាពផ្សេងទៀតនៅខាងក្រោម ដូច្នេះអ្នកមិនចាំបាច់រំកិលរកទេ។',
        fil: 'Bumubukas na ang detail panel ng claim nang nakikita agad ang mahalaga — uri, halaga, status at kung kanino ito — ipinapakita ang detalye ng bayad sa iisang card na may Copy button para sa account number, at nakapirmi sa ibaba ang Approve, Reject at iba pang aksyon kaya hindi mo na kailangang mag-scroll para maabot ang mga ito.'
      } },
      { kind: 'improved', text: {
        en: 'Status tags across the app (claims, accounts, settings, approval steps) now use the same easy-to-read style instead of all-capital letters, and they fit on one line in every language.',
        id: 'Label status di seluruh aplikasi (klaim, akun, pengaturan, langkah persetujuan) kini memakai gaya yang sama dan mudah dibaca, bukan huruf kapital semua, serta muat dalam satu baris di setiap bahasa.',
        th: 'ป้ายสถานะทั่วทั้งแอป (รายการเบิก บัญชี การตั้งค่า ขั้นตอนการอนุมัติ) ใช้รูปแบบเดียวกันที่อ่านง่ายแทนตัวพิมพ์ใหญ่ทั้งหมด และอยู่ในบรรทัดเดียวในทุกภาษา',
        vi: 'Nhãn trạng thái trong toàn ứng dụng (yêu cầu, tài khoản, cài đặt, các bước phê duyệt) giờ dùng chung một kiểu dễ đọc thay vì viết hoa toàn bộ, và nằm gọn trên một dòng ở mọi ngôn ngữ.',
        km: 'ស្លាកស្ថានភាពនៅទូទាំងកម្មវិធី (សំណើ គណនី ការកំណត់ ជំហានអនុម័ត) ឥឡូវប្រើរចនាប័ទ្មដូចគ្នាដែលងាយអាន ជំនួសឱ្យអក្សរធំទាំងអស់ ហើយសមល្មមក្នុងមួយបន្ទាត់ក្នុងគ្រប់ភាសា។',
        fil: 'Iisang madaling basahing istilo na ang mga status tag sa buong app (claims, accounts, settings, mga hakbang ng pag-apruba) sa halip na puro malalaking titik, at kasya ang mga ito sa iisang linya sa bawat wika.'
      } },
      { kind: 'fixed', text: {
        en: 'Changing the language now also updates the claims list filters ("All statuses", "All departments", "All claimants") straight away.',
        id: 'Mengganti bahasa kini juga langsung memperbarui filter daftar klaim ("Semua status", "Semua departemen", "Semua pengaju").',
        th: 'การเปลี่ยนภาษาจะอัปเดตตัวกรองของรายการเบิก ("ทุกสถานะ" "ทุกแผนก" "ผู้เบิกทั้งหมด") ทันทีด้วย',
        vi: 'Đổi ngôn ngữ giờ cũng cập nhật ngay các bộ lọc của danh sách yêu cầu ("Tất cả trạng thái", "Tất cả phòng ban", "Tất cả người yêu cầu").',
        km: 'ការប្តូរភាសាឥឡូវក៏ធ្វើបច្ចុប្បន្នភាពតម្រងបញ្ជីសំណើ ("ស្ថានភាពទាំងអស់" "នាយកដ្ឋានទាំងអស់" "អ្នកស្នើសុំទាំងអស់") ភ្លាមៗផងដែរ។',
        fil: 'Kapag pinalitan ang wika, agad na ring naa-update ang mga filter ng listahan ng claims ("Lahat ng status", "Lahat ng departamento", "Lahat ng claimant").'
      } }
    ]
  },
  {
    id: '2026-10-09.7',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'The claims list is cleaner: the header shows how many claims are listed and when they were last updated, status tags and summary cards read on one line, and a Clear filters button resets everything at once. On phones the summary cards become one swipeable row, the filters fold behind a Filters button (with a count of active filters), and selected claims get an action bar at the bottom of the screen — so the claims themselves start much higher up.',
        id: 'Daftar klaim kini lebih rapi: bagian atas menampilkan jumlah klaim yang tercantum dan kapan terakhir diperbarui, label status dan kartu ringkasan terbaca dalam satu baris, dan tombol Hapus filter mengatur ulang semuanya sekaligus. Di ponsel, kartu ringkasan menjadi satu baris yang dapat digeser, filter dilipat di balik tombol Filter (dengan jumlah filter aktif), dan klaim yang dipilih mendapat bilah tindakan di bagian bawah layar — sehingga klaimnya sendiri tampil jauh lebih ke atas.',
        th: 'รายการเบิกเป็นระเบียบขึ้น: ส่วนหัวแสดงจำนวนรายการและเวลาที่อัปเดตล่าสุด ป้ายสถานะและการ์ดสรุปอ่านได้ในบรรทัดเดียว และปุ่มล้างตัวกรองรีเซ็ตทุกอย่างในครั้งเดียว บนมือถือ การ์ดสรุปกลายเป็นแถวเดียวที่ปัดได้ ตัวกรองพับอยู่หลังปุ่มตัวกรอง (พร้อมจำนวนตัวกรองที่ใช้อยู่) และเมื่อเลือกรายการจะมีแถบคำสั่งที่ด้านล่างของหน้าจอ — รายการเบิกจึงเริ่มแสดงสูงขึ้นมาก',
        vi: 'Danh sách yêu cầu gọn gàng hơn: phần đầu hiển thị số yêu cầu đang liệt kê và thời điểm cập nhật gần nhất, nhãn trạng thái và thẻ tổng hợp nằm gọn trên một dòng, và nút Xóa bộ lọc đặt lại mọi thứ cùng lúc. Trên điện thoại, các thẻ tổng hợp thành một hàng có thể vuốt, bộ lọc được gấp sau nút Bộ lọc (kèm số bộ lọc đang bật), và khi chọn yêu cầu sẽ có thanh thao tác ở cuối màn hình — nên danh sách yêu cầu hiện cao hơn nhiều.',
        km: 'បញ្ជីសំណើមានសណ្តាប់ធ្នាប់ជាងមុន៖ ផ្នែកខាងលើបង្ហាញចំនួនសំណើ និងពេលធ្វើបច្ចុប្បន្នភាពចុងក្រោយ ស្លាកស្ថានភាព និងកាតសង្ខេបអានបានក្នុងមួយបន្ទាត់ ហើយប៊ូតុង សម្អាតតម្រង កំណត់អ្វីៗទាំងអស់ឡើងវិញក្នុងពេលតែមួយ។ នៅលើទូរសព្ទ កាតសង្ខេបក្លាយជាជួរតែមួយដែលអាចអូសបាន តម្រងត្រូវបានបត់នៅពីក្រោយប៊ូតុង តម្រង (ជាមួយចំនួនតម្រងសកម្ម) ហើយសំណើដែលបានជ្រើសមានរបារសកម្មភាពនៅខាងក្រោមអេក្រង់ — ដូច្នេះសំណើចាប់ផ្តើមបង្ហាញខ្ពស់ជាងមុនច្រើន។',
        fil: 'Mas maayos na ang listahan ng claims: ipinapakita ng header kung ilang claim ang nakalista at kailan huling na-update, nasa iisang linya na ang mga status tag at summary card, at nire-reset ng Clear filters na button ang lahat nang sabay. Sa phone, nagiging isang hanay na maaaring i-swipe ang mga summary card, nakatupi ang mga filter sa likod ng Filters na button (na may bilang ng aktibong filter), at may action bar sa ibaba ng screen kapag may piniling claim — kaya mas mataas nang nagsisimula ang mga claim mismo.'
      } },
      { kind: 'fixed', text: {
        en: 'The "Pending - Manager" / "Pending - FinanceAP" labels on the claims list, its summary cards and its status filter now appear in your language instead of always in English.',
        id: 'Label "Menunggu - Manager" / "Menunggu - FinanceAP" pada daftar klaim, kartu ringkasan, dan filter statusnya kini tampil dalam bahasa Anda, bukan selalu dalam bahasa Inggris.',
        th: 'ป้าย "รอ - Manager" / "รอ - FinanceAP" ในรายการเบิก การ์ดสรุป และตัวกรองสถานะ แสดงเป็นภาษาของคุณแล้ว แทนที่จะเป็นภาษาอังกฤษเสมอ',
        vi: 'Các nhãn "Chờ - Manager" / "Chờ - FinanceAP" trên danh sách yêu cầu, thẻ tổng hợp và bộ lọc trạng thái giờ hiển thị bằng ngôn ngữ của bạn thay vì luôn là tiếng Anh.',
        km: 'ស្លាក "រង់ចាំ - Manager" / "រង់ចាំ - FinanceAP" នៅលើបញ្ជីសំណើ កាតសង្ខេប និងតម្រងស្ថានភាព ឥឡូវបង្ហាញជាភាសារបស់អ្នក ជំនួសឱ្យភាសាអង់គ្លេសជានិច្ច។',
        fil: 'Lumalabas na sa wika mo ang mga label na "Naghihintay - Manager" / "Naghihintay - FinanceAP" sa listahan ng claims, sa mga summary card at sa status filter nito, sa halip na laging nasa Ingles.'
      } }
    ]
  },
  {
    id: '2026-10-09.6',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'Manage accounts is tidier: each person\'s email sits under their name, accounts can be filtered by All, Active or Disabled, and every row has one Reset password button with Disable / Enable in a ⋯ menu. Rows you can\'t change are marked View only, and the Reset password window shows whose password you are changing.',
        id: 'Kelola akun kini lebih rapi: email setiap orang ada di bawah namanya, akun dapat difilter menurut Semua, Aktif, atau Nonaktif, dan setiap baris memiliki satu tombol Reset kata sandi dengan Nonaktifkan / Aktifkan di menu ⋯. Baris yang tidak dapat Anda ubah ditandai Hanya lihat, dan jendela Reset kata sandi menampilkan kata sandi siapa yang sedang Anda ubah.',
        th: 'หน้าจัดการบัญชีเป็นระเบียบขึ้น: อีเมลของแต่ละคนอยู่ใต้ชื่อ กรองบัญชีได้ตามทั้งหมด ใช้งาน หรือปิดใช้งาน และแต่ละแถวมีปุ่มรีเซ็ตรหัสผ่านปุ่มเดียว โดยย้ายปิดใช้งาน / เปิดใช้งานไปไว้ในเมนู ⋯ แถวที่คุณแก้ไขไม่ได้จะมีป้ายดูได้อย่างเดียว และหน้าต่างรีเซ็ตรหัสผ่านจะแสดงว่ากำลังเปลี่ยนรหัสผ่านของใคร',
        vi: 'Quản lý tài khoản gọn gàng hơn: email của mỗi người nằm dưới tên họ, có thể lọc tài khoản theo Tất cả, Đang hoạt động hoặc Bị vô hiệu hóa, và mỗi dòng có một nút Đặt lại mật khẩu, còn Vô hiệu hóa / Kích hoạt nằm trong menu ⋯. Các dòng bạn không thể thay đổi được ghi Chỉ xem, và cửa sổ Đặt lại mật khẩu hiển thị bạn đang đổi mật khẩu của ai.',
        km: 'ការគ្រប់គ្រងគណនីមានសណ្តាប់ធ្នាប់ជាងមុន៖ អ៊ីមែលរបស់មនុស្សម្នាក់ៗនៅក្រោមឈ្មោះ គណនីអាចត្រងតាម ទាំងអស់ សកម្ម ឬបានបិទ ហើយជួរនីមួយៗមានប៊ូតុងកំណត់ពាក្យសម្ងាត់ឡើងវិញតែមួយ ដោយមាន បិទ / បើក ក្នុងម៉ឺនុយ ⋯។ ជួរដែលអ្នកមិនអាចកែបានត្រូវបានសម្គាល់ មើលតែប៉ុណ្ណោះ ហើយបង្អួចកំណត់ពាក្យសម្ងាត់ឡើងវិញបង្ហាញថាអ្នកកំពុងប្តូរពាក្យសម្ងាត់របស់នរណា។',
        fil: 'Mas maayos na ang Manage accounts: nasa ilalim ng pangalan ang email ng bawat tao, maaaring i-filter ang mga account ayon sa Lahat, Aktibo o Naka-disable, at bawat hanay ay may iisang Reset password na button na may I-disable / I-enable sa ⋯ na menu. Minarkahang Tingin lang ang mga hanay na hindi mo mababago, at ipinapakita ng Reset password na window kung kaninong password ang binabago mo.'
      }, audience: ['accounts'] },
      { kind: 'improved', text: {
        en: 'Settings and the account screens work better on phones: page notes fold to two lines (tap to read more), account cards are more compact, buttons are easier to tap, and the Roles table keeps the permission names in view while you scroll sideways.',
        id: 'Pengaturan dan layar akun kini lebih nyaman di ponsel: catatan halaman dilipat menjadi dua baris (ketuk untuk membaca selengkapnya), kartu akun lebih ringkas, tombol lebih mudah diketuk, dan tabel Peran tetap menampilkan nama izin saat Anda menggulir ke samping.',
        th: 'การตั้งค่าและหน้าบัญชีใช้งานบนมือถือได้ดีขึ้น: คำอธิบายหน้าพับเหลือสองบรรทัด (แตะเพื่ออ่านต่อ) การ์ดบัญชีกระชับขึ้น ปุ่มกดง่ายขึ้น และตารางบทบาทยังคงแสดงชื่อสิทธิ์ขณะเลื่อนไปด้านข้าง',
        vi: 'Cài đặt và các màn hình tài khoản dùng tốt hơn trên điện thoại: ghi chú trang được thu gọn còn hai dòng (chạm để xem thêm), thẻ tài khoản gọn hơn, nút dễ bấm hơn, và bảng Vai trò luôn hiển thị tên quyền khi bạn cuộn ngang.',
        km: 'ការកំណត់ និងអេក្រង់គណនីដំណើរការល្អជាងនៅលើទូរសព្ទ៖ កំណត់ចំណាំទំព័របត់ត្រឹមពីរបន្ទាត់ (ចុចដើម្បីអានបន្ថែម) កាតគណនីបង្រួមជាងមុន ប៊ូតុងងាយចុចជាងមុន ហើយតារាងតួនាទីរក្សាឈ្មោះសិទ្ធិឱ្យនៅមើលឃើញពេលអ្នករំកិលទៅចំហៀង។',
        fil: 'Mas maayos na sa phone ang Settings at mga screen ng account: tinutupi sa dalawang linya ang mga paliwanag ng pahina (i-tap para basahin pa), mas siksik ang mga account card, mas madaling i-tap ang mga button, at nananatiling nakikita ang mga pangalan ng permiso sa Roles table habang nag-i-scroll pakanan.'
      }, audience: ['settings', 'accounts'] }
    ]
  },
  {
    id: '2026-10-09.5',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'The add / edit account form is reorganised into clear sections — Profile, Sign-in, Role & access, Approvals and Bank details — with a side menu to jump between them. The header shows who you are editing (name, username, role and region), Save stays at the bottom of the window at all times, and the approval-limit amount only appears when Unlimited is unticked.',
        id: 'Formulir tambah / ubah akun kini tersusun dalam bagian yang jelas — Profil, Masuk, Peran & akses, Persetujuan, dan Detail bank — dengan menu samping untuk berpindah antarbagian. Bagian atas menampilkan siapa yang sedang Anda ubah (nama, nama pengguna, peran, dan wilayah), tombol Simpan selalu terlihat di bawah jendela, dan kolom jumlah batas persetujuan hanya muncul jika Tanpa batas tidak dicentang.',
        th: 'ฟอร์มเพิ่ม / แก้ไขบัญชีจัดเป็นส่วนที่ชัดเจนแล้ว ได้แก่ โปรไฟล์ การเข้าสู่ระบบ บทบาทและสิทธิ์ การอนุมัติ และข้อมูลธนาคาร พร้อมเมนูด้านข้างสำหรับข้ามไปยังแต่ละส่วน ส่วนหัวแสดงว่ากำลังแก้ไขใคร (ชื่อ ชื่อผู้ใช้ บทบาท และภูมิภาค) ปุ่มบันทึกอยู่ด้านล่างของหน้าต่างตลอดเวลา และช่องจำนวนวงเงินอนุมัติจะแสดงเฉพาะเมื่อไม่ได้ติ๊กไม่จำกัด',
        vi: 'Biểu mẫu thêm / sửa tài khoản được sắp xếp lại thành các phần rõ ràng — Hồ sơ, Đăng nhập, Vai trò & quyền hạn, Phê duyệt và Thông tin ngân hàng — kèm menu bên để chuyển nhanh giữa các phần. Phần đầu hiển thị bạn đang sửa ai (tên, tên đăng nhập, vai trò và khu vực), nút Lưu luôn nằm ở cuối cửa sổ, và ô số tiền hạn mức phê duyệt chỉ hiện khi bỏ chọn Không giới hạn.',
        km: 'ទម្រង់បន្ថែម / កែគណនីត្រូវបានរៀបចំឡើងវិញជាផ្នែកច្បាស់លាស់ — ប្រវត្តិរូប ការចូលប្រើ តួនាទី និងសិទ្ធិ ការអនុម័ត និងព័ត៌មានធនាគារ — ដោយមានម៉ឺនុយចំហៀងសម្រាប់លោតទៅផ្នែកនីមួយៗ។ ផ្នែកខាងលើបង្ហាញអ្នកដែលអ្នកកំពុងកែ (ឈ្មោះ ឈ្មោះអ្នកប្រើ តួនាទី និងតំបន់) ប៊ូតុងរក្សាទុកនៅខាងក្រោមបង្អួចជានិច្ច ហើយប្រអប់ចំនួនដែនកំណត់អនុម័តបង្ហាញតែពេលមិនបានធីក គ្មានដែនកំណត់។',
        fil: 'Inayos na sa malinaw na mga seksyon ang form ng pagdagdag / pag-edit ng account — Profile, Pag-sign in, Role at access, Mga pag-apruba at Detalye ng bangko — na may side menu para lumipat sa bawat isa. Ipinapakita ng header kung sino ang ine-edit mo (pangalan, username, role at rehiyon), laging nasa ibaba ng window ang Save, at lumalabas lang ang halaga ng approval limit kapag hindi naka-tsek ang Unlimited.'
      }, audience: ['settings', 'accounts'] }
    ]
  },
  {
    id: '2026-10-09.4',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'Settings has a cleaner layout: pages are grouped in a side menu (People, Organisation, Claims, Region), and each page opens with a short note on what it controls and its main button at the top. Departments, job positions and expense types show a Disabled tag and keep Rename, Disable and Delete in a ⋯ menu; Accounts can be filtered by All, Active or Disabled; and the currency, claim window and meal allowance forms sit in tidy cards with Save at the bottom.',
        id: 'Pengaturan kini lebih rapi: halaman dikelompokkan dalam menu samping (Orang, Organisasi, Klaim, Wilayah), dan setiap halaman dibuka dengan catatan singkat tentang apa yang diaturnya serta tombol utamanya di bagian atas. Departemen, posisi jabatan, dan jenis pengeluaran menampilkan label Nonaktif dan menyimpan Ganti nama, Nonaktifkan, dan Hapus dalam menu ⋯; Akun dapat difilter menurut Semua, Aktif, atau Nonaktif; dan formulir mata uang, batas waktu klaim, serta tunjangan makan tersusun dalam kartu yang rapi dengan tombol Simpan di bawah.',
        th: 'การตั้งค่ามีหน้าตาเป็นระเบียบขึ้น: หน้าต่างๆ ถูกจัดกลุ่มในเมนูด้านข้าง (บุคคล องค์กร การเบิก ภูมิภาค) และแต่ละหน้าจะมีคำอธิบายสั้นๆ ว่าควบคุมอะไร พร้อมปุ่มหลักอยู่ด้านบน แผนก ตำแหน่งงาน และประเภทค่าใช้จ่ายจะแสดงป้ายปิดใช้งาน และย้ายเปลี่ยนชื่อ ปิดใช้งาน และลบ ไปไว้ในเมนู ⋯ บัญชีกรองได้ตามทั้งหมด ใช้งาน หรือปิดใช้งาน และฟอร์มสกุลเงิน ช่วงเวลาการเบิก และเบี้ยเลี้ยงค่าอาหาร อยู่ในการ์ดที่เป็นระเบียบพร้อมปุ่มบันทึกด้านล่าง',
        vi: 'Cài đặt có bố cục gọn gàng hơn: các trang được nhóm trong menu bên (Con người, Tổ chức, Yêu cầu, Khu vực), và mỗi trang mở đầu bằng ghi chú ngắn về nội dung nó kiểm soát cùng nút chính ở phía trên. Phòng ban, vị trí công việc và loại chi phí hiển thị nhãn Vô hiệu hóa và gom Đổi tên, Vô hiệu hóa, Xóa vào menu ⋯; Tài khoản có thể lọc theo Tất cả, Đang hoạt động hoặc Bị vô hiệu hóa; và các biểu mẫu tiền tệ, kỳ yêu cầu và phụ cấp ăn được đặt trong thẻ gọn gàng với nút Lưu ở cuối.',
        km: 'ការកំណត់មានប្លង់ស្អាតជាងមុន៖ ទំព័រត្រូវបានដាក់ជាក្រុមក្នុងម៉ឺនុយចំហៀង (មនុស្ស អង្គភាព សំណើ តំបន់) ហើយទំព័រនីមួយៗបើកដោយកំណត់ចំណាំខ្លីអំពីអ្វីដែលវាគ្រប់គ្រង និងប៊ូតុងសំខាន់នៅខាងលើ។ នាយកដ្ឋាន តំណែងការងារ និងប្រភេទការចំណាយបង្ហាញស្លាកបានបិទ ហើយដាក់ ប្តូរឈ្មោះ បិទ និងលុប ក្នុងម៉ឺនុយ ⋯; គណនីអាចត្រងតាម ទាំងអស់ សកម្ម ឬបានបិទ; ហើយទម្រង់រូបិយប័ណ្ណ រយៈពេលស្នើសុំ និងប្រាក់ឧបត្ថម្ភអាហារ ស្ថិតក្នុងកាតដែលមានសណ្តាប់ធ្នាប់ ដោយមានប៊ូតុងរក្សាទុកនៅខាងក្រោម។',
        fil: 'Mas maayos na ang layout ng Settings: nakagrupo ang mga pahina sa side menu (Mga tao, Organisasyon, Claims, Rehiyon), at bawat pahina ay nagsisimula sa maikling paliwanag kung ano ang kinokontrol nito at ang pangunahing button nito sa itaas. Ang mga departamento, posisyon sa trabaho at uri ng gastos ay may Disabled na tag at nasa ⋯ na menu na ang Palitan ang pangalan, I-disable at Burahin; maaaring i-filter ang Accounts ayon sa Lahat, Aktibo o Naka-disable; at nasa maayos na card na ang mga form ng currency, claim window at meal allowance na may Save sa ibaba.'
      }, audience: ['settings', 'accounts'] }
    ]
  },
  {
    id: '2026-10-09.3',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'The Regions screen in Settings is now a single tidy list: each region shows how many accounts and open documents it has, with Open settings to go in and a ⋯ menu to rename, disable or delete it. Disabled regions are grouped separately, and you are warned before disabling or deleting a region that still has accounts or open documents.',
        id: 'Layar Wilayah di Pengaturan kini menjadi satu daftar yang rapi: setiap wilayah menampilkan jumlah akun dan dokumen terbukanya, dengan tombol Buka pengaturan untuk masuk dan menu ⋯ untuk mengganti nama, menonaktifkan, atau menghapusnya. Wilayah nonaktif dikelompokkan tersendiri, dan Anda diperingatkan sebelum menonaktifkan atau menghapus wilayah yang masih memiliki akun atau dokumen terbuka.',
        th: 'หน้าภูมิภาคในการตั้งค่าเป็นรายการเดียวที่เป็นระเบียบแล้ว แต่ละภูมิภาคแสดงจำนวนบัญชีและเอกสารที่ยังค้าง พร้อมปุ่มเปิดการตั้งค่าเพื่อเข้าไป และเมนู ⋯ สำหรับเปลี่ยนชื่อ ปิดใช้งาน หรือลบ ภูมิภาคที่ปิดใช้งานจะแยกกลุ่มไว้ และระบบจะเตือนก่อนปิดใช้งานหรือลบภูมิภาคที่ยังมีบัญชีหรือเอกสารค้างอยู่',
        vi: 'Màn hình Khu vực trong Cài đặt giờ là một danh sách gọn gàng: mỗi khu vực hiển thị số tài khoản và hồ sơ đang mở, kèm nút Mở cài đặt để vào và menu ⋯ để đổi tên, vô hiệu hóa hoặc xóa. Các khu vực bị vô hiệu hóa được nhóm riêng, và bạn sẽ được cảnh báo trước khi vô hiệu hóa hoặc xóa khu vực vẫn còn tài khoản hoặc hồ sơ đang mở.',
        km: 'អេក្រង់តំបន់ក្នុងការកំណត់ឥឡូវជាបញ្ជីតែមួយយ៉ាងមានសណ្តាប់ធ្នាប់៖ តំបន់នីមួយៗបង្ហាញចំនួនគណនី និងឯកសារកំពុងបើក ដោយមានប៊ូតុង បើកការកំណត់ ដើម្បីចូល និងម៉ឺនុយ ⋯ ដើម្បីប្តូរឈ្មោះ បិទ ឬលុបវា។ តំបន់ដែលបានបិទត្រូវបានដាក់ជាក្រុមដាច់ដោយឡែក ហើយអ្នកនឹងទទួលការព្រមានមុនពេលបិទ ឬលុបតំបន់ដែលនៅមានគណនី ឬឯកសារកំពុងបើក។',
        fil: 'Iisang maayos na listahan na ang Regions screen sa Settings: ipinapakita ng bawat rehiyon kung ilan ang account at bukas na dokumento nito, may Buksan ang settings para pumasok at ⋯ na menu para palitan ang pangalan, i-disable o burahin ito. Hiwalay na nakagrupo ang mga naka-disable na rehiyon, at binabalaan ka bago i-disable o burahin ang rehiyong may account o bukas na dokumento pa.'
      }, audience: ['superadmin'] }
    ]
  },
  {
    id: '2026-10-09.2',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'In Export claims to CSV, statuses and claim types are now tidy one-per-line lists, each with a Select all / Clear button to tick or untick the whole group in one click.',
        id: 'Di Ekspor klaim ke CSV, status dan jenis klaim kini tersusun rapi satu per baris, masing-masing dengan tombol Pilih semua / Bersihkan untuk mencentang atau menghapus centang seluruh grup sekali klik.',
        th: 'ในหน้าส่งออกรายการเบิกเป็น CSV สถานะและประเภทการเบิกแสดงเป็นรายการบรรทัดละหนึ่งตัวเลือกอย่างเป็นระเบียบ พร้อมปุ่มเลือกทั้งหมด / ล้าง เพื่อติ๊กหรือยกเลิกทั้งกลุ่มในคลิกเดียว',
        vi: 'Trong Xuất yêu cầu ra CSV, trạng thái và loại yêu cầu giờ được sắp gọn mỗi dòng một mục, kèm nút Chọn tất cả / Xóa để chọn hoặc bỏ chọn cả nhóm chỉ với một lần bấm.',
        km: 'នៅក្នុងការនាំចេញសំណើទៅ CSV ស្ថានភាព និងប្រភេទសំណើឥឡូវត្រូវបានរៀបជាបញ្ជីមួយបន្ទាត់មួយយ៉ាងមានសណ្តាប់ធ្នាប់ ដោយម្នាក់ៗមានប៊ូតុង ជ្រើសទាំងអស់ / សម្អាត ដើម្បីធីក ឬដកធីកក្រុមទាំងមូលដោយចុចតែម្តង។',
        fil: 'Sa Export claims to CSV, maayos nang nakalista nang isa bawat linya ang mga status at uri ng claim, bawat isa ay may Piliin lahat / I-clear na button para lagyan o alisan ng tsek ang buong grupo sa isang click.'
      }, audience: ['export'] }
    ]
  },
  {
    id: '2026-10-09.1',
    date: '2026-10-09',
    items: [
      { kind: 'improved', text: {
        en: 'When a claim has just one photo receipt, the downloaded PDF now shows it at the same size as when there are two, centred on its page, instead of stretching it to fill the whole page.',
        id: 'Jika klaim hanya memiliki satu foto struk, PDF yang diunduh kini menampilkannya dengan ukuran yang sama seperti saat ada dua struk, di tengah halaman, alih-alih membentangkannya memenuhi seluruh halaman.',
        th: 'เมื่อรายการเบิกมีรูปใบเสร็จเพียงรูปเดียว PDF ที่ดาวน์โหลดจะแสดงรูปนั้นในขนาดเดียวกับเมื่อมีสองรูป โดยอยู่กึ่งกลางหน้า แทนที่จะขยายเต็มทั้งหน้า',
        vi: 'Khi một yêu cầu chỉ có một ảnh biên lai, tệp PDF tải xuống giờ hiển thị ảnh với kích thước giống như khi có hai ảnh, căn giữa trang, thay vì phóng to chiếm trọn cả trang.',
        km: 'នៅពេលសំណើមានរូបថតបង្កាន់ដៃតែមួយ PDF ដែលបានទាញយកឥឡូវបង្ហាញវាក្នុងទំហំដូចពេលមានពីរ នៅកណ្ដាលទំព័រ ជំនួសឱ្យការពង្រីកវាពេញទំព័រទាំងមូល។',
        fil: 'Kapag iisa lang ang larawan ng resibo sa isang claim, ipinapakita na ito ng na-download na PDF sa parehong laki gaya ng kapag dalawa, nakagitna sa pahina, sa halip na i-stretch ito sa buong pahina.'
      } }
    ]
  },
  {
    id: '2026-10-07.1',
    date: '2026-10-07',
    items: [
      { kind: 'fixed', text: {
        en: 'Large receipts (such as long scanned PDFs) now open and download reliably, and a downloaded receipt keeps its real file name instead of one full of %20s.',
        id: 'Struk berukuran besar (seperti PDF hasil pindai yang panjang) kini terbuka dan terunduh dengan andal, dan struk yang diunduh mempertahankan nama file aslinya, bukan nama yang penuh %20.',
        th: 'ใบเสร็จขนาดใหญ่ (เช่น PDF สแกนหลายหน้า) เปิดและดาวน์โหลดได้อย่างเสถียรแล้ว และใบเสร็จที่ดาวน์โหลดจะใช้ชื่อไฟล์จริง ไม่ใช่ชื่อที่เต็มไปด้วย %20',
        vi: 'Biên lai dung lượng lớn (như tệp PDF quét nhiều trang) giờ mở và tải xuống ổn định, và biên lai tải xuống giữ đúng tên tệp gốc thay vì tên đầy ký tự %20.',
        km: 'បង្កាន់ដៃទំហំធំ (ដូចជា PDF ស្កេនវែងៗ) ឥឡូវបើក និងទាញយកបានយ៉ាងជឿជាក់ ហើយបង្កាន់ដៃដែលបានទាញយករក្សាឈ្មោះឯកសារពិតរបស់វា ជំនួសឱ្យឈ្មោះដែលពេញដោយ %20។',
        fil: 'Maaasahan nang nabubuksan at nada-download ang malalaking resibo (gaya ng mahahabang na-scan na PDF), at pinananatili ng na-download na resibo ang tunay nitong pangalan ng file sa halip na pangalang puno ng %20.'
      } },
      { kind: 'fixed', text: {
        en: 'When two people act on the same claim at once — or a button is clicked twice — the second action is now stopped with a message to reload, instead of overwriting the first (for example, approving a claim someone had just rejected, or recording a payment twice).',
        id: 'Ketika dua orang bertindak pada klaim yang sama secara bersamaan — atau tombol diklik dua kali — tindakan kedua kini dihentikan dengan pesan untuk memuat ulang, alih-alih menimpa tindakan pertama (misalnya menyetujui klaim yang baru saja ditolak orang lain, atau mencatat pembayaran dua kali).',
        th: 'เมื่อมีสองคนดำเนินการกับคำขอเบิกเดียวกันพร้อมกัน หรือมีการกดปุ่มซ้ำสองครั้ง การดำเนินการครั้งที่สองจะถูกหยุดพร้อมข้อความให้โหลดใหม่ แทนที่จะเขียนทับครั้งแรก (เช่น อนุมัติคำขอที่อีกคนเพิ่งปฏิเสธ หรือบันทึกการจ่ายเงินซ้ำสองครั้ง)',
        vi: 'Khi hai người cùng thao tác trên một yêu cầu cùng lúc — hoặc một nút bị bấm hai lần — thao tác thứ hai giờ sẽ bị dừng kèm thông báo tải lại, thay vì ghi đè thao tác đầu tiên (ví dụ: phê duyệt yêu cầu mà người khác vừa từ chối, hoặc ghi nhận thanh toán hai lần).',
        km: 'នៅពេលមនុស្សពីរនាក់ធ្វើសកម្មភាពលើការទាមទារតែមួយក្នុងពេលតែមួយ — ឬប៊ូតុងត្រូវបានចុចពីរដង — សកម្មភាពទីពីរឥឡូវត្រូវបានបញ្ឈប់ ដោយមានសារឱ្យផ្ទុកឡើងវិញ ជំនួសឱ្យការសរសេរជាន់លើសកម្មភាពទីមួយ (ឧទាហរណ៍ ការអនុម័តការទាមទារដែលអ្នកផ្សេងទើបតែបដិសេធ ឬការកត់ត្រាការទូទាត់ពីរដង)។',
        fil: 'Kapag sabay na kumilos ang dalawang tao sa iisang claim — o dalawang beses na na-click ang isang button — pinahihinto na ngayon ang ikalawang aksyon na may mensaheng mag-reload, sa halip na patungan ang una (halimbawa, pag-apruba ng claim na kaka-reject lang ng iba, o dalawang beses na pagtatala ng bayad).'
      } }
    ]
  },
  {
    id: '2026-10-05.2',
    date: '2026-10-05',
    items: [
      { kind: 'new', text: {
        en: 'A new Modern look: softer rounded cards, filled fields, a frosted top bar and navy accents. Choose it under Profile → Appearance; it works in both light and dark mode, and Classic stays the default. Your choice is remembered on each device.',
        id: 'Tampilan Modern baru: kartu membulat yang lebih lembut, kolom isian berlatar, bilah atas buram, dan aksen biru navy. Pilih di Profil → Tampilan; berfungsi di mode terang maupun gelap, dan Klasik tetap menjadi bawaan. Pilihan Anda diingat di setiap perangkat.',
        th: 'รูปลักษณ์ Modern ใหม่: การ์ดขอบมนที่นุ่มนวลขึ้น ช่องกรอกแบบมีพื้น แถบด้านบนแบบฝ้า และสีเน้นสีน้ำเงินกรมท่า เลือกได้ที่ โปรไฟล์ → รูปลักษณ์ ใช้ได้ทั้งโหมดสว่างและโหมดมืด โดยคลาสสิกยังเป็นค่าเริ่มต้น ระบบจะจำตัวเลือกของคุณไว้ในแต่ละอุปกรณ์',
        vi: 'Giao diện Hiện đại mới: thẻ bo tròn mềm mại hơn, ô nhập có nền, thanh trên cùng hiệu ứng kính mờ và điểm nhấn màu xanh navy. Chọn tại Hồ sơ → Giao diện; dùng được ở cả chế độ sáng và tối, và Cổ điển vẫn là mặc định. Lựa chọn của bạn được ghi nhớ trên từng thiết bị.',
        km: 'រូបរាងទំនើបថ្មី៖ កាតជ្រុងមូលទន់ជាងមុន ប្រអប់បញ្ចូលមានផ្ទៃ របារខាងលើបែបកញ្ចក់ព្រិល និងពណ៌សង្កត់ពណ៌ខៀវចាស់។ ជ្រើសរើសវានៅ ប្រវត្តិរូប → រូបរាង; វាដំណើរការទាំងរបៀបភ្លឺ និងងងឹត ហើយបុរាណនៅតែជាលំនាំដើម។ ជម្រើសរបស់អ្នកត្រូវបានចងចាំនៅលើឧបករណ៍នីមួយៗ។',
        fil: 'Bagong Moderno na itsura: mas malalambot na bilugang card, may-kulay na mga field, malabong-salamin na top bar, at navy blue na accent. Piliin ito sa Profile → Itsura; gumagana sa light at dark mode, at Classic pa rin ang default. Tatandaan ang pinili mo sa bawat device.'
      } }
    ]
  },
  {
    id: '2026-10-05.1',
    date: '2026-10-05',
    items: [
      { kind: 'improved', text: {
        en: 'The portal now moves more smoothly: screens and lists ease in, claim details and windows slide or fade away when closed, and switching between light and dark mode spreads out from the button. If your device is set to reduce motion, all of this stays off.',
        id: 'Portal kini bergerak lebih halus: layar dan daftar muncul perlahan, detail klaim dan jendela bergeser atau memudar saat ditutup, dan pergantian mode terang/gelap menyebar dari tombolnya. Jika perangkat Anda diatur untuk mengurangi gerakan, semua ini tetap nonaktif.',
        th: 'พอร์ทัลเคลื่อนไหวได้ลื่นไหลขึ้น: หน้าจอและรายการค่อย ๆ ปรากฏ รายละเอียดคำขอเบิกและหน้าต่างจะเลื่อนหรือจางหายเมื่อปิด และการสลับโหมดสว่าง/มืดจะแผ่ออกจากปุ่ม หากอุปกรณ์ของคุณตั้งค่าให้ลดการเคลื่อนไหว เอฟเฟกต์ทั้งหมดนี้จะปิดอยู่',
        vi: 'Cổng thông tin giờ chuyển động mượt mà hơn: màn hình và danh sách hiện ra nhẹ nhàng, chi tiết yêu cầu và cửa sổ trượt hoặc mờ dần khi đóng, và việc chuyển chế độ sáng/tối lan ra từ nút bấm. Nếu thiết bị của bạn được đặt giảm chuyển động, tất cả hiệu ứng này sẽ tắt.',
        km: 'វិបផតថលឥឡូវមានចលនារលូនជាងមុន៖ អេក្រង់ និងបញ្ជីលេចឡើងបន្តិចម្ដងៗ ព័ត៌មានលម្អិតនៃការទាមទារ និងផ្ទាំងរអិល ឬរសាត់បាត់ពេលបិទ ហើយការប្ដូររវាងរបៀបភ្លឺ និងងងឹតរីករាលចេញពីប៊ូតុង។ ប្រសិនបើឧបករណ៍របស់អ្នកកំណត់ឱ្យកាត់បន្ថយចលនា ចលនាទាំងនេះនឹងនៅបិទ។',
        fil: 'Mas maayos na ang galaw ng portal: dahan-dahang lumalabas ang mga screen at listahan, dumudulas o naglalaho ang detalye ng claim at mga window kapag isinara, at kumakalat mula sa button ang paglipat sa light at dark mode. Kung naka-set ang iyong device na bawasan ang motion, mananatiling naka-off ang lahat ng ito.'
      } }
    ]
  },
  {
    id: '2026-10-04.1',
    date: '2026-10-04',
    items: [
      { kind: 'improved', text: {
        en: 'Changing your password now signs you out on your other devices, so an old sign-in (on a shared computer, say) can no longer be used. You stay signed in where you made the change. A password reset by an administrator or a reset link signs the account out everywhere.',
        id: 'Mengganti kata sandi kini mengeluarkan Anda dari perangkat lain, sehingga sesi lama (misalnya di komputer bersama) tidak bisa dipakai lagi. Anda tetap masuk di perangkat tempat Anda menggantinya. Reset kata sandi oleh administrator atau lewat tautan reset mengeluarkan akun dari semua perangkat.',
        th: 'การเปลี่ยนรหัสผ่านจะออกจากระบบบนอุปกรณ์อื่นของคุณ ทำให้การเข้าสู่ระบบเดิม (เช่น บนคอมพิวเตอร์ที่ใช้ร่วมกัน) ใช้ไม่ได้อีกต่อไป คุณยังคงอยู่ในระบบบนอุปกรณ์ที่ใช้เปลี่ยนรหัสผ่าน การรีเซ็ตรหัสผ่านโดยผู้ดูแลระบบหรือผ่านลิงก์รีเซ็ตจะออกจากระบบบัญชีนั้นบนทุกอุปกรณ์',
        vi: 'Đổi mật khẩu giờ sẽ đăng xuất bạn trên các thiết bị khác, nên phiên đăng nhập cũ (ví dụ trên máy tính dùng chung) không thể dùng được nữa. Bạn vẫn đăng nhập trên thiết bị đã đổi mật khẩu. Khi quản trị viên đặt lại mật khẩu hoặc dùng liên kết đặt lại, tài khoản sẽ bị đăng xuất ở mọi nơi.',
        km: 'ការប្ដូរពាក្យសម្ងាត់ ឥឡូវនឹងចាកចេញពីឧបករណ៍ផ្សេងទៀតរបស់អ្នក ដូច្នេះការចូលចាស់ (ឧ. នៅលើកុំព្យូទ័រប្រើរួម) មិនអាចប្រើបានទៀតទេ។ អ្នកនៅតែចូលនៅលើឧបករណ៍ដែលអ្នកប្ដូរ។ ការកំណត់ពាក្យសម្ងាត់ឡើងវិញដោយអ្នកគ្រប់គ្រង ឬតាមតំណកំណត់ឡើងវិញ នឹងចាកចេញគណនីនោះពីគ្រប់ទីកន្លែង។',
        fil: 'Kapag pinalitan mo ang password, masa-sign out ka na sa iba mo pang device, kaya hindi na magagamit ang lumang sign-in (halimbawa, sa shared na computer). Mananatili kang naka-sign in kung saan mo ito pinalitan. Ang pag-reset ng password ng administrator o sa pamamagitan ng reset link ay magsa-sign out sa account kahit saan.'
      } }
    ]
  },
  {
    id: '2026-10-03.1',
    date: '2026-10-03',
    items: [
      { kind: 'new', text: {
        en: 'The portal can now be installed as an app on your phone or computer. In Chrome, open the menu and choose "Install app" (or "Add to Home screen"); on iPhone, use Share → "Add to Home Screen". It opens full-screen with its own icon.',
        id: 'Portal kini dapat dipasang sebagai aplikasi di ponsel atau komputer Anda. Di Chrome, buka menu dan pilih "Instal aplikasi" (atau "Tambahkan ke layar utama"); di iPhone, gunakan Bagikan → "Tambah ke Layar Utama". Aplikasi terbuka layar penuh dengan ikonnya sendiri.',
        th: 'ตอนนี้ติดตั้งพอร์ทัลเป็นแอปบนโทรศัพท์หรือคอมพิวเตอร์ได้แล้ว ใน Chrome ให้เปิดเมนูแล้วเลือก "ติดตั้งแอป" (หรือ "เพิ่มลงในหน้าจอหลัก") บน iPhone ให้ใช้ แชร์ → "เพิ่มไปยังหน้าจอโฮม" แอปจะเปิดแบบเต็มหน้าจอพร้อมไอคอนของตัวเอง',
        vi: 'Giờ đây bạn có thể cài đặt cổng thông tin như một ứng dụng trên điện thoại hoặc máy tính. Trong Chrome, mở menu và chọn "Cài đặt ứng dụng" (hoặc "Thêm vào màn hình chính"); trên iPhone, dùng Chia sẻ → "Thêm vào MH chính". Ứng dụng mở toàn màn hình với biểu tượng riêng.',
        km: 'ឥឡូវនេះ វិបផតថលអាចដំឡើងជាកម្មវិធីនៅលើទូរស័ព្ទ ឬកុំព្យូទ័ររបស់អ្នក។ នៅក្នុង Chrome សូមបើកម៉ឺនុយ ហើយជ្រើស "ដំឡើងកម្មវិធី" (ឬ "បញ្ចូលទៅអេក្រង់ដើម"); នៅលើ iPhone សូមប្រើ ចែករំលែក → "Add to Home Screen"។ វាបើកពេញអេក្រង់ជាមួយរូបតំណាងផ្ទាល់ខ្លួន។',
        fil: 'Maaari mo nang i-install ang portal bilang app sa iyong telepono o computer. Sa Chrome, buksan ang menu at piliin ang "I-install ang app" (o "Idagdag sa Home screen"); sa iPhone, gamitin ang Share → "Add to Home Screen". Bubukas ito nang full-screen na may sariling icon.'
      } },
      { kind: 'new', text: {
        en: 'On iPhone and iPad, a small card at the bottom of the screen now shows how to install the app. Close it with × and it won\'t appear again on that device.',
        id: 'Di iPhone dan iPad, kartu kecil di bagian bawah layar kini menunjukkan cara memasang aplikasi. Tutup dengan × dan kartu tidak akan muncul lagi di perangkat itu.',
        th: 'บน iPhone และ iPad จะมีการ์ดเล็ก ๆ ที่ด้านล่างของหน้าจอแสดงวิธีติดตั้งแอป ปิดด้วย × แล้วจะไม่แสดงอีกบนอุปกรณ์นั้น',
        vi: 'Trên iPhone và iPad, một thẻ nhỏ ở cuối màn hình giờ hướng dẫn cách cài ứng dụng. Đóng bằng × và thẻ sẽ không hiện lại trên thiết bị đó.',
        km: 'នៅលើ iPhone និង iPad កាតតូចមួយនៅខាងក្រោមអេក្រង់ឥឡូវបង្ហាញពីរបៀបដំឡើងកម្មវិធី។ បិទវាដោយ × ហើយវានឹងមិនបង្ហាញម្តងទៀតនៅលើឧបករណ៍នោះទេ។',
        fil: 'Sa iPhone at iPad, may maliit na card sa ibaba ng screen na nagpapakita kung paano i-install ang app. Isara ito gamit ang × at hindi na ito lalabas muli sa device na iyon.'
      } }
    ]
  },
  {
    id: '2026-10-02.4',
    date: '2026-10-02',
    items: [
      { kind: 'fixed', audience: ['accounts', 'settings'], text: {
        en: 'An approval limit that isn\'t a valid amount (for example a typo with letters) is now refused with a message, instead of being saved as 0, which stopped that account from approving anything.',
        id: 'Batas persetujuan yang bukan jumlah yang valid (misalnya salah ketik berisi huruf) kini ditolak dengan pesan, bukan disimpan sebagai 0 yang membuat akun tersebut tidak bisa menyetujui apa pun.',
        th: 'วงเงินอนุมัติที่ไม่ใช่จำนวนเงินที่ถูกต้อง (เช่น พิมพ์ผิดเป็นตัวอักษร) จะถูกปฏิเสธพร้อมข้อความแจ้ง แทนที่จะถูกบันทึกเป็น 0 ซึ่งทำให้บัญชีนั้นอนุมัติอะไรไม่ได้เลย',
        vi: 'Hạn mức phê duyệt không phải là số tiền hợp lệ (ví dụ gõ nhầm có chữ cái) giờ sẽ bị từ chối kèm thông báo, thay vì được lưu thành 0 khiến tài khoản đó không thể phê duyệt gì.',
        km: 'ដែនកំណត់អនុម័តដែលមិនមែនជាចំនួនទឹកប្រាក់ត្រឹមត្រូវ (ឧទាហរណ៍ វាយខុសជាអក្សរ) ឥឡូវត្រូវបានបដិសេធជាមួយសារ ជំនួសឱ្យការរក្សាទុកជា 0 ដែលធ្វើឱ្យគណនីនោះមិនអាចអនុម័តអ្វីបាន។',
        fil: 'Ang approval limit na hindi wastong halaga (halimbawa, typo na may mga letra) ay tinatanggihan na ngayon na may mensahe, sa halip na ma-save bilang 0 na pumipigil sa account na mag-apruba ng kahit ano.'
      } }
    ]
  },
  {
    id: '2026-10-02.3',
    date: '2026-10-02',
    items: [
      { kind: 'improved', text: {
        en: 'Claim lists now show everything still open plus anything active in the last 90 days, so they stay quick as history grows. Use "Show all history" under the filters to see older claims. Searching, or picking an older payment date, always looks through all history.',
        id: 'Daftar klaim kini menampilkan semua yang masih terbuka ditambah semua aktivitas dalam 90 hari terakhir, sehingga tetap cepat meski riwayat terus bertambah. Gunakan "Tampilkan semua riwayat" di bawah filter untuk melihat klaim lama. Pencarian, atau memilih tanggal pembayaran yang lebih lama, selalu mencari di seluruh riwayat.',
        th: 'รายการคำขอเบิกจะแสดงทุกรายการที่ยังดำเนินการอยู่ และรายการที่มีความเคลื่อนไหวใน 90 วันที่ผ่านมา เพื่อให้โหลดได้รวดเร็วแม้ประวัติจะเพิ่มขึ้น ใช้ "แสดงประวัติทั้งหมด" ใต้ตัวกรองเพื่อดูรายการเก่า การค้นหาหรือการเลือกวันที่ชำระเงินที่เก่ากว่าจะค้นจากประวัติทั้งหมดเสมอ',
        vi: 'Danh sách yêu cầu giờ hiển thị mọi mục còn mở cùng các mục có hoạt động trong 90 ngày qua, nên vẫn tải nhanh khi lịch sử ngày càng nhiều. Dùng "Hiển thị toàn bộ lịch sử" bên dưới bộ lọc để xem các yêu cầu cũ hơn. Khi tìm kiếm hoặc chọn ngày thanh toán cũ hơn, hệ thống luôn tìm trong toàn bộ lịch sử.',
        km: 'បញ្ជីសំណើឥឡូវបង្ហាញអ្វីៗដែលនៅបើក និងអ្វីៗដែលមានសកម្មភាពក្នុងរយៈពេល ៩០ ថ្ងៃចុងក្រោយ ដូច្នេះវានៅតែលឿន ទោះប្រវត្តិកើនឡើង។ ប្រើ "បង្ហាញប្រវត្តិទាំងអស់" នៅក្រោមតម្រង ដើម្បីមើលសំណើចាស់ៗ។ ការស្វែងរក ឬការជ្រើសកាលបរិច្ឆេទទូទាត់ចាស់ជាងនេះ តែងតែស្វែងរកក្នុងប្រវត្តិទាំងអស់។',
        fil: 'Ipinapakita na ngayon ng mga listahan ng claim ang lahat ng bukas pa at lahat ng may aktibidad sa nakaraang 90 araw, kaya nananatiling mabilis kahit dumarami ang kasaysayan. Gamitin ang "Ipakita ang buong kasaysayan" sa ilalim ng mga filter para makita ang mas lumang claim. Ang paghahanap, o pagpili ng mas lumang petsa ng bayad, ay laging naghahanap sa buong kasaysayan.'
      } }
    ]
  },
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
