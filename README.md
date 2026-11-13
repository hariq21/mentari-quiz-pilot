# Mentari Quiz Pilot

Extension Chrome MV3 untuk membantu menguji alur kuis Mentari: membaca soal dan pilihan radio, meminta analisis ke DeepSeek Flash, memilih opsi, lalu menekan `Next`.

Model API dikunci ke `deepseek-flash` (DeepSeek V4.1 Flash), bukan `deepseek-v4-pro`. Request memakai non-thinking mode agar cepat, timeout API 90 detik, output dibatasi 200 token per soal, dan respons kosong dicoba ulang sekali untuk mengendalikan biaya serta mengurangi kegagalan sementara.

## Instalasi

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode**.
3. Klik **Load unpacked** dan pilih folder ini.
4. Buka halaman kuis Mentari; extension dapat menyuntikkan script ke tab aktif saat tombol ditekan.
5. Klik icon extension, isi API key DeepSeek, lalu klik **Mulai automasi**.

## Catatan penting

- API key disimpan di `chrome.storage.local` dan dipakai oleh service worker; jangan commit atau bagikan key tersebut.
- Deteksi soal tidak bergantung pada teks nomor seperti `Soal 2` atau `Soal 5`; nomor hanya dipakai sebagai label notifikasi jika tersedia.
- Selector utama mengikuti dua contoh HTML: blok `.ck-content`, `label` berisi radio button, tombol `Next`, dan tombol `Selesai Quiz`.
- Opsi **Kirim soal terakhir otomatis** sengaja mati secara default. Jika aktif, extension menekan `Selesai Quiz` lalu `Ya` pada popup konfirmasi.
- Status runner otomatis berhenti setelah selesai, dihentikan, atau error.
- Tombol automasi hanya memakai **Mulai automasi** dan **Stop**; konteks PKKMB diatur terpisah lewat toggle **Aturan PKKMB**.
- Notifikasi kecil muncul di halaman setiap opsi dipilih.
- Jeda setelah memilih jawaban dapat diatur dalam satuan detik, default 3 detik.
- Jika quiz belum dimulai, extension otomatis menekan `Mulai Quiz`, memilih `Ya` pada dialog konfirmasi, lalu menunggu soal pertama.
- Aturan khusus PKKMB UNPAM dimasukkan ke prompt. Penghentian saat confidence di bawah 65% bisa diaktifkan dari panel; jika mati, opsi terbaik tetap dipilih dan confidence ditampilkan.
- Gunakan hanya pada kuis yang kamu punya izin untuk otomatisasi. Extension ini tidak menangani CAPTCHA atau mekanisme anti-bot.

## Mode Kerjakan Pretest/Posttest

Tombol **Kerjakan Pretest/Posttest** berjalan otomatis dari halaman Mentari yang terbuka:

1. Membuka tiap matkul dari daftar Courses List.
2. Membuka tiap pertemuan (dropdown accordion) sampai batas pertemuan yang diisi di panel.
3. Untuk tiap Pretest/Posttest yang belum selesai, menekan tombol **Quiz** di dalam pembungkus aktivitas.
4. Menunggu tombol **Kerjakan Quiz** muncul lalu menekannya.
5. Menjalankan mekanisme jawab otomatis seperti mode quiz (termasuk menekan **Mulai Quiz** jika perlu).
6. Soal terakhir otomatis menekan **Selesai Quiz**, mengonfirmasi **Ya**, lalu kembali ke halaman Mentari untuk melanjutkan ke matkul berikutnya.

Aktivitas yang sudah bertanda selesai (`CheckCircleIcon`) atau “No content” dilewati. Proses berhenti jika tombol **Kerjakan Quiz** tidak muncul agar bisa dicek manual.

Aturan tambahan: jika pada pekan yang sama ada **Forum** yang belum dikerjakan, **Posttest pekan itu dilewati** (lanjut ke pekan/matkul berikutnya). Pretest tetap dikerjakan seperti biasa. Setelah konfirmasi **Ya** pada Selesai Quiz, extension menunggu 3 detik lalu kembali ke daftar matkul.

Mulai sebaiknya dari halaman daftar matkul (Courses List) agar semua matkul terdaftar. Progres disimpan di `chrome.storage.local`, jadi jika halaman berpindah/reload setelah submit, automasi otomatis lanjut dari matkul/pekan berikutnya. Tombol **Stop** menonaktifkan antrean supaya tidak lanjut sendiri.

