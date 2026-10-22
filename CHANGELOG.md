# Değişiklikler

## 0.2.0

Gerçek veriyle çalışmadan önce gereken güvenlik ve veri güvenliği düzeltmeleri.

### Davranışı değişenler

- **Migration artık veri silmiyor.** Değeri olan bir alanı kaldıran, yeniden adlandıran ya da iç içe bir anahtarı düşüren şema `MigrationError` ile reddedilir ve veritabanına dokunulmaz. Veriyi bilerek silmek için `--allow-field-removal` (`EngineOptions.allowFieldRemoval`).
- **Şema yoksa başlamaz.** Veritabanında aktif tablolar varken `schema.ts` yüklenmediyse sunucu başlamayı reddeder.
- **`where()` alan adlarını doğrular.** Alan adı ya da noktalı alan yolu olmayan bir anahtar `INVALID_FIELD` hatası verir.
- **`admin_sql` yalnızca tek bir okuma sorgusu çalıştırır** (SELECT, VALUES, WITH, EXPLAIN). `ATTACH`, `PRAGMA` ve birden fazla statement reddedilir; `_incibase_meta`, `_passwords` ve `_sessions` okunamaz. Sorgu ayrı bir process'te, 5 saniyelik süre sınırı ve 1000 satır tavanıyla çalışır.
- **İstek boyutları sınırlı.** JSON route'ları 1 MB (`INCIBASE_MAX_JSON_BYTES`), WebSocket mesajları 1 MB; soket başına abonelik sayısı ve toplam boyutu sınırlı. Yükleme sınırı gerçek akan bayt üzerinden uygulanır.
- **Bir data dir'i aynı anda yalnızca bir process açabilir.** İkinci sunucu açık bir hatayla durur. Data dir `0700`, dosyalar `0600` oluşturulur.

### Düzeltilenler

- Tek bir hatalı WebSocket mesajı (`null`, sayı olan token vb.) artık sunucuyu çökertmiyor.
- Scheduler'daki arka plan hataları ve yakalanmamış promise'ler sunucuyu düşürmüyor; hatalar loglanıp çalışmaya devam ediliyor. Uzun süren bir job diğer job'ları bekletmiyor.
- Şemadan kaldırılan tablolardaki ya da düz `id("_storage")` alanlarındaki dosyalar artık temizlikte silinmiyor; temizlik adayları silme transaction'ı içinde yeniden kontrol ediliyor.
- Üretimde (dev dışı) MCP ve HTTP hataları stack trace ya da iç mesaj sızdırmıyor.

### Yeni

- Admin araçları: `admin_delete_user`, `admin_set_user_disabled`, `admin_revoke_sessions`. Oturumu iptal edilen, devre dışı bırakılan ya da silinen kullanıcıların açık WebSocket bağlantıları anonim kimliğe düşürülür.

## 0.1.0

İlk yayın.
